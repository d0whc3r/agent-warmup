// Package sandbox gives a test its own HOME, WARMUP_HOME, and stub crontab,
// launchctl, and tmux executables first on PATH, so no test can edit the real
// crontab, LaunchAgents, or tmux server. Only tests import it.
package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/paths"
)

// The crontab stub keeps the crontab in $FAKE_CRONTAB and appends one line to
// $FAKE_CRONTAB.writes per write.
const crontabStub = `#!/usr/bin/env bash
case "$1" in
  -l) [ -f "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;
  -)  cat > "$FAKE_CRONTAB"; printf 'w\n' >> "$FAKE_CRONTAB.writes" ;;
  *)  exit 1 ;;
esac
`

// The launchctl stub logs each call and answers print and print-disabled from
// FAKE_PRINT_* variables. FAKE_LAUNCHCTL_STATUS is the exit status of the rest.
const launchctlStub = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
case "$1" in
  print)
    [ -n "${FAKE_PRINT_STATE:-}" ] && echo "state = $FAKE_PRINT_STATE"
    exit "${FAKE_PRINT_STATUS:-0}" ;;
  print-disabled)
    [ -n "${FAKE_PRINT_DISABLED:-}" ] && printf '%s\n' "$FAKE_PRINT_DISABLED"
    exit 0 ;;
  *) exit "${FAKE_LAUNCHCTL_STATUS:-0}" ;;
esac
`

// The tmux stub logs each call. kill-session -t =NAME succeeds and removes NAME
// when NAME is a line of $FAKE_TMUX_SESSIONS, else it exits 1.
const tmuxStub = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = kill-session ] && [ "$2" = -t ]; then
  name="${3#=}"
  [ -f "$FAKE_TMUX_SESSIONS" ] && grep -qxF "$name" "$FAKE_TMUX_SESSIONS" || exit 1
  grep -vxF "$name" "$FAKE_TMUX_SESSIONS" > "$FAKE_TMUX_SESSIONS.tmp" || true
  mv "$FAKE_TMUX_SESSIONS.tmp" "$FAKE_TMUX_SESSIONS"
  exit 0
fi
exit 0
`

type Sandbox struct {
	Root  string // HOME
	Bin   string // stub directory, first on PATH
	Paths paths.Paths
}

func New(t *testing.T) Sandbox {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	s := Sandbox{Root: root, Bin: bin}
	mkdir(t, bin)

	t.Setenv("HOME", root)
	t.Setenv("WARMUP_HOME", filepath.Join(root, "warmup"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "share"))
	t.Setenv("CODEX_HOME", filepath.Join(root, "codex"))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CRONTAB", filepath.Join(root, "crontab.txt"))
	t.Setenv("FAKE_LAUNCHCTL_LOG", filepath.Join(root, "launchctl.log"))
	t.Setenv("FAKE_TMUX_LOG", filepath.Join(root, "tmux.log"))
	t.Setenv("FAKE_TMUX_SESSIONS", filepath.Join(root, "tmux-sessions.txt"))
	t.Setenv("TMUX_BIN", filepath.Join(bin, "tmux"))
	for _, k := range []string{"FAKE_PRINT_STATE", "FAKE_PRINT_STATUS", "FAKE_PRINT_DISABLED", "FAKE_LAUNCHCTL_STATUS", "WARMUP_WORKDIR"} {
		t.Setenv(k, "")
	}

	s.AddBin(t, "crontab", crontabStub)
	s.AddBin(t, "launchctl", launchctlStub)
	s.AddBin(t, "tmux", tmuxStub)

	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	s.Paths = p
	return s
}

// AddBin writes an executable script named name into the stub directory.
func (s Sandbox) AddBin(t *testing.T, name, body string) string {
	t.Helper()
	return WriteExec(t, filepath.Join(s.Bin, name), body)
}

// WriteExec writes body to path with mode 0700, creating the directory.
func WriteExec(t *testing.T, path, body string) string {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil { //nolint:gosec // a stub executable needs the exec bit
		t.Fatal(err)
	}
	return path
}

func (s Sandbox) SetCrontab(t *testing.T, text string) {
	t.Helper()
	if err := os.WriteFile(os.Getenv("FAKE_CRONTAB"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Crontab is the stub crontab, "" when none was written.
func (s Sandbox) Crontab(t *testing.T) string {
	t.Helper()
	return readOptional(t, os.Getenv("FAKE_CRONTAB"))
}

func (s Sandbox) CrontabWrites(t *testing.T) int {
	t.Helper()
	return len(lines(readOptional(t, os.Getenv("FAKE_CRONTAB")+".writes")))
}

// Launchctl lists every launchctl call, one argument line each.
func (s Sandbox) Launchctl(t *testing.T) []string {
	t.Helper()
	return lines(readOptional(t, os.Getenv("FAKE_LAUNCHCTL_LOG")))
}

// Tmux lists every tmux call, one argument line each.
func (s Sandbox) Tmux(t *testing.T) []string {
	t.Helper()
	return lines(readOptional(t, os.Getenv("FAKE_TMUX_LOG")))
}

// SetTmuxSessions sets the sessions the tmux stub reports as existing.
func (s Sandbox) SetTmuxSessions(t *testing.T, names ...string) {
	t.Helper()
	text := strings.Join(names, "\n") + "\n"
	if err := os.WriteFile(os.Getenv("FAKE_TMUX_SESSIONS"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
}

func readOptional(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func lines(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}
