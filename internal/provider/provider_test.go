package provider

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

func testPaths(t *testing.T) paths.Paths {
	t.Helper()
	t.Setenv("WARMUP_HOME", t.TempDir())
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRegistryCoversEveryID(t *testing.T) {
	if len(registry) != len(domain.ProviderIDs) {
		t.Errorf("registry has %d entries, want %d", len(registry), len(domain.ProviderIDs))
	}
	for _, id := range domain.ProviderIDs {
		p, ok := registry[id]
		if !ok {
			t.Errorf("%s is not registered", id)
			continue
		}
		if p.ID() != id {
			t.Errorf("registry[%s].ID() = %s", id, p.ID())
		}
		if p.Name() == "" {
			t.Errorf("%s has no name", id)
		}
		if def := config.DefaultProvider(id).Model; !slices.Contains(p.ModelChoices(), def) {
			t.Errorf("%s model choices %v miss the default %q", id, p.ModelChoices(), def)
		}
		if !bytes.HasPrefix(p.ArmScript(), []byte("#!/usr/bin/env bash\n")) {
			t.Errorf("%s arm script has no bash shebang", id)
		}
	}
}

func TestProbeKindsAndCredentials(t *testing.T) {
	want := map[domain.ProviderID]struct {
		kind ProbeKind
		cred string
	}{
		domain.Claude:   {ProbeLive, ""},
		domain.Codex:    {ProbeLive, ""},
		domain.Zai:      {ProbeEstimated, "zai-coding-plan"},
		domain.Kimi:     {ProbeEstimated, ""},
		domain.Opencode: {ProbeLive, "opencode-go"},
		domain.Minimax:  {ProbeEstimated, "minimax-coding-plan"},
		domain.Agy:      {ProbeEstimated, ""},
	}
	for id, w := range want {
		p := Get(id)
		if p.ProbeKind() != w.kind || p.CredentialKey() != w.cred {
			t.Errorf("%s: kind %s cred %q, want %s %q", id, p.ProbeKind(), p.CredentialKey(), w.kind, w.cred)
		}
		if w.kind != ProbeEstimated {
			continue
		}
		if _, err := p.Probe(context.Background(), pcAt(id, noon)); !errors.Is(err, ErrNoLiveProbe) {
			t.Errorf("%s Probe error = %v, want ErrNoLiveProbe", id, err)
		}
	}
}

func TestArmEnv(t *testing.T) {
	p := testPaths(t)
	want := map[domain.ProviderID]string{
		domain.Claude: "CLAUDE_BIN", domain.Codex: "CODEX_BIN", domain.Zai: "OPENCODE_BIN",
		domain.Kimi: "KIMI_BIN", domain.Opencode: "OPENCODE_BIN", domain.Minimax: "OPENCODE_BIN", domain.Agy: "AGY_BIN",
	}
	for id, binEnv := range want {
		pc := pcAt(id, noon)
		pc.Cfg.Binary = "~/bin/agent"
		pc.Paths = p
		env := Get(id).ArmEnv(pc)

		if got := env[binEnv]; got != filepath.Join(p.UserHome, "bin", "agent") {
			t.Errorf("%s %s = %q, want the expanded binary", id, binEnv, got)
		}
		if env["WARMUP_PROVIDER_NAME"] != Get(id).Name() {
			t.Errorf("%s WARMUP_PROVIDER_NAME = %q", id, env["WARMUP_PROVIDER_NAME"])
		}
		wantProvider := string(id)
		if id == domain.Claude {
			wantProvider = ""
		}
		if env["WARMUP_PROVIDER"] != wantProvider {
			t.Errorf("%s WARMUP_PROVIDER = %q, want %q", id, env["WARMUP_PROVIDER"], wantProvider)
		}
	}
}

func TestInferFromCache(t *testing.T) {
	lastWeek := week(40)
	cases := []struct {
		name       string
		id         domain.ProviderID
		lastWarm   time.Time
		wantActive bool
		wantWeek   *domain.LimitBlock
	}{
		{"codex arm one hour ago", domain.Codex, noon.Add(-time.Hour), true, lastWeek},
		{"kimi arm six hours ago", domain.Kimi, noon.Add(-6 * time.Hour), false, lastWeek},
		{"agy never armed", domain.Agy, time.Time{}, false, lastWeek},
		{"claude drops the week", domain.Claude, noon.Add(-time.Hour), true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry := domain.CacheEntry{LastWarmAt: tc.lastWarm, Usage: domain.Usage{Week: lastWeek}}
			u := Get(tc.id).InferFromCache(pcAt(tc.id, noon), entry)
			s := u.Session
			if !u.Inferred || s == nil || s.Active != tc.wantActive || u.Week != tc.wantWeek {
				t.Fatalf("got %+v session %+v", u, s)
			}
			wantPct, wantReset := 0, time.Time{}
			if tc.wantActive {
				wantPct, wantReset = 1, tc.lastWarm.Add(domain.SessionWindow)
			}
			if *s.Pct != wantPct || !s.ResetsAt.Equal(wantReset) {
				t.Errorf("session pct %d resets %v, want %d %v", *s.Pct, s.ResetsAt, wantPct, wantReset)
			}
		})
	}
}

func TestEnsureArmScript(t *testing.T) {
	p := testPaths(t)
	path, err := EnsureArmScript(p, Get(domain.Zai))
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(p.Home, "arm-zai.sh") {
		t.Errorf("path = %s", path)
	}
	assertScript(t, path, armOpencode)

	// A stale script is rewritten.
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureArmScript(p, Get(domain.Zai)); err != nil {
		t.Fatal(err)
	}
	assertScript(t, path, armOpencode)

	// An override is returned as is and never written.
	custom := filepath.Join(t.TempDir(), "custom.sh")
	t.Setenv("WARMUP_KIMI_SCRIPT", custom)
	if got, err := EnsureArmScript(p, Get(domain.Kimi)); err != nil || got != custom {
		t.Errorf("override: %s, %v", got, err)
	}
	if _, err := os.Stat(custom); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("override was written: %v", err)
	}
}

func assertScript(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("script content differs from the embedded script")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != armScriptMode {
		t.Errorf("mode = %o, want %o", info.Mode().Perm(), armScriptMode)
	}
}
