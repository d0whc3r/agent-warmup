package scheduler

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const (
	cronBegin = "# >>> agent-warmup >>>"
	cronEnd   = "# <<< agent-warmup <<<"
)

var safeShellArg = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

// shellQuote quotes s for POSIX sh only when it holds a character outside
// safeShellArg, so ordinary paths stay readable in the crontab.
func shellQuote(s string) string {
	if safeShellArg.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// cronBlock renders the marked block. The job runs with umask 077, so the
// files a tick creates are private, and with WARMUP_HOME when it is set. cron
// turns an unescaped % into a line break, and a line break in a path ends
// the entry. Thus, it escapes % and rejects \n and \r.
func cronBlock(p paths.Paths, cfg domain.Config, exe string) (string, error) {
	home := os.Getenv(homeEnv)
	for _, s := range []string{exe, p.CronLog, home} {
		if strings.ContainsAny(s, "\n\r") {
			return "", fmt.Errorf("path %q contains a line break, which a crontab entry cannot hold", s)
		}
	}
	env := ""
	if home != "" {
		env = homeEnv + "=" + shellQuote(home) + " "
	}
	cmd := fmt.Sprintf("umask 077; %s%s tick >> %s 2>&1", env, shellQuote(exe), shellQuote(p.CronLog))
	cmd = strings.ReplaceAll(cmd, "%", `\%`)
	return cronBegin + "\n" + cronLine(cfg, cmd) + "\n" + cronEnd, nil
}

// cronLine is the crontab entry, or a comment line when no agent is enabled.
func cronLine(cfg domain.Config, cmd string) string {
	start, end, ok := band(cfg)
	if !ok {
		return "# (no enabled providers)"
	}
	// work_end is exclusive, so the cron range ends at end-1.
	hourField := fmt.Sprintf("%d-%d", start, end-1)
	if end-start == 1 {
		hourField = strconv.Itoa(start)
	}
	return fmt.Sprintf("*/%d %s * * * %s", tickMinutes, hourField, cmd)
}

var errUnterminated = errors.New("the crontab has a begin marker without an end marker. Fix it with crontab -e")

// stripBlock removes the marked block and trailing whitespace. A begin marker
// without an end marker is an error, so the lines below it survive.
func stripBlock(text string) (string, error) {
	var out []string
	inBlock := false
	for line := range strings.SplitSeq(text, "\n") {
		switch strings.TrimSpace(line) {
		case cronBegin:
			inBlock = true
		case cronEnd:
			inBlock = false
		default:
			if !inBlock {
				out = append(out, line)
			}
		}
	}
	if inBlock {
		return "", fmt.Errorf("%q: %w", cronBegin, errUnterminated)
	}
	return strings.TrimRight(strings.Join(out, "\n"), " \t\r\n"), nil
}

func applyCron(ctx context.Context, p paths.Paths, cfg domain.Config, exe string) error {
	text, err := sysexec.ReadCrontab(ctx)
	if err != nil {
		return err
	}
	kept, err := stripBlock(text)
	if err != nil {
		return err
	}
	block, err := cronBlock(p, cfg, exe)
	if err != nil {
		return err
	}
	return sysexec.WriteCrontab(ctx, withNewline(kept)+block+"\n")
}

// removeCron writes the crontab only when the block is there: every write
// of crontab triggers the macOS Full Disk Access prompt.
func removeCron(ctx context.Context) error {
	text, err := sysexec.ReadCrontab(ctx)
	if err != nil {
		return err
	}
	if !strings.Contains(text, cronBegin) {
		return nil
	}
	kept, err := stripBlock(text)
	if err != nil {
		return err
	}
	return sysexec.WriteCrontab(ctx, withNewline(kept))
}

func cronState(ctx context.Context) (CronStatus, error) {
	text, err := sysexec.ReadCrontab(ctx)
	return CronStatus{Installed: strings.Contains(text, cronBegin)}, err
}

func withNewline(s string) string {
	if s == "" {
		return ""
	}
	return s + "\n"
}
