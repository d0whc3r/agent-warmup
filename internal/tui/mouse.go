package tui

import (
	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// The mouse adds to the keys and never replaces one. Every click is
// hit-tested against the zones of frame, which View draws.

// drag is a press on the hour strip of lane, at hour from.
type drag struct{ lane, from int }

// click on a key bar chip presses its key. With no input open, a click on a
// lane selects it, a click on its hour strip also moves the hour cursor and
// starts a drag, and a click on an edit panel field selects the field.
func (m model) click(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	if msg.Button != tea.MouseLeft {
		return m, nil
	}
	z, ok := m.frame().hit(msg.X, msg.Y)
	if !ok {
		return m, nil
	}
	if z.kind == zoneChip {
		return m.handleKey(keyPress(z.key))
	}
	if m.prompt != nil {
		return m, nil
	}
	switch z.kind {
	case zoneLane:
		m.sel = z.index
	case zoneHours:
		m.sel, m.cursor = z.index, hourAt(z, msg.X)
		m.drag = &drag{lane: z.index, from: m.cursor}
	case zoneField:
		m.panelRow = z.index
	case zoneChip:
	}
	return m, nil
}

// motion with the button held moves the hour cursor along the dragged strip.
func (m model) motion(msg tea.MouseMotionMsg) (tea.Model, tea.Cmd) {
	if m.drag != nil {
		m.cursor = m.dragHour(msg.X)
	}
	return m, nil
}

// release ends a drag. Across two or more hours it sets the work hours from
// the press to the release, through the same action as [ and ].
func (m model) release(msg tea.MouseReleaseMsg) (tea.Model, tea.Cmd) {
	if m.drag == nil {
		return m, nil
	}
	to := m.dragHour(msg.X)
	d := *m.drag
	m.drag, m.cursor = nil, to
	if to == d.from {
		return m, nil
	}
	id := string(domain.ProviderIDs[d.lane])
	next, cmd, _ := m.dispatch("hours", []string{id, hoursArg(min(d.from, to), max(d.from, to)+1)})
	return next, cmd
}

// dragHour is the hour under x on the dragged lane's strip, clamped to the
// strip, so the pointer can leave the lane row while it drags.
func (m model) dragHour(x int) int {
	for _, z := range m.frame().zones {
		if z.kind == zoneHours && z.index == m.drag.lane {
			return hourAt(z, x)
		}
	}
	return m.cursor
}

func hourAt(z zone, x int) int {
	return min(max((x-z.x)*domain.HoursPerDay/z.w, 0), domain.HoursPerDay-1)
}

// wheel scrolls the log, or moves the lane selection.
func (m model) wheel(msg tea.MouseWheelMsg) (tea.Model, tea.Cmd) {
	if m.prompt != nil || m.focus == focusHelp {
		return m, nil
	}
	if m.focus == focusLogs {
		var cmd tea.Cmd
		m.logs, cmd = m.logs.Update(msg)
		return m, cmd
	}
	n := len(domain.ProviderIDs)
	if msg.Button == tea.MouseWheelUp {
		m.sel = (m.sel + n - 1) % n
	}
	if msg.Button == tea.MouseWheelDown {
		m.sel = (m.sel + 1) % n
	}
	return m, nil
}
