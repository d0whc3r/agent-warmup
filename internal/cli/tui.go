package cli

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/detect"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
	"github.com/d0whc3r/agent-warmup/internal/tui"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// tuiLogLines is how much of warmup.log the lanes read: enough for today's
// arms and yesterday's evening, whose windows reach past midnight.
const tuiLogLines = 2000

// tuiActions wires the UI to the scheduler, runner, and detector. The UI owns
// the terminal, so nothing here prints. The legacy reports of Apply and Stop
// are dropped for the same reason. The start and stop commands print them.
func (a *app) tuiActions() tui.Actions {
	return tui.Actions{
		Snapshot: a.tuiSnapshot,
		ApplySchedule: func(ctx context.Context, cfg domain.Config) error {
			_, err := scheduler.Apply(ctx, a.paths, cfg)
			return err
		},
		StopSchedule: func(ctx context.Context) error {
			_, err := scheduler.Stop(ctx, a.paths)
			return err
		},
		RunNow: a.tuiRunNow,
		Detect: func(_ context.Context, cfg domain.Config, id domain.ProviderID) (string, error) {
			d := detect.Detect(a.paths, id, cfg.Providers[id].Binary)
			if d.Path == "" {
				return "", errors.New(where(d))
			}
			return d.Path, nil
		},
	}
}

func (a *app) tuiSnapshot(ctx context.Context, cfg domain.Config) (tui.Snapshot, error) {
	st, err := warmup.ReadStatus(ctx, a.paths, cfg)
	if err != nil {
		return tui.Snapshot{}, err
	}
	entries, err := logs.Recent(a.paths, tuiLogLines)
	if err != nil {
		return tui.Snapshot{}, err
	}
	return tui.Snapshot{Active: st.Scheduler.Active, Cache: st.Cache, Log: entries}, nil
}

// tuiRunNow arms every enabled agent at once, like run. The arm output goes
// nowhere: the arm scripts write warmup.log, which the UI shows.
func (a *app) tuiRunNow(ctx context.Context, cfg domain.Config) ([]warmup.RunResult, error) {
	r := warmup.Runner{Paths: a.paths, Config: cfg, Out: io.Discard, Err: io.Discard}
	return r.RunAll(ctx, time.Now())
}
