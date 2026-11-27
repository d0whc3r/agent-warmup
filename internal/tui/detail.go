package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// detailView describes the selected agent in h lines: its settings, usage,
// next tick, and its newest log lines first.
func (m model) detailView(w, h int) []string {
	id, pc, lane := m.selAgent(), m.selCfg(), m.selLane()
	lines := []string{
		m.detailRule(w),
		"model " + pc.Model + " · work " + workText(pc) + " · weekly stop " + fmt.Sprintf("%d%%", pc.WeeklyStopPercent),
		"binary " + pc.Binary,
	}
	if pc.Enabled {
		u := m.usage[id]
		usage := "usage " + u.Session + " · week " + u.Week
		if u.Age != "" {
			usage += " · read " + u.Age
		}
		lines = append(lines, usage, m.nextText(lane))
	} else {
		lines = append(lines, m.st.dim.Render(markOff+" off · press space to turn it on"))
	}

	var log []string
	if m.snap != nil {
		entries := warmup.AgentLog(id, m.snap.Log)
		for i := len(entries) - 1; i >= 0 && len(log) < h-len(lines); i-- {
			log = append(log, m.st.dim.Render(m.stamp(entries[i].At))+" "+entries[i].Text)
		}
	}
	if len(log) == 0 {
		log = []string{m.st.dim.Render("no log lines for " + string(id) + " yet")}
	}
	return fitLines(truncLines(append(lines, log...), w), h)
}

// detailRule is the heading line: "─ claude · Claude Code · ● on ───".
func (m model) detailRule(w int) string {
	id := m.selAgent()
	head := "─ " + strings.Join([]string{string(id), provider.Get(id).Name(), enabledText(m)}, " · ") + " "
	return m.st.bold.Render(head) + m.st.rule.Render(strings.Repeat("─", max(w-len([]rune(head)), 0)))
}

// nextText names the next warmup and what the next tick decides.
func (m model) nextText(lane warmup.Lane) string {
	if lane.Next.IsZero() {
		return "no tick scheduled"
	}
	text := fmt.Sprintf("tick %s %s: %s", m.clock(lane.Next), lane.Decision.Action, lane.Decision.Reason)
	if lane.NextWarm.IsZero() {
		return "no warmup in the next 24h · " + text
	}
	return "next warmup " + m.clock(lane.NextWarm) + " · " + text
}

// clock is "15:04" today and "tomorrow 15:04" after midnight.
func (m model) clock(t time.Time) string {
	if dayStart(t).Equal(dayStart(m.now)) {
		return t.Format("15:04")
	}
	return "tomorrow " + t.Format("15:04")
}

// stamp is a log time: "15:04" today, "Jan 2 15:04" before.
func (m model) stamp(t time.Time) string {
	switch {
	case t.IsZero():
		return "     "
	case dayStart(t).Equal(dayStart(m.now)):
		return t.Format("15:04")
	}
	return t.Format("Jan 2 15:04")
}
