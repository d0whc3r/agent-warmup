package provider

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// UsageView is one provider's usage as display strings.
type UsageView struct {
	Session string
	Week    string
	Age     string // "45m ago" or "3h ago", or "" when CapturedAt is unknown
}

const noValue = "—"

// FormatUsage renders entry for pc.ID. An entry without a session and a week
// (no live probe yet, or an estimated provider) is inferred from its last arm,
// the same way the tick does.
func FormatUsage(pc ProbeContext, entry domain.CacheEntry) UsageView {
	u := entry.Usage
	if u.Session == nil && u.Week == nil {
		u = Get(pc.ID).InferFromCache(pc, entry)
	}
	view := UsageView{Session: formatSession(u), Week: noValue}
	if w := u.Week; w != nil {
		view.Week = pctText(w.Pct) + "%"
		if !w.ResetsAt.IsZero() {
			view.Week += " · resets " + w.ResetsAt.Local().Format("Jan 2 15:04")
		}
	}
	if !u.CapturedAt.IsZero() {
		view.Age = formatAge(pc.Now.Sub(u.CapturedAt))
	}
	return view
}

// formatSession describes an inferred window instead of printing its Pct,
// which is only an active flag.
func formatSession(u domain.Usage) string {
	s := u.Session
	if u.Inferred {
		if s != nil && s.Active {
			return "active (estimated) · resets " + formatClock(s.ResetsAt, "?")
		}
		return "idle (estimated)"
	}
	if s == nil {
		return noValue
	}
	text := pctText(s.Pct) + "%"
	if !s.Active {
		text += " (idle)"
	}
	if !s.ResetsAt.IsZero() {
		text += " · resets " + formatClock(s.ResetsAt, "")
	}
	return text
}

func pctText(pct *int) string {
	if pct == nil {
		return noValue
	}
	return strconv.Itoa(*pct)
}

// formatAge renders an elapsed time as "Nm ago" under an hour, else "Nh ago".
func formatAge(d time.Duration) string {
	minutes := int(d.Minutes())
	if minutes < 60 {
		return fmt.Sprintf("%dm ago", minutes)
	}
	return fmt.Sprintf("%dh ago", int(math.Round(float64(minutes)/60)))
}
