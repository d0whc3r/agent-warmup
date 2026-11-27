package warmup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

type LogMode string

const (
	LogsStatic LogMode = "static" // open at the newest line
	LogsFollow LogMode = "follow" // keep printing new lines
)

const (
	tailLines = 60
	lessHint  = "q quit  /=search  &=filter  F=follow"
)

// followPoll is how often the follow loop checks the log for new bytes.
// Tests shorten it.
var followPoll = 500 * time.Millisecond

// ViewLogs shows warmup.log. When out is a terminal it hands the file to
// less. Without a terminal or without less, it prints the last 60 lines and,
// in LogsFollow, follows the file until ctx ends. It returns the exit status.
func ViewLogs(ctx context.Context, p paths.Paths, mode LogMode, out io.Writer) (int, error) {
	if _, err := os.Stat(p.WarmupLog); errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintln(out, "No logs yet. Run a warmup first.")
		return 0, nil
	}
	if sysexec.IsTerminal(out) {
		status, err := runLess(ctx, p, mode)
		if !errors.Is(err, exec.ErrNotFound) {
			return status, err
		}
	}

	lines, err := logs.Tail(p, tailLines)
	if err != nil {
		return statusFailed, err
	}
	if len(lines) > 0 {
		fmt.Fprint(out, strings.Join(lines, "\n")+"\n")
	}
	if mode != LogsFollow {
		return 0, nil
	}
	return 0, follow(ctx, p.WarmupLog, out)
}

// runLess ignores the cancel of ctx on purpose. Ctrl-C in less +F reaches
// this process too and cancels the signal context. A SIGKILL would leave
// the terminal in raw mode. less exits by itself on q.
func runLess(ctx context.Context, p paths.Paths, mode LogMode) (int, error) {
	start := "+G"
	if mode == LogsFollow {
		start = "+F"
	}
	cmd := exec.CommandContext(context.WithoutCancel(ctx), "less", "-R", start, "-PM"+lessHint, p.WarmupLog)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return statusFailed, fmt.Errorf("run less: %w", err)
	}
	return 0, nil
}

// follow prints bytes appended to file until ctx ends. When the file
// shrinks (a prune rewrote it) it continues from the new end.
func follow(ctx context.Context, file string, out io.Writer) error {
	info, err := os.Stat(file)
	if err != nil {
		return fmt.Errorf("stat %s: %w", file, err)
	}
	offset := info.Size()
	ticker := time.NewTicker(followPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		next, err := copyFrom(file, offset, out)
		if err != nil {
			return err
		}
		offset = next
	}
}

func copyFrom(file string, offset int64, out io.Writer) (int64, error) {
	f, err := os.Open(file)
	if err != nil {
		return offset, fmt.Errorf("open %s: %w", file, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return offset, fmt.Errorf("stat %s: %w", file, err)
	}
	if info.Size() <= offset {
		return info.Size(), nil
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, fmt.Errorf("seek %s: %w", file, err)
	}
	n, err := io.Copy(out, f)
	if err != nil {
		return offset + n, fmt.Errorf("follow %s: %w", file, err)
	}
	return offset + n, nil
}
