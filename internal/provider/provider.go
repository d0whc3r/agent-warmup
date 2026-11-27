// Package provider defines what differs per coding agent: how to probe usage,
// how to decide whether to arm, and the script that arms. Every implementation
// lives in this package and is listed in registry.
package provider

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

type ProbeKind string

const (
	ProbeLive      ProbeKind = "live"      // reads real quota data
	ProbeEstimated ProbeKind = "estimated" // infers the window from the last successful arm
)

// ErrNoLiveProbe is what Probe returns for a ProbeEstimated provider. The tick
// then uses InferFromCache without logging a failure.
var ErrNoLiveProbe = errors.New("provider has no live usage probe")

// ProbeContext is the input of every Provider method that needs config or time.
type ProbeContext struct {
	ID    domain.ProviderID
	Cfg   domain.ProviderConfig
	Now   time.Time
	Paths paths.Paths
}

type Provider interface {
	ID() domain.ProviderID
	Name() string           // display name, for example "Claude Code"
	ModelChoices() []string // suggested models (the config accepts any model id)
	ProbeKind() ProbeKind
	// CredentialKey is the opencode auth.json key of a plan that runs through the
	// opencode binary ("zai-coding-plan", "minimax-coding-plan", "opencode-go").
	// Detection requires that key. It is "" for providers with their own CLI.
	CredentialKey() string

	// Probe reads current usage. Any error makes the tick fall back to InferFromCache.
	Probe(ctx context.Context, pc ProbeContext) (domain.Usage, error)
	// InferFromCache estimates usage when no live data exists: an arm inside
	// domain.SessionWindow counts as an active window.
	InferFromCache(pc ProbeContext, entry domain.CacheEntry) domain.Usage
	// Decide is pure: warm or skip, with the reason. entry carries
	// LastWarmAt and CooldownUntil.
	Decide(pc ProbeContext, u domain.Usage, entry domain.CacheEntry) domain.Decision
	// ArmScript is the embedded bash script that arms one usage window.
	ArmScript() []byte
	// ArmEnv is the provider-specific environment for the arm script, added to
	// the common WARMUP_BIN, WARMUP_MODEL, WARMUP_TMUX_SESSION, and WARMUP_HOME.
	ArmEnv(pc ProbeContext) map[string]string
	// RecordArm returns the cache entry after an arm that exited with status,
	// and a log line ("" for none).
	RecordArm(pc ProbeContext, entry domain.CacheEntry, status int) (domain.CacheEntry, string)
}

// registry holds every built-in provider, keyed by id. It must hold an entry
// for each id in domain.ProviderIDs.
var registry = map[domain.ProviderID]Provider{
	domain.Claude: claude{base{
		id: domain.Claude, name: "Claude Code",
		models: []string{"haiku", "sonnet", "opus"},
		script: armClaude,
	}},
	domain.Codex: codex{base{
		id: domain.Codex, name: "OpenAI Codex",
		models: []string{"gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"},
		binEnv: "CODEX_BIN", script: armCodex,
	}},
	domain.Zai: base{
		id: domain.Zai, name: "Z.AI GLM Coding Plan",
		models:  []string{"zai-coding-plan/glm-5.3-flash", "zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-highspeed"},
		planKey: "zai-coding-plan", binEnv: "OPENCODE_BIN", script: armOpencode,
	},
	domain.Kimi: base{
		id: domain.Kimi, name: "Kimi Code",
		models: []string{"kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"},
		binEnv: "KIMI_BIN", script: armKimi,
	},
	domain.Opencode: opencode{base{
		id: domain.Opencode, name: "OpenCode Go",
		models:  []string{"opencode-go/deepseek-v4-flash", "opencode-go/glm-5.3-flash", "opencode-go/kimi-k2.7-code"},
		planKey: "opencode-go", binEnv: "OPENCODE_BIN", script: armOpencode,
	}},
	domain.Minimax: base{
		id: domain.Minimax, name: "MiniMax Token Plan",
		models:  []string{"minimax-coding-plan/MiniMax-M2.7", "minimax-coding-plan/MiniMax-M2.7-highspeed", "minimax-coding-plan/MiniMax-M3"},
		planKey: "minimax-coding-plan", binEnv: "OPENCODE_BIN", script: armOpencode,
	},
	domain.Agy: base{
		id: domain.Agy, name: "Antigravity CLI",
		models: []string{"gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-neon"},
		binEnv: "AGY_BIN", script: armAgy,
	},
}

// Get returns the provider for id. An id comes from domain.ParseProviderID or
// domain.ProviderIDs, so a missing entry is a programming error.
func Get(id domain.ProviderID) Provider {
	p, ok := registry[id]
	if !ok {
		panic(fmt.Sprintf("provider %q is not registered", id))
	}
	return p
}

// Current probes p and falls back to InferFromCache. live is false for the
// fallback and for a probe that could only infer (opencode stats without
// spend), so a caller stores the snapshot only when live is true.
func Current(ctx context.Context, p Provider, pc ProbeContext, entry domain.CacheEntry) (u domain.Usage, live bool) {
	u, err := p.Probe(ctx, pc)
	if err == nil && !u.Inferred {
		return u, true
	}
	if err != nil && !errors.Is(err, ErrNoLiveProbe) {
		slog.Warn("probe failed, so the usage comes from the cache", "provider", pc.ID, "err", err)
	}
	return p.InferFromCache(pc, entry), false
}
