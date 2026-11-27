// Package logs appends to warmup.log, reads it back, and prunes everything in
// the log directory by age.
package logs

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

const (
	// stampLayout is the "[yyyy-MM-dd HH:mm:ss]" line prefix, in local time.
	// The arm scripts write the same format with date '+%Y-%m-%d %H:%M:%S'.
	stampLayout          = "2006-01-02 15:04:05"
	defaultRetentionDays = 14
	retentionEnv         = "WARMUP_LOG_RETENTION_DAYS"
	// maxUnstampedLines bounds a rolling log that has no stamps, such as raw launchd output.
	maxUnstampedLines = 2000
	day               = 24 * time.Hour
)

var (
	stampRE   = regexp.MustCompile(`^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]`)
	paneRE    = regexp.MustCompile(`^pane-.*\.txt$`)
	runLineRE = regexp.MustCompile(`OK:|WARN:|ERROR:|TICK `)
)

// Append writes "[stamp] line" to warmup.log and creates the log directory.
func Append(p paths.Paths, now time.Time, line string) error {
	if err := os.MkdirAll(p.LogDir, atomicfile.DirMode); err != nil {
		return fmt.Errorf("create %s: %w", p.LogDir, err)
	}
	f, err := os.OpenFile(p.WarmupLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, atomicfile.FileMode)
	if err != nil {
		return fmt.Errorf("open warmup log: %w", err)
	}
	// The flock pairs with pruneRolling, so a prune cannot drop this line.
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return fmt.Errorf("lock warmup log: %w", err)
	}
	if _, err := fmt.Fprintf(f, "[%s] %s\n", now.Format(stampLayout), line); err != nil {
		f.Close()
		return fmt.Errorf("append warmup log: %w", err)
	}
	return f.Close()
}

// RetentionDays is WARMUP_LOG_RETENTION_DAYS, or 14 when it is unset. The arm
// scripts read the same variable to prune their pane captures.
func RetentionDays() (int, error) {
	v := os.Getenv(retentionEnv)
	if v == "" {
		return defaultRetentionDays, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s: %q must be a whole number of days, 1 or more", retentionEnv, v)
	}
	return n, nil
}

// Prune drops rolling-log lines older than days, judged by their stamp, and
// deletes pane-*.txt captures modified before the cutoff. A missing log
// directory or log file is not an error.
func Prune(p paths.Paths, now time.Time, days int) error {
	cutoff := now.Add(-time.Duration(days) * day)
	for _, file := range []string{p.WarmupLog, p.CronLog, p.LaunchdOutLog, p.LaunchdErrLog} {
		if err := pruneRolling(file, cutoff); err != nil {
			return err
		}
	}
	return prunePanes(p.LogDir, cutoff)
}

// pruneRolling rewrites file in place under an flock that Append also takes.
// In place keeps the inode that launchd, cron, and less hold open. A rename
// would leave them writing to a deleted file.
// ponytail: the arm scripts and launchd append without the flock, so a line
// they write between the re-read and the truncate is lost. The window is
// microseconds, once per tick.
func pruneRolling(file string, cutoff time.Time) error {
	f, err := os.OpenFile(file, os.O_RDWR, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open %s: %w", file, err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock %s: %w", file, err)
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return fmt.Errorf("read %s: %w", file, err)
	}
	next := retainRecent(string(data), cutoff, maxUnstampedLines)
	if next == string(data) {
		return nil
	}
	// Keep what an unlocked appender wrote since the read.
	tail, err := io.ReadAll(f)
	if err != nil {
		return fmt.Errorf("read %s: %w", file, err)
	}
	if err := f.Truncate(0); err != nil {
		return fmt.Errorf("prune %s: %w", file, err)
	}
	if _, err := f.WriteAt(append([]byte(next), tail...), 0); err != nil {
		return fmt.Errorf("prune %s: %w", file, err)
	}
	return nil
}

func prunePanes(dir string, cutoff time.Time) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("list %s: %w", dir, err)
	}
	for _, e := range entries {
		if !paneRE.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue // an arm script pruned it first
		}
		if err != nil {
			return fmt.Errorf("stat %s: %w", e.Name(), err)
		}
		if !info.ModTime().Before(cutoff) {
			continue
		}
		err = os.Remove(filepath.Join(dir, e.Name()))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("delete %s: %w", e.Name(), err)
		}
	}
	return nil
}

// retainRecent keeps the lines at or after cutoff. A line belongs to the most
// recent stamp at or above it, so continuation lines such as pane dumps stay
// with their entry. Text with no stamp at all keeps its last maxLines lines.
func retainRecent(text string, cutoff time.Time, maxLines int) string {
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if text == "" {
		lines = nil
	}

	var kept []string
	sawStamp, keeping := false, false
	for _, line := range lines {
		if m := stampRE.FindStringSubmatch(line); m != nil {
			sawStamp = true
			at, err := time.ParseInLocation(stampLayout, m[1], time.Local)
			keeping = err == nil && !at.Before(cutoff)
		}
		if keeping {
			kept = append(kept, line)
		}
	}
	if !sawStamp {
		kept = lines[max(0, len(lines)-maxLines):]
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, "\n") + "\n"
}

// LastRun returns the newest warmup.log line that reports an outcome (OK:,
// WARN:, ERROR:, or TICK), else the last line. It returns "" when the log does
// not exist or is empty.
func LastRun(p paths.Paths) (string, error) {
	lines, err := readLines(p.WarmupLog)
	if err != nil || len(lines) == 0 {
		return "", err
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if runLineRE.MatchString(lines[i]) {
			return lines[i], nil
		}
	}
	return lines[len(lines)-1], nil
}

// Tail returns the last n lines of warmup.log, or none when it does not exist.
func Tail(p paths.Paths, n int) ([]string, error) {
	lines, err := readLines(p.WarmupLog)
	if err != nil {
		return nil, err
	}
	return lines[max(0, len(lines)-n):], nil
}

func readLines(file string) ([]string, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", file, err)
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil, nil
	}
	return strings.Split(text, "\n"), nil
}

// Entry is one warmup.log line. At is the line's stamp, or the stamp of the
// line above it for a continuation line. Text is the line without its stamp.
type Entry struct {
	At   time.Time
	Text string
}

// Recent returns the last n lines of warmup.log as entries, oldest first.
// Lines before the first stamp have a zero At.
func Recent(p paths.Paths, n int) ([]Entry, error) {
	lines, err := Tail(p, n)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, len(lines))
	var at time.Time
	for i, line := range lines {
		text := line
		if m := stampRE.FindStringSubmatch(line); m != nil {
			if t, err := time.ParseInLocation(stampLayout, m[1], time.Local); err == nil {
				at = t
			}
			text = strings.TrimPrefix(line[len(m[0]):], " ")
		}
		entries[i] = Entry{At: at, Text: text}
	}
	return entries, nil
}
