package tui

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// Job names double as the progress text in the header.
const (
	jobRefresh = "reading status"
	jobApply   = "applying schedule"
	jobStop    = "stopping schedulers"
	jobRun     = "running warmup (up to 5 minutes)"
	jobDetect  = "detecting binary"
)

type snapshotMsg struct {
	snap Snapshot
	err  error
}

// doneMsg ends apply, stop, and run. A refresh follows it.
type doneMsg struct {
	job string
	ok  string
	err error
}

type detectMsg struct {
	id   domain.ProviderID
	path string
	err  error
}

// start runs cmd as the only background job, so two jobs never race on the
// scheduler or the config.
// ponytail: one job slot, so a run blocks apply for up to 5 minutes. Add a job set if that becomes a problem.
func (m model) start(job string, cmd tea.Cmd) (model, tea.Cmd, error) {
	if m.busy != "" {
		return m, nil, fmt.Errorf("wait: %s is still running", m.busy)
	}
	m.busy = job
	return m, tea.Batch(m.jobs.track(cmd), m.spin.Tick), nil
}

// jobs lets Run wait, after quit, for a job that already started: the
// canceled arm then kills its process group and records its result before
// the process exits. Bubble Tea does not wait for commands.
type jobs struct {
	mu     sync.Mutex
	closed bool
	wg     sync.WaitGroup
}

// track wraps cmd so wait waits for it. After wait, cmd does not start.
func (j *jobs) track(cmd tea.Cmd) tea.Cmd {
	return func() tea.Msg {
		j.mu.Lock()
		if j.closed {
			j.mu.Unlock()
			return nil
		}
		j.wg.Add(1)
		j.mu.Unlock()
		defer j.wg.Done()
		return cmd()
	}
}

func (j *jobs) wait() {
	j.mu.Lock()
	j.closed = true
	j.mu.Unlock()
	j.wg.Wait()
}

// jobCmd returns the command of a job that needs no argument.
func (m model) jobCmd(job string) tea.Cmd {
	ctx, cfg, act := m.ctx, m.cfg, m.deps.Actions
	switch job {
	case jobApply:
		return func() tea.Msg {
			return doneMsg{job, "schedule applied", act.ApplySchedule(ctx, cfg)}
		}
	case jobStop:
		return func() tea.Msg { return doneMsg{job, "schedulers removed", act.StopSchedule(ctx)} }
	case jobRun:
		return func() tea.Msg {
			results, err := act.RunNow(ctx, cfg)
			return doneMsg{job, "warmup finished: " + runSummary(results), errors.Join(err, runFailure(results))}
		}
	case jobRefresh:
		return func() tea.Msg {
			snap, err := act.Snapshot(ctx, cfg)
			return snapshotMsg{snap, err}
		}
	}
	panic("tui: job " + job + " has no command")
}

func (m model) detectCmd(id domain.ProviderID) tea.Cmd {
	ctx, cfg, detect := m.ctx, m.cfg, m.deps.Actions.Detect
	return func() tea.Msg {
		path, err := detect(ctx, cfg, id)
		return detectMsg{id, path, err}
	}
}

func (m model) handleResult(msg tea.Msg) (model, tea.Cmd) {
	switch msg := msg.(type) {
	case snapshotMsg:
		m.busy = ""
		if msg.err != nil {
			m.note = note{noteFail, "status: " + msg.err.Error()}
			return m, nil
		}
		m.snap = &msg.snap
		m.reproject()
	case doneMsg:
		m.busy = ""
		if msg.err != nil {
			m.note = note{noteFail, msg.job + ": " + msg.err.Error()}
		} else {
			m.note = note{noteOK, msg.ok}
		}
		if msg.job == jobApply && msg.err == nil {
			m.unapplied = false
		}
		m, cmd, _ := m.start(jobRefresh, m.jobCmd(jobRefresh))
		return m, cmd
	case detectMsg:
		m.busy = ""
		return m.saveDetected(msg), nil
	case logsMsg:
		return m.showLogs(msg)
	case logPollMsg:
		return m.pollLogs(msg)
	}
	return m, nil
}

func (m model) saveDetected(msg detectMsg) model {
	if msg.err != nil {
		m.note = note{noteFail, string(msg.id) + ": " + msg.err.Error()}
		return m
	}
	if m.cfg.Providers[msg.id].Binary == msg.path {
		m.note = note{noteOK, string(msg.id) + " binary already points at " + msg.path}
		return m
	}
	next := config.WithProvider(m.cfg, msg.id, func(pc *domain.ProviderConfig) { pc.Binary = msg.path })
	saved, err := m.save(next, effectConfig, string(msg.id)+" binary "+msg.path)
	if err != nil {
		m.note = note{noteFail, err.Error()}
		return m
	}
	return saved
}

func runSummary(results []warmup.RunResult) string {
	parts := make([]string, len(results))
	for i, r := range results {
		parts[i] = markOK + string(r.ID)
		if r.Err != nil || r.Status != 0 {
			parts[i] = markFail + string(r.ID)
		}
	}
	return strings.Join(parts, "  ")
}

// runFailure joins the errors of the agents whose warmup failed.
func runFailure(results []warmup.RunResult) error {
	var errs []error
	for _, r := range results {
		switch {
		case r.Err != nil:
			errs = append(errs, fmt.Errorf("%s: %w", r.ID, r.Err))
		case r.Status != 0:
			errs = append(errs, fmt.Errorf("%s: arm script exited with status %d", r.ID, r.Status))
		}
	}
	return errors.Join(errs...)
}
