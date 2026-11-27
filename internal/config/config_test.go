package config

import (
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

func testPaths(t *testing.T) paths.Paths {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WARMUP_HOME", t.TempDir())
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestDefaults(t *testing.T) {
	cfg := Defaults()
	if err := Validate(cfg); err != nil {
		t.Fatalf("defaults are invalid: %v", err)
	}
	if got := cfg.Enabled(); !slices.Equal(got, []domain.ProviderID{domain.Claude}) {
		t.Errorf("enabled = %v, want only claude", got)
	}

	claude := cfg.Providers[domain.Claude]
	if claude.WorkStart != 8 || claude.WorkEnd != 23 || claude.WeeklyStopPercent != 90 || claude.Model != "haiku" {
		t.Errorf("claude defaults = %+v", claude)
	}
	if got := cfg.Providers[domain.Codex].WeeklyStopPercent; got != 85 {
		t.Errorf("codex weekly_stop_percent = %d, want 85", got)
	}
}

func TestLoadSeedsDefaults(t *testing.T) {
	p := testPaths(t)
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, Defaults()) {
		t.Errorf("Load on an empty home = %+v, want defaults", cfg)
	}
	seeded := readFile(t, p.Config)
	for _, want := range []string{"[providers.claude]", "[providers.agy]", "work_start = 8"} {
		if !strings.Contains(seeded, want) {
			t.Errorf("seeded config lacks %q:\n%s", want, seeded)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	p := testPaths(t)
	cfg := Defaults()
	codex := cfg.Providers[domain.Codex]
	codex.Enabled = true
	codex.WorkEnd = 24
	cfg.Providers[domain.Codex] = codex

	if err := Save(p, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, cfg) {
		t.Errorf("round trip:\n got %+v\nwant %+v", got, cfg)
	}
	info, err := os.Stat(p.Config)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config mode = %o, want 600", perm)
	}
}

func TestLoadKeepsDefaultsForMissingKeys(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.Config, "[providers.codex]\nenabled = true\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	codex := cfg.Providers[domain.Codex]
	if !codex.Enabled || codex.Model != "gpt-5.6-luna" || codex.WorkStart != 8 || !cfg.Providers[domain.Claude].Enabled {
		t.Errorf("partial file merged wrong: codex=%+v", codex)
	}
}

func TestLoadRejectsBadFile(t *testing.T) {
	tests := []struct {
		name, text, want string
	}{
		{"unknown key", "[providers.codex]\nenabeld = true\n", "enabeld"},
		{"unknown top-level key", "surprise = 1\n", "surprise"},
		{"syntax", "[providers.codex]\nmodel = \n", "parse"},
		{"invalid value", "[providers.codex]\nwork_start = 25\n", "providers.codex.work_start"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := testPaths(t)
			writeFile(t, p.Config, tc.text)
			_, err := Load(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Load error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestSaveRefusesInvalidConfig(t *testing.T) {
	p := testPaths(t)
	cfg := Defaults()
	cfg = WithProvider(cfg, domain.Kimi, func(pc *domain.ProviderConfig) { pc.Model = "" })
	if err := Save(p, cfg); err == nil {
		t.Fatal("Save accepted an invalid config")
	}
	if _, err := os.Stat(p.Config); !os.IsNotExist(err) {
		t.Errorf("Save wrote a file for an invalid config: %v", err)
	}
}

// TestAllDisabledIsValid: with every agent off, the tick does nothing.
func TestAllDisabledIsValid(t *testing.T) {
	cfg := WithProvider(Defaults(), domain.Claude, func(pc *domain.ProviderConfig) { pc.Enabled = false })
	if err := Validate(cfg); err != nil || len(cfg.Enabled()) != 0 {
		t.Fatalf("Validate = %v, enabled = %v", err, cfg.Enabled())
	}
}

func TestInvalidConfig(t *testing.T) {
	provider := func(id domain.ProviderID, edit func(*domain.ProviderConfig)) func(*domain.Config) {
		return func(c *domain.Config) {
			pc := c.Providers[id]
			edit(&pc)
			c.Providers[id] = pc
		}
	}
	tests := []struct {
		name  string
		edit  func(*domain.Config)
		field string
	}{
		{"bad hour work_start", provider(domain.Claude, func(p *domain.ProviderConfig) { p.WorkStart = 25 }), "providers.claude.work_start:"},
		{"bad hour work_end before start", provider(domain.Claude, func(p *domain.ProviderConfig) { p.WorkEnd = 8 }), "providers.claude.work_end:"},
		{"bad hour work_end past midnight", provider(domain.Claude, func(p *domain.ProviderConfig) { p.WorkEnd = 25 }), "providers.claude.work_end:"},
		{"bad provider id table", func(c *domain.Config) { c.Providers["bogus"] = DefaultProvider(domain.Claude) }, "providers.bogus:"},
		{"missing provider table", func(c *domain.Config) { delete(c.Providers, domain.Agy) }, "providers.agy:"},
		{"bad percent zero", provider(domain.Kimi, func(p *domain.ProviderConfig) { p.WeeklyStopPercent = 0 }), "providers.kimi.weekly_stop_percent:"},
		{"bad percent over 100", provider(domain.Kimi, func(p *domain.ProviderConfig) { p.WeeklyStopPercent = 150 }), "providers.kimi.weekly_stop_percent:"},
		{"empty binary", provider(domain.Zai, func(p *domain.ProviderConfig) { p.Binary = " " }), "providers.zai.binary:"},
		{"empty model", provider(domain.Zai, func(p *domain.ProviderConfig) { p.Model = "" }), "providers.zai.model:"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Defaults()
			tc.edit(&cfg)
			err := Validate(cfg)
			if err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Errorf("Validate error = %v, want one for %q", err, tc.field)
			}
		})
	}
}
