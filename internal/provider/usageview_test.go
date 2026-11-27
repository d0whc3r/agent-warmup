package provider

import (
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

func TestFormatUsage(t *testing.T) {
	now := local(2026, 6, 13, 13, 0)
	cases := []struct {
		name  string
		id    domain.ProviderID
		entry domain.CacheEntry
		want  UsageView
	}{
		{
			name: "live active session",
			id:   domain.Claude,
			entry: domain.CacheEntry{Usage: domain.Usage{
				Session:    &domain.LimitBlock{Pct: intPtr(30), Active: true, ResetsAt: local(2026, 6, 13, 15, 30)},
				Week:       &domain.LimitBlock{Pct: intPtr(4), ResetsAt: local(2026, 6, 14, 11, 0)},
				CapturedAt: now.Add(-45 * time.Minute),
			}},
			want: UsageView{Session: "30% · resets 15:30", Week: "4% · resets Jun 14 11:00", Age: "45m ago"},
		},
		{
			name:  "live idle session without week",
			id:    domain.Claude,
			entry: domain.CacheEntry{Usage: domain.Usage{Session: &domain.LimitBlock{Pct: intPtr(40)}}},
			want:  UsageView{Session: "40% (idle)", Week: "—"},
		},
		{
			name: "missing percentage",
			id:   domain.Claude,
			entry: domain.CacheEntry{Usage: domain.Usage{
				Session:    &domain.LimitBlock{Active: true, ResetsAt: local(2026, 6, 13, 15, 30)},
				CapturedAt: now.Add(-150 * time.Minute),
			}},
			want: UsageView{Session: "—% · resets 15:30", Week: "—", Age: "3h ago"},
		},
		{
			name:  "estimated provider armed recently",
			id:    domain.Kimi,
			entry: domain.CacheEntry{LastWarmAt: now.Add(-time.Minute)},
			want:  UsageView{Session: "active (estimated) · resets 17:59", Week: "—"},
		},
		{
			name:  "estimated provider never armed",
			id:    domain.Zai,
			entry: domain.CacheEntry{},
			want:  UsageView{Session: "idle (estimated)", Week: "—"},
		},
	}
	for i := range cases {
		tc := &cases[i]
		t.Run(tc.name, func(t *testing.T) {
			if got := FormatUsage(pcAt(tc.id, now), tc.entry); got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
