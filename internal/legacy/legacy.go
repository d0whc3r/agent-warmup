// Package legacy removes what the TypeScript release left behind, so it cannot
// run beside the Go install. Every step is safe to repeat.
package legacy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const (
	cronBegin = "# >>> claude-warmup >>>"
	cronEnd   = "# <<< claude-warmup <<<"
	binName   = "agent-warmup"
	// shimHeadBytes is how much of a PATH entry Clean reads to spot a node shim.
	shimHeadBytes = 4096
)

var (
	// oldCronRE matches the exact command the TypeScript release wrote: the
	// npm bundle or the old claude-warmup binary, maybe shell-quoted, then
	// " tick". Clean deletes these lines.
	oldCronRE = regexp.MustCompile(`/(?:agent-warmup\.mjs|claude-warmup(?:\.mjs)?)'? tick(?:\s|$)`)
	// candidateCronRE matches a line that runs node with arguments ending in
	// tick. It can be the TypeScript CLI run from source, or a job of the
	// user, so Clean only reports it. A Go binary under a directory named
	// node does not match, because "node" is followed by "/".
	candidateCronRE = regexp.MustCompile(`(^|[\s/])node(\s+\S+)+\s+tick\b`)
)

// Report lists what Clean (or Uninstall) did, and what the user must do.
type Report struct {
	Actions []string // done
	Notices []string // found but left alone, with the command that removes it
}

// Clean removes the TypeScript launchd agent and crontab entries. It kills
// the TypeScript tmux sessions (config.LegacySessions) only when it removed
// one of those in the same run, so a session of the user with the same name
// survives a later run. It reports the old ~/.claude/warmup home and a global
// npm or pnpm install without touching them.
func Clean(ctx context.Context, p paths.Paths) (Report, error) {
	var r Report
	found := false
	if runtime.GOOS == "darwin" {
		removed, err := r.removeLaunchd(ctx, p)
		if err != nil {
			return r, err
		}
		found = removed
	}

	removed, err := r.removeCron(ctx)
	if err != nil {
		return r, err
	}
	found = found || removed

	if found {
		killed, err := KillTmux(ctx, p, config.LegacySessions(p))
		if err != nil {
			return r, err
		}
		r.Actions = append(r.Actions, killed...)
	}

	oldHome := filepath.Join(p.UserHome, ".claude", "warmup")
	if _, err := os.Stat(oldHome); err == nil {
		r.Notices = append(r.Notices, fmt.Sprintf("old home %s still exists. Delete it when you no longer need it: rm -rf %s", oldHome, oldHome))
	}

	notices, err := npmInstalls()
	if err != nil {
		return r, err
	}
	r.Notices = append(r.Notices, notices...)
	return r, nil
}

// removeLaunchd boots out the old job and deletes its plist.
func (r *Report) removeLaunchd(ctx context.Context, p paths.Paths) (bool, error) {
	target := sysexec.LaunchDomain() + "/" + paths.LegacyLabel
	_, err := sysexec.Run(ctx, "launchctl", "bootout", target)
	if err != nil && !sysexec.Exited(err) {
		return false, err
	}
	unloaded := err == nil
	if unloaded {
		r.Actions = append(r.Actions, "unloaded launchd job "+paths.LegacyLabel)
	}

	err = os.Remove(p.LegacyPlist)
	if errors.Is(err, fs.ErrNotExist) {
		return unloaded, nil
	}
	if err != nil {
		return unloaded, fmt.Errorf("delete %s: %w", p.LegacyPlist, err)
	}
	r.Actions = append(r.Actions, "deleted "+p.LegacyPlist)
	return true, nil
}

// removeCron drops the old marked block and the lines that run the
// TypeScript CLI, and reports the lines that possibly run it. It writes the crontab only
// when it changed.
func (r *Report) removeCron(ctx context.Context) (bool, error) {
	text, err := sysexec.ReadCrontab(ctx)
	if err != nil {
		return false, err
	}
	kept, dropped, notices, err := filterCron(text)
	if err != nil {
		return false, err
	}
	r.Notices = append(r.Notices, notices...)
	if dropped == 0 {
		return false, nil
	}
	if err := sysexec.WriteCrontab(ctx, kept); err != nil {
		return false, err
	}
	r.Actions = append(r.Actions, fmt.Sprintf("removed %d legacy crontab line(s)", dropped))
	return true, nil
}

// filterCron returns text without the old block and the oldCronRE lines, and
// a notice for each candidateCronRE line. A begin marker without an end
// marker is an error, so the lines below it survive.
func filterCron(text string) (kept string, dropped int, notices []string, err error) {
	var out []string
	inBlock := false
	for line := range strings.SplitSeq(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == cronBegin {
			inBlock = true
		}
		old := inBlock || oldCronRE.MatchString(line)
		if trimmed == cronEnd {
			inBlock = false
		}
		if old {
			dropped++
			continue
		}
		if candidateCronRE.MatchString(line) {
			notices = append(notices, "crontab line possibly runs the TypeScript release. If it does, remove it with crontab -e: "+trimmed)
		}
		out = append(out, line)
	}
	if inBlock {
		return "", 0, nil, fmt.Errorf("crontab has %q without %q. Fix it with crontab -e", cronBegin, cronEnd)
	}
	return strings.Join(out, "\n"), dropped, notices, nil
}

// KillTmux kills the arm and probe sessions "<s>" and "<s>-usage" of each
// session s, and returns one line per session that existed.
func KillTmux(ctx context.Context, p paths.Paths, sessions []string) ([]string, error) {
	var killed []string
	for _, s := range sessions {
		for _, name := range []string{s, s + "-usage"} {
			// "=" makes tmux match the name exactly instead of as a prefix.
			_, err := sysexec.Run(ctx, p.Tmux, "kill-session", "-t", "="+name)
			if sysexec.Exited(err) {
				continue // no such session
			}
			if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
				return killed, nil // no tmux, so no sessions
			}
			if err != nil {
				return killed, err
			}
			killed = append(killed, "tmux session "+name)
		}
	}
	return killed, nil
}

// npmInstalls finds agent-warmup entries on PATH that run through node.
func npmInstalls() ([]string, error) {
	self, err := sysexec.Self()
	if err != nil {
		return nil, err
	}
	var notices []string
	var seen []string
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		entry := filepath.Join(dir, binName)
		resolved, err := filepath.EvalSymlinks(entry)
		if err != nil || resolved == self || slices.Contains(seen, resolved) {
			continue
		}
		seen = append(seen, resolved)
		manager, err := nodeManager(resolved)
		if err != nil {
			slog.Warn("skip PATH entry", "path", resolved, "err", err)
			continue
		}
		if manager == "" {
			continue
		}
		notices = append(notices, fmt.Sprintf("the TypeScript %s global install %s is on PATH. Remove it with: %s", manager, entry, removeCommand(manager)))
	}
	return notices, nil
}

// nodeManager returns "npm" or "pnpm" when path is a node install of the CLI:
// a file inside node_modules, a node shebang, or a pnpm shell shim that
// execs node_modules/agent-warmup. It returns "" for anything else.
func nodeManager(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	head, err := readHead(path)
	if err != nil {
		return "", err
	}
	firstLine, _, _ := strings.Cut(head, "\n")
	isNode := strings.Contains(path, "/node_modules/") ||
		(strings.HasPrefix(firstLine, "#!") && strings.Contains(firstLine, "node")) ||
		strings.Contains(head, "node_modules/"+binName)
	if !isNode {
		return "", nil
	}
	if strings.Contains(path, "pnpm") || strings.Contains(head, "pnpm") {
		return "pnpm", nil
	}
	return "npm", nil
}

func removeCommand(manager string) string {
	if manager == "pnpm" {
		return "pnpm remove -g " + binName
	}
	return "npm uninstall -g " + binName
}

func readHead(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	buf := make([]byte, shimHeadBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return string(buf[:n]), nil
}
