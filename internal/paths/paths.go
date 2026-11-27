// Package paths resolves every file and directory the tool reads or writes.
// Resolve reads the environment on each call, so tests can use t.Setenv.
package paths

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

const (
	Label = "com.d0whc3r.agent-warmup"
	// LegacyLabel is the launchd label of the TypeScript release. The scheduler
	// removes a plist with this label on start, stop, and uninstall.
	LegacyLabel = "com.d0whc3r.claude-warmup"
)

// tmuxCandidates are the tmux paths that Resolve checks in order when TMUX_BIN
// is unset. launchd and cron start with a minimal PATH, so the tool needs an
// absolute path.
var tmuxCandidates = []string{"/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/bin/tmux"}

type Paths struct {
	UserHome      string // $HOME
	Home          string // WARMUP_HOME, else ~/.agent-warmup
	Config        string // Home/config.toml
	LegacyEnv     string // Home/warmup.env, the TypeScript config, migrated once
	Cache         string // Home/usage-cache.json
	TickLock      string // Home/tick.lock, held while a tick runs
	LogDir        string // Home/logs
	WarmupLog     string // LogDir/warmup.log
	CronLog       string // LogDir/cron.log
	LaunchdOutLog string // LogDir/launchd.out.log
	LaunchdErrLog string // LogDir/launchd.err.log
	Workdir       string // WARMUP_WORKDIR, else Home/workdir
	Plist         string // ~/Library/LaunchAgents/<Label>.plist
	LegacyPlist   string // ~/Library/LaunchAgents/<LegacyLabel>.plist
	Tmux          string // TMUX_BIN, else the first executable candidate, else "tmux" from PATH
	OpencodeAuth  string // $XDG_DATA_HOME or ~/.local/share, then opencode/auth.json
	CodexSessions string // $CODEX_HOME or ~/.codex, then sessions
}

func Resolve() (Paths, error) {
	user, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("resolve user home: %w", err)
	}
	home := envOr("WARMUP_HOME", filepath.Join(user, ".agent-warmup"))
	logDir := filepath.Join(home, "logs")
	agents := filepath.Join(user, "Library", "LaunchAgents")
	return Paths{
		UserHome:      user,
		Home:          home,
		Config:        filepath.Join(home, "config.toml"),
		LegacyEnv:     filepath.Join(home, "warmup.env"),
		Cache:         filepath.Join(home, "usage-cache.json"),
		TickLock:      filepath.Join(home, "tick.lock"),
		LogDir:        logDir,
		WarmupLog:     filepath.Join(logDir, "warmup.log"),
		CronLog:       filepath.Join(logDir, "cron.log"),
		LaunchdOutLog: filepath.Join(logDir, "launchd.out.log"),
		LaunchdErrLog: filepath.Join(logDir, "launchd.err.log"),
		Workdir:       envOr("WARMUP_WORKDIR", filepath.Join(home, "workdir")),
		Plist:         filepath.Join(agents, Label+".plist"),
		LegacyPlist:   filepath.Join(agents, LegacyLabel+".plist"),
		Tmux:          envOr("TMUX_BIN", firstExecutable(tmuxCandidates, "tmux")),
		OpencodeAuth:  filepath.Join(envOr("XDG_DATA_HOME", filepath.Join(user, ".local", "share")), "opencode", "auth.json"),
		CodexSessions: filepath.Join(envOr("CODEX_HOME", filepath.Join(user, ".codex")), "sessions"),
	}, nil
}

// ArmScript is where the provider's arm script runs from. When
// WARMUP_<ID>_SCRIPT is set, it returns that path and overridden=true, and the
// runner must run it as is (tests and custom scripts use this). Otherwise it
// returns Home/arm-<id>.sh, which the runner writes from the embedded script.
func (p Paths) ArmScript(id domain.ProviderID) (path string, overridden bool) {
	if v := os.Getenv("WARMUP_" + strings.ToUpper(string(id)) + "_SCRIPT"); v != "" {
		return v, true
	}
	return filepath.Join(p.Home, "arm-"+string(id)+".sh"), false
}

// ExpandHome expands a leading "~" or "~/" to UserHome. It does not change "~user".
func (p Paths) ExpandHome(s string) string {
	if s == "~" || strings.HasPrefix(s, "~/") {
		return p.UserHome + s[1:]
	}
	return s
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstExecutable(candidates []string, fallback string) string {
	for _, c := range candidates {
		info, err := os.Stat(c)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return c
		}
	}
	return fallback
}
