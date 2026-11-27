package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// marks shows on and off by shape, so the output reads without color.
var marks = map[bool]string{true: "●", false: "○"}

func (a *app) statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "status [AGENT]",
		Short:             "Show the scheduler and the status of every enabled agent, or one agent",
		Args:              optionalAgent,
		ValidArgsFunction: completeIDs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			return a.printStatus(cmd.Context(), cfg, agentsOf(cfg, args))
		},
	}
}

// printStatus prints the scheduler block and one block per agent in ids.
func (a *app) printStatus(ctx context.Context, cfg domain.Config, ids []domain.ProviderID) error {
	now := time.Now()
	st, err := warmup.ReadStatus(ctx, a.paths, cfg)
	if err != nil {
		return err
	}

	var b strings.Builder
	state := "inactive"
	if st.Scheduler.Active {
		state = "ACTIVE"
	}
	fmt.Fprintf(&b, "%s agent-warmup  %s  (%s · %d enabled)\n", marks[st.Scheduler.Active], state, st.Scheduler.Backend, len(cfg.Enabled()))
	if st.NextRun != "" {
		fmt.Fprintf(&b, "  next run   %s\n", st.NextRun)
	}

	for _, id := range ids {
		pc := cfg.Providers[id]
		fmt.Fprintf(&b, "  %s %-9s model=%s  window=%02d–%02dh  stop=%d%%\n", marks[pc.Enabled], id, pc.Model, pc.WorkStart, pc.WorkEnd, pc.WeeklyStopPercent)
		view := a.usageView(cfg, st.Cache, id, now)
		age := ""
		if view.Age != "" {
			age = "   (as of " + view.Age + ")"
		}
		fmt.Fprintf(&b, "              session    %s\n", view.Session)
		fmt.Fprintf(&b, "              weekly     %s%s\n", view.Week, age)
	}

	fmt.Fprintf(&b, "  scheduler  %s\n", schedulerDetail(st.Scheduler))
	if st.LastRun != "" {
		fmt.Fprintf(&b, "  last run   %s\n", lastRunText(st.LastRun))
	}
	fmt.Fprint(a.out, b.String())
	return nil
}

// schedulerDetail is the state of the backend of this OS.
func schedulerDetail(st scheduler.Status) string {
	if st.Backend == scheduler.BackendCron {
		return "cron installed=" + yesNo[st.Cron.Installed]
	}
	l := st.Launchd
	return fmt.Sprintf("launchd installed=%s loaded=%s enabled=%s", yesNo[l.Installed], yesNo[l.Loaded], yesNo[l.Enabled])
}

var yesNo = map[bool]string{true: "yes", false: "no"}

// lastRunText drops the brackets around the log line's time stamp.
func lastRunText(line string) string {
	return strings.Replace(strings.TrimPrefix(line, "["), "]", "", 1)
}

func (a *app) probeContext(cfg domain.Config, id domain.ProviderID, now time.Time) provider.ProbeContext {
	return provider.ProbeContext{ID: id, Cfg: cfg.Providers[id], Now: now, Paths: a.paths}
}

func (a *app) usageView(cfg domain.Config, c domain.Cache, id domain.ProviderID, now time.Time) provider.UsageView {
	return provider.FormatUsage(a.probeContext(cfg, id, now), c.Providers[id])
}

func (a *app) usageCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "usage [AGENT]",
		Short:             "Read the usage of every enabled agent now, or one agent",
		Args:              optionalAgent,
		ValidArgsFunction: completeIDs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			ids := agentsOf(cfg, args)
			texts := make([]string, len(ids))
			errs := make([]error, len(ids))
			var wg sync.WaitGroup
			// Printed before the probes start, which log to the same stream.
			var probing strings.Builder
			for _, id := range ids {
				fmt.Fprintf(&probing, "probing %s (%s)…\n", id, cfg.Providers[id].Model)
			}
			fmt.Fprint(a.errOut, probing.String())
			for i, id := range ids {
				wg.Go(func() { texts[i], errs[i] = a.usage(cmd.Context(), cfg, id) })
			}
			wg.Wait()

			var b strings.Builder
			for i, id := range ids {
				if len(ids) > 1 {
					b.WriteString(string(id) + "\n")
				}
				b.WriteString(texts[i])
			}
			fmt.Fprint(a.out, b.String())
			return errors.Join(errs...)
		},
	}
}

// usage probes id, falls back to the estimate from the last arm, and returns
// the text to print. Only a live probe is stored in the cache.
func (a *app) usage(ctx context.Context, cfg domain.Config, id domain.ProviderID) (string, error) {
	now := time.Now()
	pc := a.probeContext(cfg, id, now)
	prov := provider.Get(id)

	c, err := cache.Read(a.paths)
	if err != nil {
		return "", err
	}
	entry := c.Providers[id]
	u, live := provider.Current(ctx, prov, pc, entry)
	entry.Usage = u
	if live {
		err = cache.Update(a.paths, id, func(e domain.CacheEntry) domain.CacheEntry {
			e.Usage = u
			entry = e
			return e
		})
		if err != nil {
			return "", err
		}
	}

	view := provider.FormatUsage(pc, entry)
	var b strings.Builder
	fmt.Fprintf(&b, "session  %s\nweekly   %s\n", view.Session, view.Week)
	if m := entry.WeekModel; m != nil && m.Pct != nil {
		fmt.Fprintf(&b, "%-8s %d%%\n", m.Label, *m.Pct)
	}
	if !live {
		fmt.Fprintf(&b, "source   estimated from local warmup history (%s)\n", prov.Name())
	}
	return b.String(), nil
}
