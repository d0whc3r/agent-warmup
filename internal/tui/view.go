package tui

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// From wideAt columns the edit panel is a drawer on the right. Below, it
// covers the lanes.
const (
	wideAt      = 120
	drawerWidth = 40
	headerRows  = 1
	barRows     = 2 // the key bar
	chipGap     = 2 // cells between two chips
)

// zoneKind is what a click on a zone does.
type zoneKind string

const (
	zoneLane  zoneKind = "lane"  // select lane index
	zoneHours zoneKind = "hours" // the hour strip of lane index
	zoneField zoneKind = "field" // select edit panel field index
	zoneChip  zoneKind = "chip"  // press key
)

// zone is a clickable area: w cells from x, on h rows from y (0 counts as 1).
type zone struct {
	kind       zoneKind
	x, y, w, h int
	index      int
	key        string
}

func (z zone) contains(x, y int) bool {
	return x >= z.x && x < z.x+z.w && y >= z.y && y < z.y+max(z.h, 1)
}

// part is rendered lines and the zones on them, in the part's own coordinates.
type part struct {
	lines []string
	zones []zone
}

// add appends q below p.
func (p *part) add(q part) {
	for _, z := range q.zones {
		z.y += len(p.lines)
		p.zones = append(p.zones, z)
	}
	p.lines = append(p.lines, q.lines...)
}

// fit pads or cuts p to h lines and drops the zones that fall below.
func (p part) fit(h int) part {
	p.lines = fitLines(p.lines, h)
	var kept []zone
	for _, z := range p.zones {
		if z.y < h {
			kept = append(kept, z)
		}
	}
	p.zones = kept
	return p
}

// hit is the first zone at x, y.
func (p part) hit(x, y int) (zone, bool) {
	for _, z := range p.zones {
		if z.contains(x, y) {
			return z, true
		}
	}
	return zone{}, false
}

func (m model) View() tea.View {
	v := tea.NewView("")
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	if m.width == 0 {
		return v
	}
	v.SetContent(strings.Join(m.frame().lines, "\n"))
	return v
}

// frame renders the screen and records where each clickable thing landed.
// View draws its lines and the mouse handler hit-tests its zones, so a click
// lands on what the screen shows.
func (m model) frame() part {
	status := m.statusLines()
	f := part{lines: []string{m.headerView()}}
	f.add(m.bodyView(max(m.height-headerRows-len(status)-barRows, 0)))
	f.add(part{lines: status})
	f.add(m.barView())
	return f
}

func (m model) bodyView(h int) part {
	w := m.width
	switch {
	case m.focus == focusHelp:
		return part{lines: m.helpView(w)}.fit(h)
	case m.focus == focusLogs:
		return part{lines: m.logsView(w)}.fit(h)
	case m.focus == focusPanel && w < wideAt:
		return m.panelView(w).fit(h)
	case m.focus == focusPanel:
		return m.withDrawer(w, h)
	}
	return m.mainView(w, h)
}

// mainView is the lanes over the detail of the selected agent.
func (m model) mainView(w, h int) part {
	p := m.timelineView(w)
	p.lines = append(p.lines, "")
	if rest := h - len(p.lines); rest > 0 {
		p.lines = append(p.lines, m.detailView(w, rest)...)
	}
	return p.fit(h)
}

func (m model) withDrawer(w, h int) part {
	mainW := w - drawerWidth - 1
	main := m.mainView(mainW, h)
	drawer := m.panelView(drawerWidth - 2).fit(h)
	edge := m.st.rule.Render("│")
	for i := range main.lines {
		main.lines[i] += pad(mainW-ansi.StringWidth(main.lines[i])) + " " + edge + " " + drawer.lines[i]
	}
	for _, z := range drawer.zones {
		z.x += mainW + 3 // the main column, then " │ "
		main.zones = append(main.zones, z)
	}
	return main
}

// headerView puts the state on the left, and the unapplied mark and the
// running job on the right. The left part gives way first.
func (m model) headerView() string {
	state := m.st.dim.Render(markChecking + " checking")
	if m.snap != nil && m.snap.Active {
		state = m.st.good.Render(markOn + " active")
	}
	if m.snap != nil && !m.snap.Active {
		state = m.st.warn.Render(markOff + " inactive")
	}
	left := " " + m.st.brand.Render("agent-warmup") + " " + state
	if next := m.nextTick(); m.snap != nil && m.snap.Active && !next.IsZero() {
		left += m.st.dim.Render(" · next tick " + m.clock(next))
	}

	var right []string
	if m.unapplied {
		right = append(right, m.st.warn.Render(markPending+" unapplied"))
	}
	if m.busy != "" {
		right = append(right, m.spin.View()+" "+m.busy+ellipsis)
	}
	r := strings.Join(right, "  ")
	if r == "" {
		return truncate(left, m.width)
	}
	left = truncate(left, max(m.width-ansi.StringWidth(r)-2, 0))
	return truncate(left+pad(m.width-ansi.StringWidth(left)-ansi.StringWidth(r))+r, m.width)
}

// nextTick is the first coming tick of any enabled agent.
func (m model) nextTick() time.Time {
	var next time.Time
	for _, l := range m.lanes {
		if l.Next.IsZero() || (!next.IsZero() && !l.Next.Before(next)) {
			continue
		}
		next = l.Next
	}
	return next
}

// statusLines is the note, which wraps to show an error in full, and the
// open input. It is one blank line when neither is there.
func (m model) statusLines() []string {
	var lines []string
	if m.note.text != "" {
		lines = m.noteLines()
	}
	if m.prompt != nil {
		lines = append(lines, truncate(m.input.View(), m.width))
	}
	if len(lines) == 0 {
		lines = []string{""}
	}
	return lines
}

func (m model) noteLines() []string {
	style, mark := lipgloss.NewStyle(), markInfo
	switch m.note.kind {
	case noteOK:
		style, mark = m.st.good, markOK
	case noteFail:
		style, mark = m.st.bad, markFail
	case noteInfo:
	}
	wrapped := lipgloss.NewStyle().Width(m.width).Render(mark + m.note.text)
	lines := strings.Split(wrapped, "\n")
	for i, l := range lines {
		lines[i] = style.Render(truncate(strings.TrimRight(l, " "), m.width))
	}
	return lines
}

// barView draws the key bar: each key in a reversed box, then the label. A
// chip that does not fit is left out, so every drawn box can be clicked.
// Under the command line, the second line is the hint for the typed words.
func (m model) barView() part {
	var p part
	for y, chips := range m.keyBar() {
		var b strings.Builder
		x := 0
		for _, c := range chips {
			gap := 0
			if x > 0 {
				gap = chipGap
			}
			if x+gap+chipWidth(c) > m.width {
				break
			}
			b.WriteString(pad(gap))
			x += gap
			for i, k := range c.keys {
				if i > 0 {
					b.WriteString(" ")
					x++
				}
				box := " " + boxText(k) + " "
				p.zones = append(p.zones, zone{kind: zoneChip, x: x, y: y, w: ansi.StringWidth(box), key: k.Keys()[0]})
				b.WriteString(m.st.chip.Render(box))
				x += ansi.StringWidth(box)
			}
			b.WriteString(" " + c.label)
			x += 1 + ansi.StringWidth(c.label)
		}
		p.lines = append(p.lines, b.String())
	}
	if m.prompt != nil && m.prompt.action == "" {
		p.lines[1] = m.st.dim.Render(truncate(m.commandHint(), m.width))
	}
	return p
}

// chipWidth is the cells a chip takes: its boxes, the spaces between them,
// and the label.
func chipWidth(c chip) int {
	w := len(c.keys) + ansi.StringWidth(c.label) // n-1 spaces between boxes, one before the label
	for _, k := range c.keys {
		w += ansi.StringWidth(boxText(k)) + 2
	}
	return w
}

func truncate(s string, w int) string { return ansi.Truncate(s, w, ellipsis) }

func truncLines(lines []string, w int) []string {
	for i, l := range lines {
		lines[i] = truncate(l, w)
	}
	return lines
}

// fitLines pads or cuts lines to exactly h.
func fitLines(lines []string, h int) []string {
	if len(lines) > h {
		return lines[:h]
	}
	for len(lines) < h {
		lines = append(lines, "")
	}
	return lines
}
