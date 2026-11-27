package warmup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

// probeTimeout bounds one provider's probe, so a hung probe only costs that
// provider its live data.
const probeTimeout = 2 * time.Minute

// Source says where a tick's usage snapshot came from.
type Source string

const (
	SourceProbe Source = "probe" // a live probe succeeded
	SourceCache Source = "cache" // inferred from the last arm
)

type TickMode string

const (
	TickArm    TickMode = "arm"     // arm the providers that decide warm
	TickDryRun TickMode = "dry-run" // decide and log, never arm
)

type TickOptions struct {
	Mode     TickMode
	Provider domain.ProviderID // "" ticks every enabled provider
	Now      time.Time
}

// TickResult is one provider's tick. Status is 0 when it did not arm.
type TickResult struct {
	RunResult
	Decision domain.Decision
	Source   Source
}

// Tick probes, decides, and arms every selected provider concurrently,
// prints "[<id>] <action> — <reason>" per provider without an error, prunes
// the logs, and returns one result per provider. It never re-applies the
// scheduler: reloading launchd from inside the job kills the job. While
// another tick holds Paths.TickLock, it logs one line and returns no results.
func (r Runner) Tick(ctx context.Context, opts TickOptions) ([]TickResult, error) {
	unlock, err := tryLock(r.Paths.TickLock)
	if errors.Is(err, errTickBusy) {
		appendLog(r.Paths, opts.Now, "TICK skipped: another tick is running")
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer unlock()

	r = r.locked()
	ids := r.Config.Enabled()
	if opts.Provider != "" {
		if !slices.Contains(ids, opts.Provider) {
			_, err := r.probeContext(opts.Provider, opts.Now)
			return nil, err
		}
		ids = []domain.ProviderID{opts.Provider}
	}
	c, err := cache.Read(r.Paths)
	if err != nil {
		return nil, err
	}

	results := make([]TickResult, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Go(func() { results[i] = r.tickOne(ctx, id, c.Providers[id], opts) })
	}
	wg.Wait()

	r.prune(opts.Now)
	for _, res := range results {
		if res.Err == nil {
			fmt.Fprintf(r.Out, "[%s] %s — %s\n", res.ID, res.Decision.Action, res.Decision.Reason)
		}
	}
	return results, nil
}

func (r Runner) tickOne(ctx context.Context, id domain.ProviderID, entry domain.CacheEntry, opts TickOptions) TickResult {
	res := TickResult{RunResult: RunResult{ID: id}}
	pc, err := r.probeContext(id, opts.Now)
	if err != nil {
		res.Status, res.Err = statusFailed, err
		return res
	}
	prov := lookup(id)

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	u, probed := provider.Current(probeCtx, prov, pc, entry)
	cancel()
	res.Source = SourceCache
	if probed {
		res.Source = SourceProbe
	}
	res.Decision = prov.Decide(pc, u, entry)

	err = cache.Update(r.Paths, id, func(e domain.CacheEntry) domain.CacheEntry {
		e.LastDecision = &domain.CachedDecision{Decision: res.Decision, At: opts.Now}
		if probed {
			e.CapturedAt, e.Session, e.Week = u.CapturedAt, u.Session, u.Week
			if u.WeekModel != nil {
				e.WeekModel = u.WeekModel
			}
		}
		return e
	})
	if err != nil {
		res.Status, res.Err = statusFailed, err
		return res
	}

	// Logged before the arm, so the decision precedes the script's own lines.
	dry := ""
	if opts.Mode == TickDryRun {
		dry = " (dry-run)"
	}
	appendLog(r.Paths, opts.Now, fmt.Sprintf("TICK [%s] %s%s — %s [via %s]", id, res.Decision.Action, dry, res.Decision.Reason, res.Source))

	if res.Decision.Action != domain.ActionWarm || opts.Mode == TickDryRun {
		return res
	}
	res.Status, res.Err = r.runOne(ctx, id, opts.Now)
	return res
}

// prune trims the logs after a tick. Like a log write, a failed prune must
// not fail the tick.
func (r Runner) prune(now time.Time) {
	days, err := logs.RetentionDays()
	if err == nil {
		err = logs.Prune(r.Paths, now, days)
	}
	if err != nil {
		slog.Warn("prune logs", "err", err)
	}
}

var errTickBusy = errors.New("another tick is running")

// tryLock takes a non-blocking flock on path, so two ticks (a slow one and the
// next scheduled one) never run at once. Closing the file releases it.
func tryLock(path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), atomicfile.DirMode); err != nil {
		return nil, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, atomicfile.FileMode)
	if err != nil {
		return nil, fmt.Errorf("open tick lock: %w", err)
	}
	err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		f.Close()
		return nil, errTickBusy
	}
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("lock tick: %w", err)
	}
	return func() { f.Close() }, nil
}
