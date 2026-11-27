package legacy

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sandbox"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const (
	foreign  = "0 0 * * * /usr/bin/backup\n"
	newBlock = "# >>> agent-warmup >>>\n0 8 * * * /home/node/bin/agent-warmup tick >> /w/cron.log 2>&1\n# <<< agent-warmup <<<\n"
)

func TestFilterCron(t *testing.T) {
	cases := []struct {
		name, in, want string
		dropped        int
		notices        int
	}{
		{"old block", foreign + "# >>> claude-warmup >>>\n0 8 * * * x tick\n# <<< claude-warmup <<<\n", foreign, 3, 0},
		{"bundle line", foreign + "0 8 * * * /usr/bin/node /x/dist/agent-warmup.mjs tick\n", foreign, 1, 0},
		{"quoted bundle line", foreign + "0 8 * * * '/usr/bin/node' '/my x/agent-warmup.mjs' tick >> l 2>&1\n", foreign, 1, 0},
		{"old binary line", foreign + "0 8 * * * /usr/local/bin/claude-warmup tick\n", foreign, 1, 0},
		{"tsx line is only reported", "*/30 8-17 * * * node --import tsx /src/cli.ts tick >> l 2>&1\n" + foreign, "*/30 8-17 * * * node --import tsx /src/cli.ts tick >> l 2>&1\n" + foreign, 0, 1},
		{"go block kept", foreign + newBlock, foreign + newBlock, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, dropped, notices, err := filterCron(tc.in)
			if err != nil || got != tc.want || dropped != tc.dropped || len(notices) != tc.notices {
				t.Errorf("filterCron = %q, %d, %q, %v; want %q, %d, %d notices", got, dropped, notices, err, tc.want, tc.dropped, tc.notices)
			}
		})
	}
}

// TestFilterCronKeepsUserLines: lines that run node and mention tick but are
// not the TypeScript CLI belong to the user.
func TestFilterCronKeepsUserLines(t *testing.T) {
	user := "*/5 * * * * /usr/local/bin/node /home/u/metrics/collect.js tick\n" +
		"0 * * * * cd ~/app && node scripts/run.js --job tick-tock\n" +
		"0 9 * * * node ~/bot/index.js && echo tick\n"
	got, dropped, _, err := filterCron(user)
	if err != nil || got != user || dropped != 0 {
		t.Errorf("filterCron = %q, %d, %v; want the user lines unchanged", got, dropped, err)
	}
}

func TestFilterCronUnterminatedBlock(t *testing.T) {
	if _, _, _, err := filterCron("# >>> claude-warmup >>>\n0 8 * * * x tick\n" + foreign); err == nil {
		t.Error("filterCron accepted a begin marker without an end marker")
	}
}

func TestCleanUnterminatedBlockKeepsCrontab(t *testing.T) {
	s := sandbox.New(t)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3")
	text := "# >>> claude-warmup >>>\n0 8 * * * x tick\n" + foreign
	s.SetCrontab(t, text)
	if _, err := Clean(context.Background(), s.Paths); err == nil {
		t.Error("Clean accepted an unterminated block")
	}
	if got := s.Crontab(t); got != text {
		t.Errorf("crontab = %q", got)
	}
}

// TestCleanSkipsUnreadablePathEntry: an unrelated agent-warmup on PATH that
// cannot be read must not stop start, stop, or uninstall.
func TestCleanSkipsUnreadablePathEntry(t *testing.T) {
	s := sandbox.New(t)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3")
	dir := filepath.Join(s.Root, "locked")
	entry := sandbox.WriteExec(t, filepath.Join(dir, "agent-warmup"), "x")
	if err := os.Chmod(entry, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(entry, 0o700) })
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if _, err := Clean(context.Background(), s.Paths); err != nil {
		t.Fatalf("Clean = %v", err)
	}
}

func TestCleanCrontabAndTmux(t *testing.T) {
	s := sandbox.New(t)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3") // bootout: no legacy job loaded
	s.SetCrontab(t, foreign+"# >>> claude-warmup >>>\n0 8 * * * x tick\n# <<< claude-warmup <<<\n")
	s.SetTmuxSessions(t, "claude-warmup-usage", "mine", "unrelated")
	// A session set in the migrated warmup.env is a legacy session too.
	if err := os.MkdirAll(s.Paths.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Paths.LegacyEnv+".bak", []byte("WARMUP_TMUX_SESSION=mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	r, err := Clean(ctx, s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Crontab(t); got != foreign {
		t.Errorf("crontab = %q", got)
	}
	for _, want := range []string{"removed 3 legacy crontab line(s)", "tmux session claude-warmup-usage", "tmux session mine"} {
		if !slices.Contains(r.Actions, want) {
			t.Errorf("actions %q lack %q", r.Actions, want)
		}
	}
	if slices.Contains(s.Tmux(t), "kill-session -t =unrelated") {
		t.Error("killed a session that is not ours")
	}

	writes := s.CrontabWrites(t)
	s.SetTmuxSessions(t, "claude-warmup")
	r, err = Clean(ctx, s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if s.CrontabWrites(t) != writes {
		t.Error("a second Clean rewrote the crontab")
	}
	if len(r.Actions) != 0 {
		t.Errorf("a second Clean acted: %q", r.Actions)
	}
}

func TestCleanLegacyPlist(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd exists only on macOS")
	}
	s := sandbox.New(t)
	if err := os.MkdirAll(filepath.Dir(s.Paths.LegacyPlist), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Paths.LegacyPlist, []byte("plist"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := Clean(context.Background(), s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.Paths.LegacyPlist); !os.IsNotExist(err) {
		t.Error("legacy plist still exists")
	}
	if !slices.Contains(s.Launchctl(t), "bootout "+sysexec.LaunchDomain()+"/"+paths.LegacyLabel) {
		t.Errorf("no bootout of the legacy label: %q", s.Launchctl(t))
	}
	if !slices.Contains(r.Actions, "deleted "+s.Paths.LegacyPlist) {
		t.Errorf("actions = %q", r.Actions)
	}
}

func TestCleanNotices(t *testing.T) {
	s := sandbox.New(t)
	oldHome := filepath.Join(s.Root, ".claude", "warmup")
	if err := os.MkdirAll(oldHome, 0o700); err != nil {
		t.Fatal(err)
	}

	npmDir := filepath.Join(s.Root, "npm")
	bundle := sandbox.WriteExec(t, filepath.Join(npmDir, "lib", "node_modules", "agent-warmup", "dist", "agent-warmup.mjs"), "#!/usr/bin/env node\n")
	if err := os.Symlink(bundle, filepath.Join(npmDir, "agent-warmup")); err != nil {
		t.Fatal(err)
	}
	pnpmDir := filepath.Join(s.Root, "Library", "pnpm")
	sandbox.WriteExec(t, filepath.Join(pnpmDir, "agent-warmup"), "#!/bin/sh\nexec node \"$basedir/global/5/node_modules/agent-warmup/dist/agent-warmup.mjs\" \"$@\"\n")
	goDir := filepath.Join(s.Root, "gobin")
	sandbox.WriteExec(t, filepath.Join(goDir, "agent-warmup"), "\x7fELF binary")
	t.Setenv("PATH", strings.Join([]string{npmDir, pnpmDir, goDir, os.Getenv("PATH")}, string(os.PathListSeparator)))

	r, err := Clean(context.Background(), s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(r.Notices, "\n")
	for _, want := range []string{"rm -rf " + oldHome, "npm uninstall -g agent-warmup", "pnpm remove -g agent-warmup"} {
		if !strings.Contains(all, want) {
			t.Errorf("notices lack %q:\n%s", want, all)
		}
	}
	if strings.Contains(all, goDir) {
		t.Errorf("a native binary was reported:\n%s", all)
	}
	if _, err := os.Stat(oldHome); err != nil {
		t.Error("Clean deleted the old home")
	}
	if _, err := os.Stat(bundle); err != nil {
		t.Error("Clean deleted the npm install")
	}
}
