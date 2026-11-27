package domain

import "time"

// SessionWindow is the length of the anchored usage window every supported plan
// resets on. A successful arm inside it counts as an active window.
const SessionWindow = 5 * time.Hour

// LimitBlock is one quota block: the five-hour session, the week, or a
// per-model week. Pct is nil when the provider shows no percentage.
type LimitBlock struct {
	Pct      *int      `json:"pct"`
	ResetsAt time.Time `json:"resetsAt,omitzero"`
	Active   bool      `json:"active,omitempty"`
}

// ModelLimitBlock is the extra weekly block Claude shows for the model it caps
// separately. Label is the model name from the heading, for example "Fable".
type ModelLimitBlock struct {
	LimitBlock
	Label string `json:"label"`
}

// Usage is one provider's quota snapshot, from a live probe or inferred from
// the cache. Inferred snapshots carry Pct 1 or 0 as an active flag, not a percentage.
type Usage struct {
	Session    *LimitBlock      `json:"session,omitempty"`
	Week       *LimitBlock      `json:"week,omitempty"`
	WeekModel  *ModelLimitBlock `json:"weekModel,omitempty"`
	CapturedAt time.Time        `json:"capturedAt,omitzero"`
	Inferred   bool             `json:"inferred,omitempty"`
}

type Action string

const (
	ActionWarm         Action = "warm"
	ActionSkipOffhours Action = "skip-offhours"
	ActionSkipWeekly   Action = "skip-weekly"
	ActionSkipActive   Action = "skip-active"
)

type Decision struct {
	Action Action `json:"action"`
	Reason string `json:"reason"`
}

type CachedDecision struct {
	Decision
	At time.Time `json:"at"`
}

// CacheEntry is one provider's record in usage-cache.json: the last probed
// usage, the last decision, and the arm bookkeeping that decide() reads.
type CacheEntry struct {
	Usage
	LastDecision  *CachedDecision `json:"lastDecision,omitempty"`
	LastWarmAt    time.Time       `json:"lastWarmAt,omitzero"`
	CooldownUntil time.Time       `json:"cooldownUntil,omitzero"`
	LastFailureAt time.Time       `json:"lastFailureAt,omitzero"`
}

// Cache is the whole of usage-cache.json.
type Cache struct {
	Providers map[ProviderID]CacheEntry `json:"providers"`
}
