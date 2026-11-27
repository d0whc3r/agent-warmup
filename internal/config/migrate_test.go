package config

import (
	"bytes"
	"log/slog"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

func multiEnv() string {
	return strings.Join([]string{
		"# agent-warmup configuration",
		"WARMUP_MODE=fixed",
		"WARMUP_SCHEDULER=launchd",
		"WARMUP_TICK_MINUTES=17",
		"WARMUP_PROVIDERS=codex,kimi",
		"WARMUP_SELECTED_PROVIDER=codex",
		"",
		"WARMUP_CLAUDE_ENABLED=true", // not in WARMUP_PROVIDERS, so disabled
		"WARMUP_CODEX_ENABLED=true",
		"WARMUP_CODEX_BIN=/opt/codex",
		"WARMUP_CODEX_MODEL=gpt-5.6-sol",
		"WARMUP_CODEX_TMUX_SESSION=cx",
		"WARMUP_CODEX_WORK_START=9",
		"WARMUP_CODEX_WORK_END=18",
		"WARMUP_CODEX_WEEKLY_STOP_PERCENT=70",
		"WARMUP_CODEX_SCHEDULE=7,9,22",
		"WARMUP_KIMI_ENABLED=true",
		"WARMUP_ZAI_ENABLED=true", // enabled flag but not listed, so disabled
	}, "\n")
}

func TestMigrateMultiProviderEnv(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.LegacyEnv, multiEnv())
	writeFile(t, p.Cache, `{"providers":{"codex":{"lastWarmAt":1234}}}`)

	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Enabled(); !slices.Equal(got, []domain.ProviderID{domain.Codex, domain.Kimi}) {
		t.Errorf("enabled = %v, want [codex kimi]", got)
	}
	want := domain.ProviderConfig{
		Enabled: true, Binary: "/opt/codex", Model: "gpt-5.6-sol",
		WorkStart: 9, WorkEnd: 18, WeeklyStopPercent: 70,
	}
	if got := cfg.Providers[domain.Codex]; !reflect.DeepEqual(got, want) {
		t.Errorf("codex = %+v, want %+v", got, want)
	}

	if _, err := os.Stat(p.LegacyEnv); !os.IsNotExist(err) {
		t.Errorf("warmup.env still exists: %v", err)
	}
	if got := readFile(t, p.LegacyEnv+".bak"); got != multiEnv() {
		t.Errorf("warmup.env.bak = %q, want the original file", got)
	}
	if _, err := os.Stat(p.Cache + ".bak"); err != nil {
		t.Errorf("old cache not backed up: %v", err)
	}
	reloaded, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Providers[domain.Codex].Model != "gpt-5.6-sol" {
		t.Errorf("config.toml does not hold the converted values")
	}
}

func TestMigrateFlatLegacyEnv(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.LegacyEnv, strings.Join([]string{
		"# a comment",
		"",
		"WARMUP_MODE=fixed",
		"WARMUP_MODEL = opus  # cheapest that fits",
		`WARMUP_TMUX_SESSION="my-sess"`,
		"WARMUP_SCHEDULE=7,9",
		"WARMUP_WORK_START=9",
		"WARMUP_WORK_END=18",
		"WARMUP_WEEKLY_STOP_PERCENT=80",
	}, "\n"))

	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	claude := cfg.Providers[domain.Claude]
	if claude.Model != "opus" || claude.WorkStart != 9 || claude.WorkEnd != 18 || claude.WeeklyStopPercent != 80 {
		t.Errorf("claude=%+v", claude)
	}
	if got := cfg.Enabled(); !slices.Equal(got, []domain.ProviderID{domain.Claude}) {
		t.Errorf("enabled = %v, want only claude", got)
	}
}

func TestMigrateTwiceIsNoop(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.LegacyEnv, multiEnv())
	first, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	config, backup := readFile(t, p.Config), readFile(t, p.LegacyEnv+".bak")

	second, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if readFile(t, p.Config) != config || readFile(t, p.LegacyEnv+".bak") != backup {
		t.Error("a second Load changed config.toml or warmup.env.bak")
	}
	if first.Providers[domain.Codex].Model != second.Providers[domain.Codex].Model {
		t.Error("a second Load returned a different config")
	}
}

func TestMigrateInvalidEnvKeepsFile(t *testing.T) {
	tests := []struct{ name, env, want string }{
		{"not a number", "WARMUP_WORK_START=soon", "WARMUP_WORK_START"},
		{"not allowed", "WARMUP_WEEKLY_STOP_PERCENT=150", "weekly_stop_percent"},
		{"unknown provider", "WARMUP_PROVIDERS=claude,bogus", "WARMUP_PROVIDERS"},
		{"bad enabled flag", "WARMUP_PROVIDERS=codex\nWARMUP_CODEX_ENABLED=yes", "WARMUP_CODEX_ENABLED"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := testPaths(t)
			writeFile(t, p.LegacyEnv, tc.env)
			_, err := Load(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Load error = %v, want it to mention %q", err, tc.want)
			}
			if readFile(t, p.LegacyEnv) != tc.env {
				t.Error("warmup.env changed")
			}
			if _, err := os.Stat(p.Config); !os.IsNotExist(err) {
				t.Errorf("config.toml written for an invalid warmup.env: %v", err)
			}
		})
	}
}

// captureLog sends slog to a buffer for the rest of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// TestMigrateDropsRemovedKeys: a key of a removed setting does not fail the
// migration, and each one gets one log line.
func TestMigrateDropsRemovedKeys(t *testing.T) {
	p := testPaths(t)
	log := captureLog(t)
	writeFile(t, p.LegacyEnv, multiEnv()+"\nWARMUP_SCHEDULE=8,noon\nWARMUP_TMUX_SESSION=a b")
	if _, err := Load(p); err != nil {
		t.Fatal(err)
	}
	dropped := []string{
		"WARMUP_MODE", "WARMUP_SCHEDULER", "WARMUP_TICK_MINUTES", "WARMUP_SELECTED_PROVIDER",
		"WARMUP_SCHEDULE", "WARMUP_TMUX_SESSION", "WARMUP_CODEX_SCHEDULE", "WARMUP_CODEX_TMUX_SESSION",
	}
	for _, key := range dropped {
		if got := strings.Count(log.String(), "key="+key+" "); got != 1 {
			t.Errorf("%d log lines for %s, want 1:\n%s", got, key, log)
		}
	}
	if strings.Contains(readFile(t, p.Config), "schedule") {
		t.Error("config.toml holds a dropped key")
	}
}

func TestLegacySessions(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.LegacyEnv+".bak", "WARMUP_TMUX_SESSION=mine\nWARMUP_KIMI_TMUX_SESSION=k\nWARMUP_CODEX_TMUX_SESSION=codex-warmup")
	got := LegacySessions(p)
	want := []string{"claude-warmup", "codex-warmup", "zai-warmup", "kimi-warmup", "opencode-warmup", "minimax-warmup", "agy-warmup", "mine", "k"}
	if !slices.Equal(got, want) {
		t.Errorf("LegacySessions = %v, want %v", got, want)
	}
}
