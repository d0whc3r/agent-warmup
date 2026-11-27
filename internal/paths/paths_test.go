package paths

import (
	"path/filepath"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

func resolve(t *testing.T) Paths {
	t.Helper()
	p, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveDefaults(t *testing.T) {
	user := t.TempDir()
	t.Setenv("HOME", user)
	for _, key := range []string{"WARMUP_HOME", "WARMUP_WORKDIR", "XDG_DATA_HOME", "CODEX_HOME"} {
		t.Setenv(key, "")
	}
	p := resolve(t)

	home := filepath.Join(user, ".agent-warmup")
	tests := map[string][2]string{
		"Home":          {p.Home, home},
		"Config":        {p.Config, filepath.Join(home, "config.toml")},
		"LegacyEnv":     {p.LegacyEnv, filepath.Join(home, "warmup.env")},
		"Cache":         {p.Cache, filepath.Join(home, "usage-cache.json")},
		"WarmupLog":     {p.WarmupLog, filepath.Join(home, "logs", "warmup.log")},
		"CronLog":       {p.CronLog, filepath.Join(home, "logs", "cron.log")},
		"Workdir":       {p.Workdir, filepath.Join(home, "workdir")},
		"Plist":         {p.Plist, filepath.Join(user, "Library", "LaunchAgents", "com.d0whc3r.agent-warmup.plist")},
		"LegacyPlist":   {p.LegacyPlist, filepath.Join(user, "Library", "LaunchAgents", "com.d0whc3r.claude-warmup.plist")},
		"OpencodeAuth":  {p.OpencodeAuth, filepath.Join(user, ".local", "share", "opencode", "auth.json")},
		"CodexSessions": {p.CodexSessions, filepath.Join(user, ".codex", "sessions")},
	}
	for name, tc := range tests {
		if tc[0] != tc[1] {
			t.Errorf("%s = %q, want %q", name, tc[0], tc[1])
		}
	}
}

func TestResolveEnvOverrides(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WARMUP_HOME", "/w")
	t.Setenv("WARMUP_WORKDIR", "/wd")
	t.Setenv("TMUX_BIN", "/x/tmux")
	t.Setenv("XDG_DATA_HOME", "/xdg")
	t.Setenv("CODEX_HOME", "/cx")
	p := resolve(t)

	tests := map[string][2]string{
		"Home":          {p.Home, "/w"},
		"Config":        {p.Config, "/w/config.toml"},
		"LogDir":        {p.LogDir, "/w/logs"},
		"Workdir":       {p.Workdir, "/wd"},
		"Tmux":          {p.Tmux, "/x/tmux"},
		"OpencodeAuth":  {p.OpencodeAuth, "/xdg/opencode/auth.json"},
		"CodexSessions": {p.CodexSessions, "/cx/sessions"},
	}
	for name, tc := range tests {
		if tc[0] != tc[1] {
			t.Errorf("%s = %q, want %q", name, tc[0], tc[1])
		}
	}
}

func TestExpandHome(t *testing.T) {
	p := Paths{UserHome: "/home/me"}
	tests := []struct{ in, want string }{
		{"~", "/home/me"},
		{"~/.local/bin/claude", "/home/me/.local/bin/claude"},
		{"/usr/local/bin/claude", "/usr/local/bin/claude"},
		{"claude", "claude"},
		{"~other/bin/claude", "~other/bin/claude"},
	}
	for _, tc := range tests {
		if got := p.ExpandHome(tc.in); got != tc.want {
			t.Errorf("ExpandHome(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestArmScript(t *testing.T) {
	p := Paths{Home: "/w"}
	t.Setenv("WARMUP_KIMI_SCRIPT", "")
	if got, over := p.ArmScript(domain.Kimi); got != "/w/arm-kimi.sh" || over {
		t.Errorf("ArmScript = %q, %v; want /w/arm-kimi.sh, false", got, over)
	}
	t.Setenv("WARMUP_KIMI_SCRIPT", "/tmp/stub.sh")
	if got, over := p.ArmScript(domain.Kimi); got != "/tmp/stub.sh" || !over {
		t.Errorf("ArmScript = %q, %v; want /tmp/stub.sh, true", got, over)
	}
}
