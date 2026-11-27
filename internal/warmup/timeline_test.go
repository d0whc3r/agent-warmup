package warmup

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
)

// day27 is a time on the test day, 2026-11-27, in local time.
func day27(h, m int) time.Time { return time.Date(2026, 11, 27, h, m, 0, 0, time.Local) }

// laneText renders segments as "kind hh:mm-hh:mm" items, so a failure reads like the lane.
func laneText(segs []Segment) string {
	parts := make([]string, len(segs))
	for i, s := range segs {
		end := s.End.Format("15:04")
		if s.End.Day() != s.Start.Day() {
			end = "24:00"
		}
		parts[i] = fmt.Sprintf("%s %s-%s", s.Kind, s.Start.Format("15:04"), end)
	}
	return strings.Join(parts, ", ")
}

// onlyAgent enables id alone, from 08 to 23.
func onlyAgent(id domain.ProviderID) domain.Config {
	cfg := config.WithProvider(config.Defaults(), domain.Claude, func(pc *domain.ProviderConfig) { pc.Enabled = false })
	return config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) {
		pc.Enabled, pc.WorkStart, pc.WorkEnd = true, 8, 23
	})
}

func pct(n int) *int { return &n }

func TestTimeline(t *testing.T) {
	liveSession := domain.CacheEntry{Usage: domain.Usage{
		Session: &domain.LimitBlock{Pct: pct(42), Active: true, ResetsAt: day27(15, 30)},
		Week:    &domain.LimitBlock{Pct: pct(18)},
	}}
	weeklyCapped := domain.CacheEntry{Usage: domain.Usage{Week: &domain.LimitBlock{Pct: pct(95)}}}
	yesterdayArm := []logs.Entry{{At: day27(22, 0).AddDate(0, 0, -1), Text: "DONE claude (status=0)"}}

	cases := []struct {
		name     string
		id       domain.ProviderID
		entry    domain.CacheEntry
		events   []logs.Entry
		now      time.Time
		want     string
		next     time.Time
		decision domain.Action
		warm     time.Time
	}{
		{
			name: "live window", id: domain.Claude, entry: liveSession, now: day27(13, 42),
			want: "off 00:00-08:00, work 08:00-10:30, armed 10:30-15:30, predicted 15:30-24:00",
			next: day27(13, 45), decision: domain.ActionSkipActive, warm: day27(15, 30),
		},
		{
			name: "no cache", id: domain.Codex, now: day27(13, 42),
			want: "off 00:00-08:00, work 08:00-13:45, predicted 13:45-23:45, off 23:45-24:00",
			next: day27(13, 45), decision: domain.ActionWarm, warm: day27(13, 45),
		},
		{
			name: "weekly stop", id: domain.Claude, entry: weeklyCapped, now: day27(13, 42),
			want: "off 00:00-08:00, work 08:00-23:00, off 23:00-24:00",
			next: day27(13, 45), decision: domain.ActionSkipWeekly,
		},
		{
			name: "window crosses midnight", id: domain.Claude, events: yesterdayArm, now: day27(2, 0),
			want: "armed 00:00-03:00, off 03:00-08:00, predicted 08:00-23:00, off 23:00-24:00",
			next: day27(8, 0), decision: domain.ActionWarm, warm: day27(8, 0),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{tc.id: tc.entry}}
			lanes := Timeline(onlyAgent(tc.id), c, tc.events, tc.now)
			lane := lanes[slices.Index(domain.ProviderIDs, tc.id)]
			if got := laneText(lane.Segments); got != tc.want {
				t.Errorf("segments:\n got %s\nwant %s", got, tc.want)
			}
			if !lane.Next.Equal(tc.next) || lane.Decision.Action != tc.decision {
				t.Errorf("next = %s %s, want %s %s", lane.Next.Format("15:04"), lane.Decision.Action, tc.next.Format("15:04"), tc.decision)
			}
			if !lane.NextWarm.Equal(tc.warm) {
				t.Errorf("next warm = %s, want %s", lane.NextWarm, tc.warm)
			}
		})
	}
}

func TestTimelineDisabledAgent(t *testing.T) {
	lanes := Timeline(onlyAgent(domain.Claude), domain.Cache{}, nil, day27(13, 42))
	kimi := lanes[slices.Index(domain.ProviderIDs, domain.Kimi)]
	if kimi.Enabled || !kimi.Next.IsZero() {
		t.Errorf("disabled lane = %+v, want disabled with no next tick", kimi)
	}
	if got, want := laneText(kimi.Segments), "off 00:00-24:00"; got != want {
		t.Errorf("segments = %s, want %s", got, want)
	}
}

func TestAgentLog(t *testing.T) {
	entries := []logs.Entry{
		{Text: "TICK [claude] warm — no active window [via probe]"},
		{Text: "START codex (model=gpt)"},
		{Text: "OK: Claude Code replied -> usage window armed"},
		{Text: "DONE claude (status=0)"},
		{Text: "DONE codex (status=0)"},
	}
	got := AgentLog(domain.Claude, entries)
	want := []logs.Entry{entries[0], entries[2], entries[3]}
	if !slices.Equal(got, want) {
		t.Errorf("AgentLog = %+v, want %+v", got, want)
	}
}
