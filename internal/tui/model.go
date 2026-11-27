package tui

import (
	"context"
	"slices"
	"strconv"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// focus is the part of the screen that takes the keys.
type focus string

const (
	focusLanes focus = "lanes"
	focusPanel focus = "panel"
	focusHelp  focus = "help"
	focusLogs  focus = "logs"
)

type noteKind string

const (
	noteOK   noteKind = "ok"
	noteFail noteKind = "fail"
	noteInfo noteKind = "info"
)

type note struct {
	kind noteKind
	text string
}

// prompt is an open text input: the command line when action is "", else a
// field of the edit panel that runs action with args and the typed text.
type prompt struct {
	action string
	args   []string
}

// clockMsg moves the now marker.
type clockMsg struct{}

const clockEvery = time.Minute

type model struct {
	ctx  context.Context
	deps Deps
	cfg  domain.Config
	jobs *jobs

	snap      *Snapshot // nil until the first refresh returns
	lanes     []warmup.Lane
	usage     map[domain.ProviderID]provider.UsageView
	now       time.Time
	unapplied bool   // a schedule change is saved but not applied
	busy      string // the running job, or "" when idle
	note      note

	width, height int
	sel           int // index in domain.ProviderIDs
	cursor        int // hour under the lane cursor
	focus         focus
	panelRow      int
	drag          *drag // a press on an hour strip, until its release

	prompt *prompt
	input  textinput.Model

	logs   viewport.Model
	logGen int // invalidates log polls from an earlier open

	spin spinner.Model
	help help.Model
	st   styles
}

func newModel(ctx context.Context, deps Deps) model {
	now := deps.Now()
	m := model{
		ctx:    ctx,
		deps:   deps,
		cfg:    deps.Config,
		jobs:   &jobs{},
		now:    now,
		busy:   jobRefresh,
		cursor: now.Hour(),
		focus:  focusLanes,
		input:  textinput.New(),
		logs:   viewport.New(),
		spin:   spinner.New(spinner.WithSpinner(spinner.Dot)),
		help:   help.New(),
		st:     newStyles(true),
	}
	m.applyTheme(true)
	m.reproject()
	return m
}

func (m model) Init() tea.Cmd {
	return tea.Batch(tea.RequestBackgroundColor, m.spin.Tick, m.jobs.track(m.jobCmd(jobRefresh)), clockTick())
}

func clockTick() tea.Cmd {
	return tea.Tick(clockEvery, func(time.Time) tea.Msg { return clockMsg{} })
}

func (m *model) applyTheme(isDark bool) {
	m.st = newStyles(isDark)
	m.help.Styles = help.DefaultStyles(isDark)
	m.input.SetStyles(textinput.DefaultStyles(isDark))
}

// reproject recomputes the lanes and usage lines. Every change of the config,
// the snapshot, or the clock calls it, so View only reads the result.
func (m *model) reproject() {
	var snap Snapshot
	if m.snap != nil {
		snap = *m.snap
	}
	m.lanes = warmup.Timeline(m.cfg, snap.Cache, snap.Log, m.now)
	m.usage = make(map[domain.ProviderID]provider.UsageView, len(domain.ProviderIDs))
	for _, id := range domain.ProviderIDs {
		pc := provider.ProbeContext{ID: id, Cfg: m.cfg.Providers[id], Now: m.now}
		m.usage[id] = provider.FormatUsage(pc, snap.Cache.Providers[id])
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.sizeLogs()
		return m, nil
	case tea.BackgroundColorMsg:
		m.applyTheme(msg.IsDark())
		return m, nil
	case clockMsg:
		m.now = m.deps.Now()
		m.reproject()
		return m, clockTick()
	case spinner.TickMsg:
		if m.busy == "" {
			return m, nil
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	case tea.MouseClickMsg:
		return m.click(msg)
	case tea.MouseMotionMsg:
		return m.motion(msg)
	case tea.MouseReleaseMsg:
		return m.release(msg)
	case tea.MouseWheelMsg:
		return m.wheel(msg)
	}
	if m.prompt == nil {
		return m.handleResult(msg)
	}
	// An open input needs its cursor blink messages.
	var blink tea.Cmd
	m.input, blink = m.input.Update(msg)
	next, cmd := m.handleResult(msg)
	return next, tea.Batch(blink, cmd)
}

func (m model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	if m.prompt != nil {
		return m.promptKey(msg)
	}
	switch m.focus {
	case focusPanel:
		return m.panelKey(msg)
	case focusHelp:
		return m.helpKey(msg)
	case focusLogs:
		return m.logsKey(msg)
	case focusLanes:
	}
	return m.laneKey(msg)
}

func (m model) laneKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.Up):
		m.sel = (m.sel + len(domain.ProviderIDs) - 1) % len(domain.ProviderIDs)
		return m, nil
	case key.Matches(msg, keys.Down):
		m.sel = (m.sel + 1) % len(domain.ProviderIDs)
		return m, nil
	case key.Matches(msg, keys.Left):
		m.cursor = (m.cursor + domain.HoursPerDay - 1) % domain.HoursPerDay
		return m, nil
	case key.Matches(msg, keys.Right):
		m.cursor = (m.cursor + 1) % domain.HoursPerDay
		return m, nil
	case key.Matches(msg, keys.Command):
		return m.openPrompt(&prompt{}, "")
	case key.Matches(msg, keys.Weekly):
		return m.openPrompt(&prompt{action: "weekly", args: selected(m)}, strconv.Itoa(m.selCfg().WeeklyStopPercent))
	}
	for _, lk := range laneKeys {
		if key.Matches(msg, lk.binding) {
			next, cmd, _ := m.dispatch(lk.action, lk.args(m))
			return next, cmd
		}
	}
	return m, nil
}

func (m model) helpKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.Quit):
		return m, tea.Quit
	case key.Matches(msg, keys.Close, keys.Help):
		m.focus = focusLanes
	}
	return m, nil
}

func agentIndex(id domain.ProviderID) int { return slices.Index(domain.ProviderIDs, id) }

func (m model) selAgent() domain.ProviderID   { return domain.ProviderIDs[m.sel] }
func (m model) selID() string                 { return string(m.selAgent()) }
func (m model) selCfg() domain.ProviderConfig { return m.cfg.Providers[m.selAgent()] }
func (m model) selLane() warmup.Lane          { return m.lanes[m.sel] }
func (m model) nextModel(delta int) string {
	return cycle(provider.Get(m.selAgent()).ModelChoices(), m.selCfg().Model, delta)
}
