// Package warmup runs the tick (probe, decide, arm) and the arm scripts, and
// aggregates status. Providers run concurrently and independently.
package warmup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

const (
	// statusTimeout is the exit status timeout(1) reports, used for an arm
	// killed at armTimeout or by a signal.
	statusTimeout = 124
	statusFailed  = 1
)

// killWait is the longest time that an arm's output pipes can stay open after
// the script exits or its process group is killed. Tests shorten it.
var killWait = 5 * time.Second

// lookup is provider.Get. Tests replace it with a fake provider.
var lookup = provider.Get

// armTimeout kills a hung arm (tmux never came up, a login prompt waits).
// Tests shorten it.
var armTimeout = 5 * time.Minute

// Runner carries what every run needs. Out and Err receive the arm output,
// one "[<id>] " prefixed line per Write, and the summaries.
type Runner struct {
	Paths  paths.Paths
	Config domain.Config
	Out    io.Writer
	Err    io.Writer
}

// RunOne arms one enabled provider and returns the arm's exit status.
func (r Runner) RunOne(ctx context.Context, id domain.ProviderID, now time.Time) (int, error) {
	return r.locked().runOne(ctx, id, now)
}

// RunResult is one provider's arm: the script's exit status, and an error when
// the arm could not run or its result could not be recorded.
type RunResult struct {
	ID     domain.ProviderID
	Status int
	Err    error
}

// RunAll arms every enabled provider at once and returns one result per
// provider, in ProviderIDs order. The error is set only when none is enabled.
func (r Runner) RunAll(ctx context.Context, now time.Time) ([]RunResult, error) {
	r = r.locked()
	ids := r.Config.Enabled()
	if len(ids) == 0 {
		return nil, errors.New("no agents are enabled")
	}
	results := make([]RunResult, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Go(func() {
			status, err := r.runOne(ctx, id, now)
			results[i] = RunResult{ID: id, Status: status, Err: err}
		})
	}
	wg.Wait()
	return results, nil
}

func (r Runner) runOne(ctx context.Context, id domain.ProviderID, now time.Time) (int, error) {
	pc, err := r.probeContext(id, now)
	if err != nil {
		return statusFailed, err
	}
	prov := lookup(id)
	script, err := provider.EnsureArmScript(r.Paths, prov)
	if err != nil {
		return statusFailed, err
	}

	status := r.arm(ctx, id, script, armEnv(pc, prov))

	var line string
	err = cache.Update(r.Paths, id, func(e domain.CacheEntry) domain.CacheEntry {
		next, l := prov.RecordArm(pc, e, status)
		line = l
		return next
	})
	if err != nil {
		return status, err
	}
	if line != "" {
		appendLog(r.Paths, now, fmt.Sprintf("TICK [%s] %s", id, line))
	}
	return status, nil
}

func (r Runner) probeContext(id domain.ProviderID, now time.Time) (provider.ProbeContext, error) {
	cfg, ok := r.Config.Providers[id]
	if !ok || !cfg.Enabled {
		return provider.ProbeContext{}, fmt.Errorf("provider %s is disabled (enable it with: agent-warmup provider %s enable)", id, id)
	}
	return provider.ProbeContext{ID: id, Cfg: cfg, Now: now, Paths: r.Paths}, nil
}

func armEnv(pc provider.ProbeContext, prov provider.Provider) []string {
	env := append(os.Environ(),
		"WARMUP_BIN="+pc.Paths.ExpandHome(pc.Cfg.Binary),
		"WARMUP_MODEL="+pc.Cfg.Model,
		"WARMUP_TMUX_SESSION="+pc.ID.TmuxSession(),
		"WARMUP_HOME="+pc.Paths.Home,
		"WARMUP_WORKDIR="+pc.Paths.Workdir,
		"TMUX_BIN="+pc.Paths.Tmux,
	)
	for k, v := range prov.ArmEnv(pc) {
		env = append(env, k+"="+v)
	}
	return env
}

// arm runs the script under bash in its own process group and returns its
// exit status: the process code, statusTimeout for a kill, statusFailed when
// it cannot start. exec.ErrWaitDelay comes only after a clean exit, so it is 0.
func (r Runner) arm(ctx context.Context, id domain.ProviderID, script string, env []string) int {
	ctx, cancel := context.WithTimeout(ctx, armTimeout)
	defer cancel()

	prefix := "[" + string(id) + "] "
	stdout := &lineWriter{prefix: prefix, w: r.Out}
	stderr := &lineWriter{prefix: prefix, w: r.Err}
	cmd := exec.CommandContext(ctx, "/bin/bash", script)
	cmd.Env = env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Kill the whole group, so the script's children (sleep, tmux client) die too.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killWait

	err := cmd.Run()
	stdout.flush()
	stderr.flush()

	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.Is(err, exec.ErrWaitDelay):
		// The script exited 0, but a child it left behind kept the pipes open.
		fmt.Fprintf(r.Err, "%sa child process kept its output open after %s exited. The output after that is lost.\n", prefix, script)
		return 0
	case errors.As(err, &exit) && exit.ExitCode() >= 0:
		return exit.ExitCode()
	case errors.As(err, &exit):
		return statusTimeout // killed by a signal
	default:
		fmt.Fprintf(r.Err, "%sfailed to start %s: %v\n", prefix, script, err)
		return statusFailed
	}
}

// lineWriter writes each complete line to w as one prefixed Write, so lines
// from concurrent arms do not interleave.
type lineWriter struct {
	prefix string
	w      io.Writer
	buf    []byte
}

func (l *lineWriter) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			return len(p), nil
		}
		if _, err := l.w.Write([]byte(l.prefix + string(l.buf[:i+1]))); err != nil {
			return len(p), err
		}
		l.buf = l.buf[i+1:]
	}
}

// flush writes a last line that had no newline.
func (l *lineWriter) flush() {
	if len(l.buf) == 0 {
		return
	}
	fmt.Fprintf(l.w, "%s%s\n", l.prefix, l.buf)
	l.buf = nil
}

// lockedWriter serializes Writes from concurrent providers.
type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// locked returns r with Out and Err behind one shared mutex. It is a no-op
// when they already are.
func (r Runner) locked() Runner {
	if _, ok := r.Out.(lockedWriter); ok {
		return r
	}
	mu := &sync.Mutex{}
	r.Out = lockedWriter{mu: mu, w: r.Out}
	r.Err = lockedWriter{mu: mu, w: r.Err}
	return r
}

// appendLog writes a warmup.log line. A failed log write must not fail the
// tick or the run, so it is reported on slog and dropped.
func appendLog(p paths.Paths, now time.Time, line string) {
	if err := logs.Append(p, now, line); err != nil {
		slog.Warn("append warmup log", "err", err)
	}
}
