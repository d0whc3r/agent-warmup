package config

import (
	"strings"
	"testing"
)

// An earlier Go build wrote these keys; Load drops them and rewrites the file.
func TestLoadDropsObsoleteKeys(t *testing.T) {
	p := testPaths(t)
	logs := captureLog(t)
	writeFile(t, p.Config, `mode = 'smart'
scheduler = 'launchd'
selected_provider = 'claude'
tick_minutes = 30

[providers.claude]
enabled = true
model = 'sonnet'
tmux_session = 'claude-warmup'
schedule = [8, 13, 18]
`)

	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := cfg.Providers["claude"].Model; got != "sonnet" {
		t.Errorf("model = %q, want sonnet", got)
	}

	rewritten := readFile(t, p.Config)
	for _, key := range []string{"mode", "scheduler", "selected_provider", "tick_minutes", "providers.claude.tmux_session", "providers.claude.schedule"} {
		leaf := key[strings.LastIndex(key, ".")+1:]
		if strings.Contains(rewritten, leaf+" =") {
			t.Errorf("rewritten config still has %s", leaf)
		}
		if !strings.Contains(logs.String(), key) {
			t.Errorf("log does not name dropped key %s", key)
		}
	}

	if _, err := Load(p); err != nil {
		t.Fatalf("second Load: %v", err)
	}
}
