package scheduler

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const (
	plistMode       = 0o644
	launchAgentsDir = 0o755
	minutesPerHour  = 60
)

var (
	runningRE  = regexp.MustCompile(`state = running`)
	disabledRE = regexp.MustCompile(`"` + regexp.QuoteMeta(paths.Label) + `"\s*=>\s*(\w+)`)
)

func launchTarget() string {
	return sysexec.LaunchDomain() + "/" + paths.Label
}

// plist renders the LaunchAgent that runs "<exe> tick" at each calendar time.
// Umask 63 (077) keeps the files a tick creates private.
func plist(p paths.Paths, cfg domain.Config, exe string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>` + esc(paths.Label) + `</string>
    <key>ProgramArguments</key>
    <array>
        <string>` + esc(exe) + `</string>
        <string>tick</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
`)
	for _, at := range calendar(cfg) {
		fmt.Fprintf(&b, "        <dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n", at[0], at[1])
	}
	b.WriteString(`    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>` + esc(p.LaunchdOutLog) + `</string>
    <key>StandardErrorPath</key>
    <string>` + esc(p.LaunchdErrLog) + `</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>` + esc(p.UserHome) + `</string>
`)
	if home := os.Getenv(homeEnv); home != "" {
		b.WriteString("        <key>" + homeEnv + "</key>\n        <string>" + esc(home) + "</string>\n")
	}
	b.WriteString(`    </dict>
</dict>
</plist>
`)
	return b.String()
}

// calendar lists the [hour, minute] pairs the job fires at: every tick
// across the union of the work hours.
func calendar(cfg domain.Config) [][2]int {
	start, end, ok := band(cfg)
	if !ok {
		return nil
	}
	var out [][2]int
	for h := start; h < end; h++ {
		for m := 0; m < minutesPerHour; m += tickMinutes {
			out = append(out, [2]int{h, m})
		}
	}
	return out
}

func esc(s string) string {
	var b bytes.Buffer
	// EscapeText fails only when the writer fails. A bytes.Buffer does not fail.
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func applyLaunchd(ctx context.Context, p paths.Paths, cfg domain.Config, exe string) error {
	if err := os.MkdirAll(filepath.Dir(p.Plist), launchAgentsDir); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(p.Plist), err)
	}
	if err := os.WriteFile(p.Plist, []byte(plist(p, cfg, exe)), plistMode); err != nil {
		return fmt.Errorf("write %s: %w", p.Plist, err)
	}
	if err := os.Chmod(p.Plist, plistMode); err != nil {
		return fmt.Errorf("chmod %s: %w", p.Plist, err)
	}

	if err := bootout(ctx); err != nil {
		return err
	}
	// bootstrap refuses a disabled label, so enable it first.
	if _, err := sysexec.Run(ctx, "launchctl", "enable", launchTarget()); err != nil {
		return err
	}
	if _, err := sysexec.Run(ctx, "launchctl", "bootstrap", sysexec.LaunchDomain(), p.Plist); err != nil {
		return fmt.Errorf("load launchd agent: %w", err)
	}
	return nil
}

// bootout unloads the job. A job that is not loaded makes launchctl exit
// non-zero, which is the state bootout wants, so only a start failure counts.
func bootout(ctx context.Context) error {
	_, err := sysexec.Run(ctx, "launchctl", "bootout", launchTarget())
	if err != nil && !sysexec.Exited(err) {
		return err
	}
	return nil
}

func removeLaunchd(ctx context.Context, p paths.Paths) error {
	if err := bootout(ctx); err != nil {
		return err
	}
	err := os.Remove(p.Plist)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete %s: %w", p.Plist, err)
	}
	return nil
}

func launchdState(ctx context.Context, p paths.Paths) (LaunchdStatus, error) {
	var s LaunchdStatus
	_, err := os.Stat(p.Plist)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return s, fmt.Errorf("stat %s: %w", p.Plist, err)
	}
	s.Installed = err == nil

	printed, err := sysexec.Run(ctx, "launchctl", "print", launchTarget())
	if err != nil && !sysexec.Exited(err) {
		return s, err
	}
	s.Loaded = err == nil
	s.Running = s.Loaded && runningRE.MatchString(printed)

	disabled, err := sysexec.Run(ctx, "launchctl", "print-disabled", sysexec.LaunchDomain())
	if err != nil {
		return s, err
	}
	// launchctl prints "true" for a disabled job. An absent label is enabled.
	m := disabledRE.FindStringSubmatch(disabled)
	s.Enabled = len(m) < 2 || m[1] == "enabled" || m[1] == "false"
	return s, nil
}
