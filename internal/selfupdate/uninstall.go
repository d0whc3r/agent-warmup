package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/legacy"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
)

// Uninstall stops both schedulers (which also runs legacy.Clean), kills the
// tmux sessions, and deletes the arm scripts, the workdir, and the cache. It
// keeps config.toml and the logs. The report lists each removed item.
func Uninstall(ctx context.Context, p paths.Paths) (legacy.Report, error) {
	// Schedulers first: a tick firing mid-teardown would recreate the sessions.
	report, err := scheduler.Stop(ctx, p)
	if err != nil {
		return report, err
	}
	report.Actions = append(report.Actions, "launchd agent and crontab block")

	sessions := make([]string, len(domain.ProviderIDs))
	for i, id := range domain.ProviderIDs {
		sessions[i] = id.TmuxSession()
	}
	killed, err := legacy.KillTmux(ctx, p, sessions)
	report.Actions = append(report.Actions, killed...)
	if err != nil {
		return report, err
	}

	scripts, err := filepath.Glob(filepath.Join(p.Home, "arm-*.sh"))
	if err != nil {
		return report, fmt.Errorf("list arm scripts: %w", err)
	}
	targets := append([]string{p.Cache, p.Cache + ".lock", p.TickLock}, scripts...)
	if insideHome(p, p.Workdir) {
		targets = append(targets, p.Workdir)
	} else {
		report.Notices = append(report.Notices, "left WARMUP_WORKDIR "+p.Workdir+" in place")
	}
	for _, target := range targets {
		removed, err := removeAll(target)
		if err != nil {
			return report, err
		}
		if removed {
			report.Actions = append(report.Actions, target)
		}
	}
	return report, nil
}

// insideHome reports whether path is below Home. A WARMUP_WORKDIR elsewhere
// belongs to the user, and Home itself holds the config and the logs.
func insideHome(p paths.Paths, path string) bool {
	rel, err := filepath.Rel(p.Home, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func removeAll(target string) (bool, error) {
	if _, err := os.Lstat(target); errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err := os.RemoveAll(target); err != nil {
		return false, fmt.Errorf("delete %s: %w", target, err)
	}
	return true, nil
}
