package tui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

const (
	nameWidth     = 11 // "▸ opencode "
	minSummary    = 16
	labelSpan     = 6 // fewest cells from one hour label to the next
	minutesPerDay = domain.HoursPerDay * 60
)

// labelSteps are the hour steps the scale can label, finest first.
var labelSteps = []int{1, 2, 4, 6, 12}

// geometry is the lane layout for one width: lane cells, cells per hour,
// hours between scale labels, and the width of the usage summary.
type geometry struct {
	lane, cph, step, summary int
}

func newGeometry(w int) geometry {
	cph := max((w-nameWidth-1-minSummary)/domain.HoursPerDay, 1)
	g := geometry{lane: cph * domain.HoursPerDay, cph: cph}
	g.summary = max(w-nameWidth-g.lane-1, 0)
	g.step = labelSteps[len(labelSteps)-1]
	for _, s := range labelSteps {
		if s*cph >= labelSpan {
			g.step = s
			break
		}
	}
	return g
}

// cell is the lane cell that holds t, or -1 when t is not today.
func (g geometry) cell(dayStart, t time.Time) int {
	minute := int(t.Sub(dayStart).Minutes())
	if minute < 0 || minute >= minutesPerDay {
		return -1
	}
	return minute * g.lane / minutesPerDay
}

func dayStart(now time.Time) time.Time {
	y, mo, d := now.Date()
	return time.Date(y, mo, d, 0, 0, 0, 0, now.Location())
}

// timelineView is a blank line, the scale, the marker row, one lane per
// agent, and the legend. Each lane is a zone, and its hour strip a zone
// before it, so a click on the strip hits the strip.
func (m model) timelineView(w int) part {
	g := newGeometry(w)
	p := part{lines: []string{"", m.scaleRow(g), m.markerRow(g)}}
	for i := range m.lanes {
		y := len(p.lines)
		p.zones = append(p.zones,
			zone{kind: zoneHours, x: nameWidth, y: y, w: g.lane, index: i},
			zone{kind: zoneLane, x: 0, y: y, w: w, index: i})
		p.lines = append(p.lines, m.laneRow(i, g))
	}
	p.lines = truncLines(append(p.lines, m.legend()), w)
	return p
}

func (m model) scaleRow(g geometry) string {
	cells := []rune(strings.Repeat(" ", g.lane))
	for h := 0; h < domain.HoursPerDay; h += g.step {
		pos := h * g.cph
		if pos+2 <= g.lane {
			copy(cells[pos:], []rune(fmt.Sprintf("%02d", h)))
		}
	}
	return pad(nameWidth) + m.st.dim.Render(string(cells)) + " " + m.st.dim.Render(m.now.Format("Mon Jan 2"))
}

// markerRow puts the now marker and the hour cursor above the lanes, and
// spells both times out on the right.
func (m model) markerRow(g geometry) string {
	cells := strings.Split(pad(g.lane), "")
	cells[m.cursor*g.cph] = m.st.bold.Render(glyphCursor)
	if c := g.cell(dayStart(m.now), m.now); c >= 0 {
		cells[c] = m.st.now.Render(glyphNow)
	}
	text := fmt.Sprintf("%s %s  %s %02d:00", glyphNow, m.now.Format("15:04"), glyphCursor, m.cursor)
	return pad(nameWidth) + strings.Join(cells, "") + " " + m.st.dim.Render(text)
}

func (m model) laneRow(i int, g geometry) string {
	lane := m.lanes[i]
	mark := " "
	if i == m.sel {
		mark = markSelected
	}
	name := fmt.Sprintf("%-*s", nameWidth-3, lane.ID)
	summary := "off"
	if lane.Enabled {
		summary = m.usage[lane.ID].Session
	}
	summary = ansi.Truncate(summary, g.summary, ellipsis)
	switch {
	case !lane.Enabled:
		name, summary = m.st.dim.Render(name), m.st.dim.Render(summary)
	case i == m.sel:
		name = m.st.bold.Render(name)
	}
	return mark + " " + name + " " + m.cells(i, g) + " " + summary
}

// cells draws one lane. A cell shows the kind at its middle minute. The next
// tick replaces its cell, and the hour cursor shows in reverse on the
// selected lane.
func (m model) cells(i int, g geometry) string {
	lane := m.lanes[i]
	start := dayStart(m.now)
	next := -1
	if lane.Enabled && !lane.Next.IsZero() {
		next = g.cell(start, lane.Next)
	}
	var b strings.Builder
	seg := 0
	for c := range g.lane {
		mid := start.Add(time.Duration((2*c+1)*minutesPerDay/(2*g.lane)) * time.Minute)
		for seg < len(lane.Segments)-1 && !mid.Before(lane.Segments[seg].End) {
			seg++
		}
		kind := lane.Segments[seg].Kind
		glyph, style := glyphs[kind], m.st.cells[kind]
		if c == next {
			glyph, style = glyphNext, m.st.next
		}
		if i == m.sel && c/g.cph == m.cursor {
			style = style.Inherit(m.st.cursor)
		}
		b.WriteString(style.Render(glyph))
	}
	return b.String()
}

func (m model) legend() string {
	item := func(glyph string, s lipgloss.Style, text string) string { return s.Render(glyph) + " " + text }
	return pad(nameWidth) + strings.Join([]string{
		item(glyphs[warmup.SegmentArmed], m.st.cells[warmup.SegmentArmed], "armed"),
		item(glyphs[warmup.SegmentPredicted], m.st.cells[warmup.SegmentPredicted], "predicted"),
		item(glyphs[warmup.SegmentWork], m.st.cells[warmup.SegmentWork], "work hours"),
		item(glyphs[warmup.SegmentOff], m.st.cells[warmup.SegmentOff], "off"),
		item(glyphNext, m.st.next, "next tick"),
	}, "  ")
}

func pad(n int) string { return strings.Repeat(" ", n) }
