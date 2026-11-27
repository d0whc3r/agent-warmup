// Package domain holds the types shared by every other package: provider ids,
// the typed configuration, usage snapshots, decisions, and cache entries.
package domain

import (
	"fmt"
	"slices"
	"strings"
)

type ProviderID string

const (
	Claude   ProviderID = "claude"
	Codex    ProviderID = "codex"
	Zai      ProviderID = "zai"
	Kimi     ProviderID = "kimi"
	Opencode ProviderID = "opencode"
	Minimax  ProviderID = "minimax"
	Agy      ProviderID = "agy"
)

// ProviderIDs is every built-in provider in display and iteration order.
var ProviderIDs = []ProviderID{Claude, Codex, Zai, Kimi, Opencode, Minimax, Agy}

func ParseProviderID(s string) (ProviderID, error) {
	id := ProviderID(s)
	if !slices.Contains(ProviderIDs, id) {
		return "", fmt.Errorf("unknown provider %q (want one of %s)", s, joinIDs(ProviderIDs))
	}
	return id, nil
}

func joinIDs(ids []ProviderID) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = string(id)
	}
	return strings.Join(parts, ", ")
}

// HoursPerDay bounds every hour setting: an hour is 0 to HoursPerDay-1, and
// work_end, which is exclusive, goes up to HoursPerDay.
const HoursPerDay = 24

// TmuxSession is the tmux session that arms id. The usage probe adds "-usage".
func (id ProviderID) TmuxSession() string { return "agent-warmup-" + string(id) }

// ProviderConfig is one [providers.<id>] table of config.toml.
type ProviderConfig struct {
	Enabled           bool   `toml:"enabled"`
	Binary            string `toml:"binary"`
	Model             string `toml:"model"`
	WorkStart         int    `toml:"work_start"`
	WorkEnd           int    `toml:"work_end"`
	WeeklyStopPercent int    `toml:"weekly_stop_percent"`
}

// Config is the whole of config.toml.
type Config struct {
	Providers map[ProviderID]ProviderConfig `toml:"providers"`
}

// Enabled returns the enabled provider ids in ProviderIDs order.
func (c Config) Enabled() []ProviderID {
	var ids []ProviderID
	for _, id := range ProviderIDs {
		if c.Providers[id].Enabled {
			ids = append(ids, id)
		}
	}
	return ids
}
