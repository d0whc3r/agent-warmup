package tui

import (
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/logs"
)

// The log screen tails warmup.log, so a warmup started with r can be
// watched while it runs.
const (
	logTailLines = 500
	logPoll      = 2 * time.Second
	logChrome    = 4 // header, log title, status line, and help line
)

type logsMsg struct {
	gen   int
	lines []string
	err   error
}

type logPollMsg struct{ gen int }

func openLogs(m model, _ []string) (model, tea.Cmd, error) {
	m.focus = focusLogs
	m.logGen++
	m.sizeLogs()
	return m, m.readLogsCmd(), nil
}

func (m *model) sizeLogs() {
	m.logs.SetWidth(max(m.width, 1))
	m.logs.SetHeight(max(m.height-logChrome, 1))
}

func (m model) readLogsCmd() tea.Cmd {
	p, gen := m.deps.Paths, m.logGen
	return func() tea.Msg {
		lines, err := logs.Tail(p, logTailLines)
		return logsMsg{gen, lines, err}
	}
}

func (m model) showLogs(msg logsMsg) (model, tea.Cmd) {
	if msg.gen != m.logGen || m.focus != focusLogs {
		return m, nil
	}
	if msg.err != nil {
		m.note = note{noteFail, "logs: " + msg.err.Error()}
	}
	follow := m.logs.AtBottom() || m.logs.TotalLineCount() == 0
	content := "No logs yet. Press esc, then r to run a warmup."
	if len(msg.lines) > 0 {
		content = strings.Join(msg.lines, "\n")
	}
	m.logs.SetContent(content)
	if follow {
		m.logs.GotoBottom()
	}
	gen := m.logGen
	return m, tea.Tick(logPoll, func(time.Time) tea.Msg { return logPollMsg{gen} })
}

func (m model) pollLogs(msg logPollMsg) (model, tea.Cmd) {
	if msg.gen != m.logGen || m.focus != focusLogs {
		return m, nil
	}
	return m, m.readLogsCmd()
}

func (m model) logsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.Quit):
		return m, tea.Quit
	case key.Matches(msg, keys.Close, keys.Logs):
		m.focus = focusLanes
		return m, nil
	}
	var cmd tea.Cmd
	m.logs, cmd = m.logs.Update(msg)
	return m, cmd
}

func (m model) logsView(w int) []string {
	title := m.st.bold.Render("warmup.log") + m.st.dim.Render(" · all agents · follows new lines")
	return truncLines(append([]string{title}, strings.Split(m.logs.View(), "\n")...), w)
}
