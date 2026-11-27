package provider

import (
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// noon is inside the default 8-23 working band.
var noon = time.Date(2026, 9, 5, 12, 0, 0, 0, time.Local)

func pcAt(id domain.ProviderID, now time.Time) ProbeContext {
	cfg := config.DefaultProvider(id)
	cfg.WorkStart, cfg.WorkEnd, cfg.WeeklyStopPercent = 8, 23, 90
	return ProbeContext{ID: id, Cfg: cfg, Now: now}
}

func week(pct int) *domain.LimitBlock { return &domain.LimitBlock{Pct: intPtr(pct)} }

func activeSession(resets time.Time) *domain.LimitBlock {
	return &domain.LimitBlock{Pct: intPtr(30), ResetsAt: resets, Active: true}
}

type decideCase struct {
	name   string
	now    time.Time
	usage  domain.Usage
	entry  domain.CacheEntry
	action domain.Action
	reason string
}

func runDecide(t *testing.T, id domain.ProviderID, cases []decideCase) {
	t.Helper()
	for i := range cases {
		tc := &cases[i]
		t.Run(tc.name, func(t *testing.T) {
			now := tc.now
			if now.IsZero() {
				now = noon
			}
			got := Get(id).Decide(pcAt(id, now), tc.usage, tc.entry)
			if got.Action != tc.action || got.Reason != tc.reason {
				t.Errorf("Decide = %+v, want {%s %s}", got, tc.action, tc.reason)
			}
		})
	}
}

func TestDecideClaude(t *testing.T) {
	resets := time.Date(2026, 9, 5, 15, 30, 0, 0, time.Local)
	runDecide(t, domain.Claude, []decideCase{
		{
			name: "before work start", now: noon.Add(-9 * time.Hour), usage: domain.Usage{Week: week(5)},
			action: domain.ActionSkipOffhours, reason: "outside working hours 8-23",
		},
		{
			name: "work end is exclusive", now: noon.Add(11 * time.Hour),
			action: domain.ActionSkipOffhours, reason: "outside working hours 8-23",
		},
		{
			name: "weekly at threshold", usage: domain.Usage{Week: week(90)},
			action: domain.ActionSkipWeekly, reason: "weekly 90% >= 90%",
		},
		{
			name: "weekly outranks active window", usage: domain.Usage{Week: week(99), Session: activeSession(resets)},
			action: domain.ActionSkipWeekly, reason: "weekly 99% >= 90%",
		},
		{
			name: "active window", usage: domain.Usage{Week: week(5), Session: activeSession(resets)},
			action: domain.ActionSkipActive, reason: "window active until 15:30",
		},
		{
			name: "idle window", usage: domain.Usage{Week: week(5), Session: &domain.LimitBlock{Pct: intPtr(0)}},
			action: domain.ActionWarm, reason: "no active window",
		},
		{
			name: "inferred without week", usage: domain.Usage{Inferred: true, Session: &domain.LimitBlock{Pct: intPtr(0)}},
			action: domain.ActionWarm, reason: "no recent warmup (probe failed)",
		},
		{
			name: "claude ignores cooldown", entry: domain.CacheEntry{CooldownUntil: noon.Add(time.Hour)},
			action: domain.ActionWarm, reason: "no active window",
		},
	})
}

func TestDecideWindow(t *testing.T) {
	for _, id := range []domain.ProviderID{domain.Codex, domain.Zai, domain.Kimi, domain.Minimax, domain.Agy} {
		t.Run(string(id), func(t *testing.T) {
			runDecide(t, id, windowCases())
		})
	}
}

func windowCases() []decideCase {
	resets := time.Date(2026, 9, 5, 15, 30, 0, 0, time.Local)
	inferredActive := domain.Usage{Inferred: true, Session: &domain.LimitBlock{Pct: intPtr(1), Active: true}}
	return []decideCase{
		{
			name: "offhours", now: noon.Add(-9 * time.Hour),
			action: domain.ActionSkipOffhours, reason: "outside working hours 8-23",
		},
		{
			name: "weekly cap", usage: domain.Usage{Week: week(90)},
			action: domain.ActionSkipWeekly, reason: "weekly 90% >= 90%",
		},
		{
			name: "week that reset in the past is stale", usage: domain.Usage{Week: &domain.LimitBlock{Pct: intPtr(99), ResetsAt: noon.Add(-time.Minute)}},
			action: domain.ActionWarm, reason: "no active window",
		},
		{
			name: "week that resets later still caps", usage: domain.Usage{Week: &domain.LimitBlock{Pct: intPtr(99), ResetsAt: noon.Add(time.Minute)}},
			action: domain.ActionSkipWeekly, reason: "weekly 99% >= 90%",
		},
		{
			name: "weekly outranks cooldown", usage: domain.Usage{Week: week(95)},
			entry:  domain.CacheEntry{CooldownUntil: noon.Add(time.Hour)},
			action: domain.ActionSkipWeekly, reason: "weekly 95% >= 90%",
		},
		{
			name: "cooldown rounds up", entry: domain.CacheEntry{CooldownUntil: noon.Add(2*time.Minute + time.Second)},
			action: domain.ActionSkipActive, reason: "cooldown (3m remaining)",
		},
		{
			name: "cooldown exact minutes", entry: domain.CacheEntry{CooldownUntil: noon.Add(2 * time.Minute)},
			action: domain.ActionSkipActive, reason: "cooldown (2m remaining)",
		},
		{
			name: "cooldown ending now has expired", entry: domain.CacheEntry{CooldownUntil: noon},
			action: domain.ActionWarm, reason: "no active window",
		},
		{
			name:   "expired cooldown falls through to recent arm",
			entry:  domain.CacheEntry{CooldownUntil: noon.Add(-time.Second), LastWarmAt: noon.Add(-time.Hour)},
			action: domain.ActionSkipActive, reason: reasonCacheActive,
		},
		{
			name: "recent arm outranks stale idle probe", usage: domain.Usage{Session: &domain.LimitBlock{Pct: intPtr(0)}},
			entry:  domain.CacheEntry{LastWarmAt: noon.Add(-time.Minute)},
			action: domain.ActionSkipActive, reason: reasonCacheActive,
		},
		{
			name: "arm exactly five hours ago has expired", entry: domain.CacheEntry{LastWarmAt: noon.Add(-domain.SessionWindow)},
			action: domain.ActionWarm, reason: "no active window",
		},
		{
			name: "live active session", usage: domain.Usage{Session: activeSession(resets)},
			action: domain.ActionSkipActive, reason: "window active until 15:30",
		},
		{
			name: "inferred active session", usage: inferredActive,
			action: domain.ActionSkipActive, reason: reasonCacheActive,
		},
		{
			name: "inferred idle", usage: domain.Usage{Inferred: true, Session: &domain.LimitBlock{Pct: intPtr(0)}},
			action: domain.ActionWarm, reason: "no recent warmup (usage estimated)",
		},
		{
			name: "live idle", usage: domain.Usage{Session: &domain.LimitBlock{Pct: intPtr(0)}},
			action: domain.ActionWarm, reason: "no active window",
		},
	}
}

func TestDecideOpencode(t *testing.T) {
	resets := time.Date(2026, 9, 5, 15, 30, 0, 0, time.Local)
	runDecide(t, domain.Opencode, []decideCase{
		{
			name: "offhours", now: noon.Add(-9 * time.Hour),
			action: domain.ActionSkipOffhours, reason: "outside working hours 8-23",
		},
		{
			name: "weekly cap", usage: domain.Usage{Week: week(95)},
			action: domain.ActionSkipWeekly, reason: "weekly 95% >= 90%",
		},
		{
			name: "cooldown", entry: domain.CacheEntry{CooldownUntil: noon.Add(30 * time.Minute)},
			action: domain.ActionSkipActive, reason: "cooldown (30m remaining)",
		},
		{
			name:   "expired cooldown then recent arm",
			entry:  domain.CacheEntry{CooldownUntil: noon.Add(-time.Second), LastWarmAt: noon.Add(-time.Hour)},
			action: domain.ActionSkipActive, reason: reasonCacheActive,
		},
		{
			name: "session flag is not consulted", usage: domain.Usage{Session: activeSession(resets)},
			action: domain.ActionWarm, reason: "no active window probe available",
		},
		{name: "no signals", action: domain.ActionWarm, reason: "no active window probe available"},
	})
}

func TestDecideRecordArm(t *testing.T) {
	cooldownIDs := []domain.ProviderID{domain.Codex, domain.Zai, domain.Kimi, domain.Opencode, domain.Minimax, domain.Agy}
	for _, id := range cooldownIDs {
		t.Run(string(id), func(t *testing.T) { testCooldown(t, id) })
	}
	t.Run("claude", func(t *testing.T) {
		p := Get(domain.Claude)
		failed := domain.CacheEntry{LastFailureAt: noon.Add(-time.Minute)}
		if got, log := p.RecordArm(pcAt(domain.Claude, noon), failed, 1); got != failed || log != "" {
			t.Errorf("failure changed the entry: %+v %q", got, log)
		}
		if got, _ := p.RecordArm(pcAt(domain.Claude, noon), domain.CacheEntry{}, 0); !got.LastWarmAt.Equal(noon) {
			t.Errorf("LastWarmAt = %v, want %v", got.LastWarmAt, noon)
		}
	})
}

func testCooldown(t *testing.T, id domain.ProviderID) {
	p := Get(id)
	record := func(entry domain.CacheEntry, status int, now time.Time) (domain.CacheEntry, string) {
		return p.RecordArm(pcAt(id, now), entry, status)
	}

	first, log := record(domain.CacheEntry{}, 1, noon)
	if log != "" || !first.LastFailureAt.Equal(noon) || !first.CooldownUntil.IsZero() {
		t.Fatalf("first failure: %+v %q", first, log)
	}

	cases := []struct {
		name     string
		after    time.Duration
		wantTrip bool
	}{
		{"second failure 5m later", 5 * time.Minute, true},
		{"second failure one 60m tick later", 61 * time.Minute, true},
		{"just inside the 2h window", 2*time.Hour - time.Second, true},
		{"exactly 2h later starts a new window", 2 * time.Hour, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now := noon.Add(tc.after)
			got, log := record(first, 1, now)
			if !tc.wantTrip {
				if log != "" || !got.LastFailureAt.Equal(now) || !got.CooldownUntil.IsZero() {
					t.Errorf("got %+v %q, want a fresh failure", got, log)
				}
				return
			}
			if log != cooldownLog || !got.CooldownUntil.Equal(now.Add(time.Hour)) || !got.LastFailureAt.IsZero() {
				t.Errorf("got %+v %q, want cooldown until %v", got, log, now.Add(time.Hour))
			}
		})
	}

	t.Run("success clears the breaker", func(t *testing.T) {
		tripped := domain.CacheEntry{LastFailureAt: noon.Add(-time.Second), CooldownUntil: noon.Add(time.Hour)}
		got, log := record(tripped, 0, noon)
		if log != "" || !got.LastWarmAt.Equal(noon) || !got.LastFailureAt.IsZero() || !got.CooldownUntil.IsZero() {
			t.Errorf("got %+v %q", got, log)
		}
	})
}
