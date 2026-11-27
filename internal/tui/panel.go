package tui

import (
	"fmt"
	"strconv"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

// weeklyStep is how far ←/→ moves the weekly stop percentage.
const weeklyStep = 5

// row is one field of the edit panel. hint says why the field exists. step
// builds the action arguments for ←/→, and text gives the value an input
// opens with on enter. A nil step or text means the row has none.
type row struct {
	label  string
	hint   string
	action string
	value  func(m model) string
	step   func(m model, delta int) []string
	text   func(m model) string
}

var rows = []row{
	{label: "enabled", hint: "warmups run only for agents that are on", action: "toggle", value: enabledText, step: stepSelected},
	{
		label: "model", hint: "each warmup spends quota of this model", action: "model",
		value: func(m model) string { return m.selCfg().Model },
		step:  func(m model, d int) []string { return []string{m.selID(), m.nextModel(d)} },
		text:  func(m model) string { return m.selCfg().Model },
	},
	{
		label: "work hours", hint: "the window is ready when your workday starts", action: "hours",
		value: func(m model) string { return workText(m.selCfg()) },
		text:  func(m model) string { return hoursArg(m.selCfg().WorkStart, m.selCfg().WorkEnd) },
	},
	{
		label: "weekly stop", hint: "skips warmups when weekly use is above this, to save quota", action: "weekly",
		value: func(m model) string { return strconv.Itoa(m.selCfg().WeeklyStopPercent) + "%" },
		step: func(m model, d int) []string {
			return []string{m.selID(), strconv.Itoa(m.selCfg().WeeklyStopPercent + d*weeklyStep)}
		},
		text: func(m model) string { return strconv.Itoa(m.selCfg().WeeklyStopPercent) },
	},
	{label: "binary", hint: "found automatically; set it only if detection fails", action: "binary", value: binaryText, text: binaryText},
}

func stepSelected(m model, _ int) []string { return selected(m) }

func enabledText(m model) string {
	if m.selCfg().Enabled {
		return markOn + " on"
	}
	return markOff + " off"
}

func binaryText(m model) string { return m.selCfg().Binary }

func workText(pc domain.ProviderConfig) string {
	return fmt.Sprintf("%02d-%02d", pc.WorkStart, pc.WorkEnd)
}

func (m model) panelKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	r := rows[m.panelRow]
	switch {
	case key.Matches(msg, keys.Up):
		m.panelRow = max(m.panelRow-1, 0)
	case key.Matches(msg, keys.Down):
		m.panelRow = min(m.panelRow+1, len(rows)-1)
	case key.Matches(msg, keys.Left):
		return m.stepRow(r, -1)
	case key.Matches(msg, keys.Right, keys.Toggle):
		return m.stepRow(r, 1)
	case key.Matches(msg, keys.Edit) && r.text != nil:
		return m.openPrompt(&prompt{action: r.action, args: selected(m)}, r.text(m))
	case key.Matches(msg, keys.Edit):
		return m.stepRow(r, 1)
	case key.Matches(msg, keys.Detect):
		next, cmd, _ := m.dispatch("detect", selected(m))
		return next, cmd
	case key.Matches(msg, keys.Close):
		m.focus = focusLanes
	case key.Matches(msg, keys.Help):
		m.focus = focusHelp
	case key.Matches(msg, keys.Quit):
		return m, tea.Quit
	}
	return m, nil
}

func (m model) stepRow(r row, delta int) (tea.Model, tea.Cmd) {
	if r.step == nil {
		m.note = note{noteInfo, r.label + ": press enter to type a value"}
		return m, nil
	}
	next, cmd, _ := m.dispatch(r.action, r.step(m, delta))
	return next, cmd
}

// panelView renders the edit panel in w columns: each field, then its hint.
// A field and its hint are one click zone.
func (m model) panelView(w int) part {
	id := m.selAgent()
	p := part{lines: []string{"", m.st.bold.Render("Edit "+string(id)) + m.st.dim.Render(" · "+provider.Get(id).Name())}}
	for i, r := range rows {
		mark := "  "
		if i == m.panelRow {
			mark = markSelected + " "
		}
		value := r.value(m)
		if r.step != nil {
			value = "‹ " + value + " ›"
		}
		line := mark + fmt.Sprintf("%-13s", r.label) + value
		if i == m.panelRow {
			line = m.st.bold.Render(line)
		}
		p.zones = append(p.zones, zone{kind: zoneField, x: 0, y: len(p.lines), w: w, h: 2, index: i})
		p.lines = append(p.lines, line, "  "+m.st.dim.Render(r.hint))
	}
	p.lines = truncLines(p.lines, w)
	return p
}
