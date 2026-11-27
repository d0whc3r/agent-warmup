package detect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/sandbox"
)

// fake carries only what detection reads: the name and credential key.
type fake struct {
	provider.Provider
	id  domain.ProviderID
	key string
}

func (f fake) Name() string          { return "Fake " + string(f.id) }
func (f fake) CredentialKey() string { return f.key }

var credentialKeys = map[domain.ProviderID]string{
	domain.Opencode: "opencode-go",
	domain.Zai:      "zai-coding-plan",
	domain.Minimax:  "minimax-coding-plan",
}

// setup isolates HOME and makes PATH hold only a fresh bin directory.
func setup(t *testing.T) (paths.Paths, string) {
	t.Helper()
	s := sandbox.New(t)
	bin := filepath.Join(s.Root, "path-bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	old := lookup
	lookup = func(id domain.ProviderID) provider.Provider { return fake{id: id, key: credentialKeys[id]} }
	t.Cleanup(func() { lookup = old })
	return s.Paths, bin
}

func fakeBinary(t *testing.T, dir, name string) string {
	t.Helper()
	return sandbox.WriteExec(t, filepath.Join(dir, name), "#!/bin/sh\nexit 0\n")
}

func writeAuth(t *testing.T, p paths.Paths, keys ...string) {
	t.Helper()
	var parts []string
	for _, k := range keys {
		parts = append(parts, `"`+k+`":{"type":"api"}`)
	}
	if err := os.MkdirAll(filepath.Dir(p.OpencodeAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.OpencodeAuth, []byte("{"+strings.Join(parts, ",")+"}"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDetectOnPath(t *testing.T) {
	p, bin := setup(t)
	kimi := fakeBinary(t, bin, "kimi")
	d := Detect(p, domain.Kimi, "")
	if d.Binary != "kimi" || d.Path != kimi || d.ConfiguredOK || d.Configured != config.DefaultProvider(domain.Kimi).Binary {
		t.Errorf("Detect = %+v", d)
	}
}

func TestDetectConfiguredWins(t *testing.T) {
	p, bin := setup(t)
	fakeBinary(t, bin, "claude")
	custom := fakeBinary(t, filepath.Join(p.UserHome, "custom"), "claude")
	if d := Detect(p, domain.Claude, custom); d.Path != custom || !d.ConfiguredOK {
		t.Errorf("Detect = %+v", d)
	}
	if d := Detect(p, domain.Claude, "~/custom/claude"); d.Path != custom || !d.ConfiguredOK {
		t.Errorf("Detect(~) = %+v", d)
	}
}

func TestDetectStaleConfigured(t *testing.T) {
	p, bin := setup(t)
	onPath := fakeBinary(t, bin, "codex")
	if d := Detect(p, domain.Codex, "/gone/codex"); d.ConfiguredOK || d.Path != onPath {
		t.Errorf("Detect = %+v", d)
	}
}

func TestDetectDefaultDirAndClaudeLocal(t *testing.T) {
	p, _ := setup(t)
	local := fakeBinary(t, filepath.Join(p.UserHome, ".claude", "local"), "claude")
	if d := Detect(p, domain.Claude, "/gone/claude"); d.Path != local {
		t.Errorf("Detect = %+v, want %s", d, local)
	}
}

func TestDetectCredential(t *testing.T) {
	cases := []struct {
		name    string
		keys    []string
		id      domain.ProviderID
		blocked bool
	}{
		{"zai without key", []string{"opencode-go"}, domain.Zai, true},
		{"minimax without key", []string{"opencode-go"}, domain.Minimax, true},
		{"opencode with key", []string{"opencode-go"}, domain.Opencode, false},
		{"zai with key", []string{"opencode-go", "zai-coding-plan"}, domain.Zai, false},
		{"no auth file", nil, domain.Zai, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, bin := setup(t)
			opencode := fakeBinary(t, bin, "opencode")
			if tc.keys != nil {
				writeAuth(t, p, tc.keys...)
			}
			d := Detect(p, tc.id, "")
			if tc.blocked {
				if d.Path != "" || d.ConfiguredOK || !strings.Contains(d.Blocked, credentialKeys[tc.id]) {
					t.Errorf("Detect = %+v, want blocked", d)
				}
				return
			}
			if d.Blocked != "" || d.Path != opencode {
				t.Errorf("Detect = %+v, want %s", d, opencode)
			}
		})
	}
}

func TestDetectDirectoryIsNotExecutable(t *testing.T) {
	p, _ := setup(t)
	writeAuth(t, p, "opencode-go")
	dir := filepath.Join(p.UserHome, "as-dir", "opencode")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if d := Detect(p, domain.Opencode, dir); d.ConfiguredOK {
		t.Errorf("Detect = %+v", d)
	}
}

func TestAll(t *testing.T) {
	p, _ := setup(t)
	all := All(p, config.Defaults())
	if len(all) != len(domain.ProviderIDs) {
		t.Fatalf("All returned %d", len(all))
	}
	for i, d := range all {
		if d.ID != domain.ProviderIDs[i] || d.Name == "" {
			t.Errorf("All[%d] = %+v", i, d)
		}
	}
}
