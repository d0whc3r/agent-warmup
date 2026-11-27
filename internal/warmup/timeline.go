package warmup

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
)

// SegmentKind is what one stretch of an agent's day holds. A later kind in
// this list wins where two overlap.
type SegmentKind string

const (
	SegmentOff       SegmentKind = "off"       // outside work hours
	SegmentWork      SegmentKind = "work"      // work hours
	SegmentPredicted SegmentKind = "predicted" // a window the coming ticks will arm
	SegmentArmed     SegmentKind = "armed"     // a window the cache or the log says is armed
)

// Segment is [Start, End) of one kind.
type Segment struct {
	Kind       SegmentKind
	Start, End time.Time
}

// Lane is one agent's day. Segments cover the local day of now in order,
// without gaps. Next is the first scheduled tick after now, within a day,
// and Decision is what that tick decides. NextWarm is the first tick that
// warms. Next and NextWarm are zero when no such tick comes.
type Lane struct {
	ID       domain.ProviderID
	Enabled  bool
	Segments []Segment
	Next     time.Time
	Decision domain.Decision
	NextWarm time.Time
}

// armDone is the line every arm script logs after a successful arm.
const armDone = "DONE %s (status=0)"

// Timeline projects every agent's day from the config, the cache, the recent
// log entries, and now. It runs the same decide as the tick at each coming
// scheduled tick, so the predicted windows follow the provider rules. It
// does no I/O.
func Timeline(cfg domain.Config, c domain.Cache, events []logs.Entry, now time.Time) []Lane {
	y, mo, d := now.Date()
	dayStart := time.Date(y, mo, d, 0, 0, 0, 0, now.Location())
	dayEnd := dayStart.AddDate(0, 0, 1)
	ticks := scheduler.Ticks(cfg, now.Add(time.Second), now.Add(domain.HoursPerDay*time.Hour))

	lanes := make([]Lane, len(domain.ProviderIDs))
	for i, id := range domain.ProviderIDs {
		lane := Lane{ID: id, Enabled: cfg.Providers[id].Enabled}
		paint := newPainter(dayStart, dayEnd)
		if !lane.Enabled {
			lane.Segments = paint.segments()
			lanes[i] = lane
			continue
		}
		pc := cfg.Providers[id]
		paint.span(SegmentWork, paint.hour(pc.WorkStart), paint.hour(pc.WorkEnd))
		entry := c.Providers[id]
		for _, at := range armedStarts(id, entry, events) {
			paint.window(SegmentArmed, at)
		}
		predict(paint, &lane, cfg, entry, ticks)
		lane.Segments = paint.segments()
		lanes[i] = lane
	}
	return lanes
}

// armedStarts lists the start of every known window: the successful arms in
// the log, the last arm in the cache, and a live session's start.
func armedStarts(id domain.ProviderID, entry domain.CacheEntry, events []logs.Entry) []time.Time {
	var starts []time.Time
	done := fmt.Sprintf(armDone, id)
	for _, e := range events {
		if e.Text == done && !e.At.IsZero() {
			starts = append(starts, e.At)
		}
	}
	if !entry.LastWarmAt.IsZero() {
		starts = append(starts, entry.LastWarmAt)
	}
	if s := entry.Session; s != nil && !entry.Inferred && s.Active && !s.ResetsAt.IsZero() {
		starts = append(starts, s.ResetsAt.Add(-domain.SessionWindow))
	}
	return starts
}

// predict runs decide at each tick and paints a window for each warm. It
// sets the lane's first tick, its decision, and the first warm.
func predict(p *painter, lane *Lane, cfg domain.Config, entry domain.CacheEntry, ticks []time.Time) {
	prov := lookup(lane.ID)
	for _, t := range ticks {
		pc := provider.ProbeContext{ID: lane.ID, Cfg: cfg.Providers[lane.ID], Now: t}
		d := prov.Decide(pc, projectedUsage(prov, pc, entry), entry)
		if lane.Next.IsZero() {
			lane.Next, lane.Decision = t, d
		}
		if d.Action != domain.ActionWarm {
			continue
		}
		if lane.NextWarm.IsZero() {
			lane.NextWarm = t
		}
		p.window(SegmentPredicted, t)
		entry.LastWarmAt = t
		entry.CooldownUntil = time.Time{}
	}
}

// projectedUsage is the usage a tick at pc.Now would see: the window from the
// last arm (real or projected), a live session that has not reset yet, and
// the last known week.
func projectedUsage(prov provider.Provider, pc provider.ProbeContext, entry domain.CacheEntry) domain.Usage {
	u := prov.InferFromCache(pc, entry)
	if entry.Week != nil {
		u.Week = entry.Week
	}
	s := entry.Session
	live := s != nil && !entry.Inferred && s.Active && s.ResetsAt.After(pc.Now)
	if live && !u.Session.Active {
		u.Session, u.Inferred = s, false
	}
	return u
}

// AgentLog keeps the entries that belong to id: its tick lines ("[id]"), its
// arm script's START and DONE lines, and lines that name the provider.
// ponytail: a WARN line that names the agent by a short name ("Codex warmup
// failed") is missed. The DONE line after it still shows the status.
func AgentLog(id domain.ProviderID, entries []logs.Entry) []logs.Entry {
	marks := []string{"[" + string(id) + "]", "START " + string(id) + " ", "DONE " + string(id) + " ", provider.Get(id).Name()}
	var out []logs.Entry
	for _, e := range entries {
		if slices.ContainsFunc(marks, func(m string) bool { return strings.Contains(e.Text, m) }) {
			out = append(out, e)
		}
	}
	return out
}

// painter holds one kind per minute of the day, so later paints override
// earlier ones by priority.
type painter struct {
	start   time.Time
	minutes []SegmentKind
}

func newPainter(start, end time.Time) *painter {
	n := int(end.Sub(start).Minutes())
	m := make([]SegmentKind, n)
	for i := range m {
		m[i] = SegmentOff
	}
	return &painter{start: start, minutes: m}
}

func (p *painter) hour(h int) time.Time { return p.start.Add(time.Duration(h) * time.Hour) }

func (p *painter) window(kind SegmentKind, at time.Time) {
	p.span(kind, at, at.Add(domain.SessionWindow))
}

// span paints [from, to), clipped to the day. A kind never replaces a kind
// that ranks above it.
func (p *painter) span(kind SegmentKind, from, to time.Time) {
	lo := max(int(from.Sub(p.start).Minutes()), 0)
	hi := min(int(to.Sub(p.start).Minutes()), len(p.minutes))
	for i := lo; i < hi; i++ {
		if rank(kind) > rank(p.minutes[i]) {
			p.minutes[i] = kind
		}
	}
}

func rank(k SegmentKind) int {
	return slices.Index([]SegmentKind{SegmentOff, SegmentWork, SegmentPredicted, SegmentArmed}, k)
}

func (p *painter) segments() []Segment {
	var out []Segment
	for i, k := range p.minutes {
		at := p.start.Add(time.Duration(i) * time.Minute)
		if len(out) > 0 && out[len(out)-1].Kind == k {
			out[len(out)-1].End = at.Add(time.Minute)
			continue
		}
		out = append(out, Segment{Kind: k, Start: at, End: at.Add(time.Minute)})
	}
	return out
}
