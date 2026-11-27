package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// codex reads the rate limits that codex logs into its rollout files. Codex
// has no quota command, and these files are the only place it records them.
type codex struct{ base }

// rolloutsScanned is how many of the newest rollouts the probe opens. The
// newest normally answers. The rest cover a session that died before its
// first token_count event.
const rolloutsScanned = 5

type codexWindow struct {
	UsedPercent *float64 `json:"used_percent"`
	ResetsAt    float64  `json:"resets_at"` // epoch seconds, 0 means unknown
}

type codexEvent struct {
	Timestamp string `json:"timestamp"`
	Payload   struct {
		RateLimits *struct {
			Primary   *codexWindow `json:"primary"`
			Secondary *codexWindow `json:"secondary"`
		} `json:"rate_limits"`
	} `json:"payload"`
}

func (codex) ProbeKind() ProbeKind { return ProbeLive }

// rolloutDepth is the YYYY/MM/DD directories above each rollout file.
const rolloutDepth = 3

// Probe reads the newest rollouts under Paths.CodexSessions.
func (codex) Probe(ctx context.Context, pc ProbeContext) (domain.Usage, error) {
	dir := pc.Paths.CodexSessions
	rollouts, err := newestRollouts(dir, rolloutDepth, rolloutsScanned)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("list codex rollouts: %w", err)
	}

	// An unreadable or half-written rollout falls through to the next newest.
	var errs []error
	for _, path := range rollouts {
		if err := ctx.Err(); err != nil {
			return domain.Usage{}, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if u, ok := parseCodexRateLimits(string(data), pc.Now); ok {
			return u, nil
		}
	}
	err = fmt.Errorf("no rate limits in the %d newest codex rollouts under %s", len(rollouts), dir)
	return domain.Usage{}, errors.Join(append([]error{err}, errs...)...)
}

// newestRollouts returns up to limit rollout paths under dir, newest first.
// Rollout paths are YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl, so names in
// descending order are newest first. It lists one directory level at a time
// and stops at limit, because codex never prunes the tree.
func newestRollouts(dir string, depth, limit int) ([]string, error) {
	entries, err := os.ReadDir(dir) // sorted by name
	if err != nil {
		return nil, err
	}
	slices.Reverse(entries)
	var out []string
	for _, e := range entries {
		if len(out) >= limit {
			break
		}
		path := filepath.Join(dir, e.Name())
		if depth == 0 {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
				out = append(out, path)
			}
			continue
		}
		if !e.IsDir() {
			continue
		}
		more, err := newestRollouts(path, depth-1, limit-len(out))
		if err != nil {
			return nil, err
		}
		out = append(out, more...)
	}
	return out, nil
}

// parseCodexRateLimits reads the last line that carries rate limits: primary
// is the five-hour session, secondary the week.
func parseCodexRateLimits(text string, now time.Time) (domain.Usage, bool) {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !strings.Contains(line, `"rate_limits"`) {
			continue
		}
		var ev codexEvent
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		limits := ev.Payload.RateLimits
		if limits == nil || (limits.Primary == nil && limits.Secondary == nil) {
			continue
		}

		u := domain.Usage{
			Session:    codexBlock(limits.Primary),
			Week:       codexBlock(limits.Secondary),
			CapturedAt: now,
		}
		if s := u.Session; s != nil {
			s.Active = s.Pct != nil && *s.Pct > 0 && s.ResetsAt.After(now)
		}
		if stamp, err := time.Parse(time.RFC3339Nano, ev.Timestamp); err == nil {
			u.CapturedAt = stamp
		}
		return u, true
	}
	return domain.Usage{}, false
}

func codexBlock(w *codexWindow) *domain.LimitBlock {
	if w == nil {
		return nil
	}
	block := &domain.LimitBlock{}
	if w.UsedPercent != nil {
		block.Pct = intPtr(int(math.Round(*w.UsedPercent)))
	}
	if w.ResetsAt != 0 {
		block.ResetsAt = time.Unix(int64(w.ResetsAt), 0)
	}
	return block
}
