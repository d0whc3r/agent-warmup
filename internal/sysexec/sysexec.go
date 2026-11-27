// Package sysexec runs the external system commands that scheduler, legacy,
// and selfupdate share: launchctl, crontab, and tmux. Each command is found on
// PATH, so tests replace it with a stub executable.
package sysexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/x/term"
)

const (
	timeout = 30 * time.Second
	// waitDelay bounds how long Wait waits for output pipes that a killed
	// command's children still hold open.
	waitDelay = 5 * time.Second
)

// Run runs name with args and returns its stdout. A non-zero exit returns an
// error that wraps *exec.ExitError and carries the command's stderr.
func Run(ctx context.Context, name string, args ...string) (string, error) {
	return RunStdin(ctx, "", name, args...)
}

// RunStdin is Run with stdin as the command's standard input.
func RunStdin(ctx context.Context, stdin, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = waitDelay
	if err := cmd.Run(); err != nil {
		return stdout.String(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// Exited reports whether err comes from a command that ran and exited non-zero,
// as opposed to one that could not start.
func Exited(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit)
}

// Self is the running binary with symlinks resolved. The scheduler entries and
// the self-update point at it.
func Self() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate own executable: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve own executable %s: %w", exe, err)
	}
	return resolved, nil
}

// LaunchDomain is the launchd domain of the current user's GUI session.
func LaunchDomain() string {
	return fmt.Sprintf("gui/%d", os.Getuid())
}

// ReadCrontab returns the user's crontab. crontab -l exits non-zero when the
// user has no crontab yet, which reads as empty.
func ReadCrontab(ctx context.Context) (string, error) {
	out, err := Run(ctx, "crontab", "-l")
	if Exited(err) {
		return "", nil
	}
	return out, err
}

// WriteCrontab replaces the user's crontab with text.
func WriteCrontab(ctx context.Context, text string) error {
	_, err := RunStdin(ctx, text, "crontab", "-")
	return err
}

// IsTerminal reports whether v is an *os.File open on a terminal. /dev/null is
// a character device but not a terminal.
func IsTerminal(v any) bool {
	f, ok := v.(*os.File)
	return ok && term.IsTerminal(f.Fd())
}
