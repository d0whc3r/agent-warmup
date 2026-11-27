package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/legacy"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

func (a *app) runCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "run [AGENT]",
		Aliases:           []string{"now"},
		Short:             "Warm every enabled agent now, or one agent",
		Args:              optionalAgent,
		ValidArgsFunction: completeIDs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			r := warmup.Runner{Paths: a.paths, Config: cfg, Out: a.out, Err: a.errOut}
			id := agentOf(args)
			if id == "" {
				results, err := r.RunAll(cmd.Context(), time.Now())
				if err != nil {
					return err
				}
				return a.reportArms(results, linesAll)
			}
			status, err := r.RunOne(cmd.Context(), id, time.Now())
			if err != nil {
				return err
			}
			return a.reportArms([]warmup.RunResult{{ID: id, Status: status}}, linesFailures)
		},
	}
}

func (a *app) tickCmd() *cobra.Command {
	var dryRun bool
	cmd := &cobra.Command{
		Use:               "tick [AGENT]",
		Short:             "Decide and maybe warm each enabled agent, or one agent (the scheduler runs this)",
		Hidden:            true,
		Args:              optionalAgent,
		ValidArgsFunction: completeIDs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			opts := warmup.TickOptions{Mode: warmup.TickArm, Provider: agentOf(args), Now: time.Now()}
			if dryRun {
				opts.Mode = warmup.TickDryRun
			}
			r := warmup.Runner{Paths: a.paths, Config: cfg, Out: a.out, Err: a.errOut}
			results, err := r.Tick(cmd.Context(), opts)
			if err != nil {
				return err
			}
			runs := make([]warmup.RunResult, len(results))
			for i, res := range results {
				runs[i] = res.RunResult
			}
			return a.reportArms(runs, linesFailures)
		},
	}
	cmd.Flags().BoolVarP(&dryRun, "dry-run", "n", false, "decide and log, never arm")
	return cmd
}

// armLines picks what reportArms prints besides the failures.
type armLines string

const (
	linesAll      armLines = "all"      // run: "✓ <id>" for each success too
	linesFailures armLines = "failures" // tick and run AGENT: their output already shows success
)

// reportArms prints one line per failed arm (and per success with linesAll)
// and returns exit status 1 when any arm failed. An arm's own status could be
// 2, which means a bad command line.
func (a *app) reportArms(results []warmup.RunResult, lines armLines) error {
	var out, errOut strings.Builder
	failed := false
	for _, res := range results {
		switch {
		case res.Err != nil:
			failed = true
			fmt.Fprintf(&errOut, "✗ %s: %v\n", res.ID, res.Err)
		case res.Status != 0:
			failed = true
			fmt.Fprintf(&out, "✗ %s failed (status %d)\n", res.ID, res.Status)
		case lines == linesAll:
			fmt.Fprintf(&out, "✓ %s\n", res.ID)
		}
	}
	fmt.Fprint(a.out, out.String())
	fmt.Fprint(a.errOut, errOut.String())
	if failed {
		return statusError{exitError}
	}
	return nil
}

// exitStatus turns the status of less into the process exit status.
func exitStatus(status int, err error) error {
	if err != nil {
		return err
	}
	if status != 0 {
		return statusError{status}
	}
	return nil
}

func (a *app) startCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Install and load the scheduler",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			if err := a.apply(cmd.Context(), cfg); err != nil {
				return err
			}
			fmt.Fprintln(a.out, "✓ scheduler installed and loaded")
			return a.printStatus(cmd.Context(), cfg, cfg.Enabled())
		},
	}
}

func (a *app) stopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Remove the launchd job and the crontab block",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.stop(cmd.Context()); err != nil {
				return err
			}
			fmt.Fprintln(a.out, "✓ schedulers removed")
			return nil
		},
	}
}

func (a *app) restartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart",
		Short: "Remove and reinstall the scheduler",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			if err := a.stop(cmd.Context()); err != nil {
				return err
			}
			if err := a.apply(cmd.Context(), cfg); err != nil {
				return err
			}
			fmt.Fprintln(a.out, "✓ scheduler reloaded")
			return nil
		},
	}
}

func (a *app) apply(ctx context.Context, cfg domain.Config) error {
	report, err := scheduler.Apply(ctx, a.paths, cfg)
	a.printReport(report)
	if err != nil {
		return fmt.Errorf("load scheduler: %w", err)
	}
	return nil
}

func (a *app) stop(ctx context.Context) error {
	report, err := scheduler.Stop(ctx, a.paths)
	a.printReport(report)
	if err != nil {
		return fmt.Errorf("remove schedulers: %w", err)
	}
	return nil
}

func (a *app) printReport(r legacy.Report) {
	var b strings.Builder
	for _, s := range r.Actions {
		b.WriteString("✓ " + s + "\n")
	}
	for _, s := range r.Notices {
		b.WriteString("! " + s + "\n")
	}
	fmt.Fprint(a.out, b.String())
}

func (a *app) logsCmd() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show the warmup log",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			mode := warmup.LogsStatic
			if follow {
				mode = warmup.LogsFollow
			}
			return exitStatus(warmup.ViewLogs(cmd.Context(), a.paths, mode, a.out))
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep printing new lines")
	return cmd
}

// commit saves next and re-applies the scheduler when it is active.
func (a *app) commit(ctx context.Context, next domain.Config, summary string) error {
	st, err := scheduler.State(ctx, a.paths)
	if err != nil {
		return err
	}
	if err := config.Save(a.paths, next); err != nil {
		return err
	}
	if !st.Active {
		fmt.Fprintf(a.out, "✓ %s\n", summary)
		return nil
	}
	if err := a.apply(ctx, next); err != nil {
		return fmt.Errorf("saved the configuration, but could not apply it: %w\nFix the cause, then run `agent-warmup restart`", err)
	}
	fmt.Fprintf(a.out, "✓ %s (applied)\n", summary)
	return nil
}

// save writes a change that the installed scheduler does not depend on.
func (a *app) save(next domain.Config, summary string) error {
	if err := config.Save(a.paths, next); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "✓ %s\n", summary)
	return nil
}
