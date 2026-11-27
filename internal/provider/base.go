package provider

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

const (
	// Two failures inside failureWindow trip the breaker. It is wider than the
	// slowest tick (60 minutes), so two consecutive failing ticks always count.
	failureWindow = 2 * time.Hour
	cooldown      = time.Hour
	cooldownLog   = "cooldown set (1h after 2 failures in 2h)"
)

// base is a subscription provider whose CLI exposes no quota: one successful
// arm counts as an active window, and failures trip a short circuit breaker.
// zai, kimi, minimax, and agy are a bare base. The other providers embed it
// and override what differs.
type base struct {
	id      domain.ProviderID
	name    string
	models  []string
	planKey string
	binEnv  string // arm script variable that receives the binary path
	script  []byte
}

func (b base) ID() domain.ProviderID  { return b.id }
func (b base) Name() string           { return b.name }
func (b base) ModelChoices() []string { return b.models }
func (b base) ProbeKind() ProbeKind   { return ProbeEstimated }
func (b base) CredentialKey() string  { return b.planKey }
func (b base) ArmScript() []byte      { return b.script }

func (b base) Probe(context.Context, ProbeContext) (domain.Usage, error) {
	return domain.Usage{}, ErrNoLiveProbe
}

func (b base) InferFromCache(pc ProbeContext, entry domain.CacheEntry) domain.Usage {
	return inferWindow(pc.Now, entry)
}

func (b base) Decide(pc ProbeContext, u domain.Usage, entry domain.CacheEntry) domain.Decision {
	return decideWindow(pc, u, entry)
}

func (b base) ArmEnv(pc ProbeContext) map[string]string {
	return map[string]string{
		b.binEnv:               pc.Paths.ExpandHome(pc.Cfg.Binary),
		"WARMUP_PROVIDER":      string(b.id),
		"WARMUP_PROVIDER_NAME": b.name,
	}
}

func (b base) RecordArm(pc ProbeContext, entry domain.CacheEntry, status int) (domain.CacheEntry, string) {
	now := pc.Now
	if status == 0 {
		entry.LastWarmAt = now
		entry.CooldownUntil = time.Time{}
		entry.LastFailureAt = time.Time{}
		return entry, ""
	}
	if !entry.LastFailureAt.IsZero() && now.Sub(entry.LastFailureAt) < failureWindow {
		entry.CooldownUntil = now.Add(cooldown)
		entry.LastFailureAt = time.Time{}
		return entry, cooldownLog
	}
	entry.LastFailureAt = now
	return entry, ""
}

// warmedRecently reports an arm inside domain.SessionWindow.
func warmedRecently(now time.Time, entry domain.CacheEntry) bool {
	return !entry.LastWarmAt.IsZero() && now.Sub(entry.LastWarmAt) < domain.SessionWindow
}

// inferWindow estimates the session from the last arm. Pct is 1 or 0, an
// active flag, and the week is whatever the cache last held.
func inferWindow(now time.Time, entry domain.CacheEntry) domain.Usage {
	active := warmedRecently(now, entry)
	session := &domain.LimitBlock{Pct: intPtr(0), Active: active}
	if active {
		session.Pct = intPtr(1)
		session.ResetsAt = entry.LastWarmAt.Add(domain.SessionWindow)
	}
	return domain.Usage{Session: session, Week: entry.Week, Inferred: true}
}

// decideGates holds the checks every Decide starts with: working hours, then
// the weekly cap. A week whose reset time has passed is stale (an old codex
// rollout) and does not cap. It returns false when neither applies.
func decideGates(pc ProbeContext, u domain.Usage) (domain.Decision, bool) {
	cfg := pc.Cfg
	hour := pc.Now.Local().Hour()
	if hour < cfg.WorkStart || hour >= cfg.WorkEnd {
		reason := fmt.Sprintf("outside working hours %d-%d", cfg.WorkStart, cfg.WorkEnd)
		return domain.Decision{Action: domain.ActionSkipOffhours, Reason: reason}, true
	}
	w := u.Week
	stale := w != nil && !w.ResetsAt.IsZero() && w.ResetsAt.Before(pc.Now)
	if w != nil && !stale && w.Pct != nil && *w.Pct >= cfg.WeeklyStopPercent {
		reason := fmt.Sprintf("weekly %d%% >= %d%%", *w.Pct, cfg.WeeklyStopPercent)
		return domain.Decision{Action: domain.ActionSkipWeekly, Reason: reason}, true
	}
	return domain.Decision{}, false
}

// decideCache adds the cache gates after decideGates: an active cooldown, then
// an arm inside the session window. A probe read from a log file (codex) can
// predate our own arm, so the arm outranks the probe's session flag.
func decideCache(pc ProbeContext, u domain.Usage, entry domain.CacheEntry) (domain.Decision, bool) {
	if d, ok := decideGates(pc, u); ok {
		return d, true
	}
	if entry.CooldownUntil.After(pc.Now) {
		minutes := int(math.Ceil(entry.CooldownUntil.Sub(pc.Now).Minutes()))
		reason := fmt.Sprintf("cooldown (%dm remaining)", minutes)
		return domain.Decision{Action: domain.ActionSkipActive, Reason: reason}, true
	}
	if warmedRecently(pc.Now, entry) {
		return domain.Decision{Action: domain.ActionSkipActive, Reason: reasonCacheActive}, true
	}
	return domain.Decision{}, false
}

const reasonCacheActive = "window likely active (cache-derived)"

func decideWindow(pc ProbeContext, u domain.Usage, entry domain.CacheEntry) domain.Decision {
	if d, ok := decideCache(pc, u, entry); ok {
		return d
	}
	if u.Session != nil && u.Session.Active {
		if u.Inferred {
			return domain.Decision{Action: domain.ActionSkipActive, Reason: reasonCacheActive}
		}
		return activeUntil(u.Session.ResetsAt)
	}
	if u.Inferred {
		return domain.Decision{Action: domain.ActionWarm, Reason: "no recent warmup (usage estimated)"}
	}
	return domain.Decision{Action: domain.ActionWarm, Reason: "no active window"}
}

func activeUntil(resetsAt time.Time) domain.Decision {
	reason := "window active until " + formatClock(resetsAt, "?")
	return domain.Decision{Action: domain.ActionSkipActive, Reason: reason}
}

// formatClock renders t as local "15:04", or fallback for a zero time.
func formatClock(t time.Time, fallback string) string {
	if t.IsZero() {
		return fallback
	}
	return t.Local().Format("15:04")
}

func intPtr(n int) *int { return &n }
