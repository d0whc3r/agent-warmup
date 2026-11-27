// Package scheduler installs, removes, and reports the job that runs
// "agent-warmup tick": a launchd agent on macOS or a crontab block. One job
// serves every enabled provider.
package scheduler

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/legacy"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

// tickMinutes is how often the job runs inside the work hours. It divides an
// hour, so launchd and cron fire on the same minutes every hour.
const tickMinutes = 15

// Backend is the program that runs the job: launchd on macOS, cron elsewhere.
type Backend string

const (
	BackendLaunchd Backend = "launchd"
	BackendCron    Backend = "cron"
)

// backendFor is the backend of an OS, named as runtime.GOOS names it.
func backendFor(goos string) Backend {
	if goos == "darwin" {
		return BackendLaunchd
	}
	return BackendCron
}

type LaunchdStatus struct {
	Installed bool // the plist exists
	Loaded    bool // launchctl print succeeds
	Running   bool // loaded and a tick runs right now
	Enabled   bool // not in launchctl print-disabled
}

type CronStatus struct {
	Installed bool // the crontab holds the begin marker
}

type Status struct {
	Backend Backend
	Launchd LaunchdStatus // zero off macOS
	Cron    CronStatus
	Active  bool // the backend is installed (launchd: and loaded and enabled)
}

// Apply installs the job with the backend of this OS and removes a cron block
// left on macOS. It runs legacy.Clean first. The arm scripts are not written
// here: the runner writes the embedded script before every run.
func Apply(ctx context.Context, p paths.Paths, cfg domain.Config) (legacy.Report, error) {
	return apply(ctx, p, cfg, backendFor(runtime.GOOS))
}

func apply(ctx context.Context, p paths.Paths, cfg domain.Config, b Backend) (legacy.Report, error) {
	report, err := legacy.Clean(ctx, p)
	if err != nil {
		return report, err
	}
	exe, err := sysexec.Self()
	if err != nil {
		return report, err
	}
	if err := privateDirs(p); err != nil {
		return report, err
	}

	if b == BackendCron {
		return report, applyCron(ctx, p, cfg, exe)
	}
	if err := removeCron(ctx); err != nil {
		return report, err
	}
	return report, applyLaunchd(ctx, p, cfg, exe)
}

// homeEnv is passed to the scheduled tick when it is set, so the tick uses
// the same home as the command that installed it.
const homeEnv = "WARMUP_HOME"

// privateDirs creates Home and LogDir and makes both owner-only. MkdirAll
// keeps the mode of a directory that exists, so it chmods both. The cron
// redirect needs LogDir before the first tick runs.
func privateDirs(p paths.Paths) error {
	for _, dir := range []string{p.Home, p.LogDir} {
		if err := os.MkdirAll(dir, atomicfile.DirMode); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
		if err := os.Chmod(dir, atomicfile.DirMode); err != nil {
			return fmt.Errorf("chmod %s: %w", dir, err)
		}
	}
	return nil
}

// Stop removes the launchd job and the cron block. It runs legacy.Clean first.
func Stop(ctx context.Context, p paths.Paths) (legacy.Report, error) {
	report, err := legacy.Clean(ctx, p)
	if err != nil {
		return report, err
	}
	if runtime.GOOS == "darwin" {
		if err := removeLaunchd(ctx, p); err != nil {
			return report, err
		}
	}
	return report, removeCron(ctx)
}

// State reads the launchd job and the cron block, and whether the backend of
// this OS is active.
func State(ctx context.Context, p paths.Paths) (Status, error) {
	return state(ctx, p, backendFor(runtime.GOOS))
}

func state(ctx context.Context, p paths.Paths, b Backend) (Status, error) {
	s := Status{Backend: b}
	if b == BackendLaunchd {
		l, err := launchdState(ctx, p)
		if err != nil {
			return s, err
		}
		s.Launchd = l
	}
	c, err := cronState(ctx)
	if err != nil {
		return s, err
	}
	s.Cron = c

	s.Active = s.Cron.Installed
	if b == BackendLaunchd {
		s.Active = s.Launchd.Installed && s.Launchd.Loaded && s.Launchd.Enabled
	}
	return s, nil
}

// NextRun describes when the job runs: the cadence and the union of the work
// hours, or "" when no agent is enabled.
func NextRun(cfg domain.Config) string {
	start, end, ok := band(cfg)
	if !ok {
		return ""
	}
	return fmt.Sprintf("every %dm · %02d–%02dh", tickMinutes, start, end)
}

// band is the union of the enabled providers' work bands, [start, end).
func band(cfg domain.Config) (start, end int, ok bool) {
	ids := cfg.Enabled()
	if len(ids) == 0 {
		return 0, 0, false
	}
	start, end = domain.HoursPerDay, 0
	for _, id := range ids {
		pc := cfg.Providers[id]
		start = min(start, pc.WorkStart)
		end = max(end, pc.WorkEnd)
	}
	return start, end, true
}

// Ticks lists the times in [from, to) at which the job fires, in order.
func Ticks(cfg domain.Config, from, to time.Time) []time.Time {
	cal := calendar(cfg)
	var out []time.Time
	y, mo, d := from.Date()
	for day := time.Date(y, mo, d, 0, 0, 0, 0, from.Location()); day.Before(to); day = day.AddDate(0, 0, 1) {
		for _, at := range cal {
			t := time.Date(day.Year(), day.Month(), day.Day(), at[0], at[1], 0, 0, day.Location())
			if !t.Before(from) && t.Before(to) {
				out = append(out, t)
			}
		}
	}
	return out
}
