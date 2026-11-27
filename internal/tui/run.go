// Package tui is the interactive terminal UI that agent-warmup opens when it
// runs without a subcommand. It shows one 24-hour lane per agent on a single
// screen.
package tui

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// Deps is everything the UI needs from the CLI. Config is the config the CLI
// already loaded. The UI saves every change through config.Save. Now is the
// clock that places the lanes.
type Deps struct {
	Paths   paths.Paths
	Config  domain.Config
	Actions Actions
	Now     func() time.Time
}

// Actions run the work that starts processes or reads the scheduler state.
// The CLI wires the real scheduler, runner, and detector. Tests pass fakes.
// Each one runs off the UI goroutine and must not write to stdout or stderr.
type Actions struct {
	Snapshot      func(ctx context.Context, cfg domain.Config) (Snapshot, error)
	ApplySchedule func(ctx context.Context, cfg domain.Config) error
	StopSchedule  func(ctx context.Context) error
	RunNow        func(ctx context.Context, cfg domain.Config) ([]warmup.RunResult, error)
	// Detect returns the binary path found for id, or an error that says why
	// none counts (not found, or the opencode credential is missing).
	Detect func(ctx context.Context, cfg domain.Config, id domain.ProviderID) (string, error)
}

// Snapshot is the state the lanes are projected from.
type Snapshot struct {
	Active bool // the scheduler of this OS is installed
	Cache  domain.Cache
	Log    []logs.Entry // recent warmup.log lines, oldest first
}

// Run opens the UI and blocks until the user quits. Then it cancels the
// background work and waits for a running job to finish.
func Run(ctx context.Context, deps Deps) error {
	ctx, cancel := context.WithCancel(ctx)
	m := newModel(ctx, deps)
	_, err := tea.NewProgram(m, tea.WithContext(ctx)).Run()
	cancel()
	m.jobs.wait()
	return err
}
