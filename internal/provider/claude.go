package provider

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// claude drives Claude Code's /usage screen in a throwaway tmux session.
type claude struct{ base }

const (
	defaultReadyWait    = 12 * time.Second
	defaultResponseWait = 6 * time.Second
	trustKeyWait        = 500 * time.Millisecond
	trustSettleWait     = 4 * time.Second
	typeWait            = time.Second
	tmuxCallTimeout     = 10 * time.Second
	cleanupTimeout      = 5 * time.Second

	paneWidth     = "220"
	paneHeight    = "55"
	paneScrollTop = "-200"

	headingSession  = "Current session"
	headingWeekAll  = "Current week (all models)"
	blockLines      = 4
	dayDuration     = 24 * time.Hour
	trustCursorText = "Yes, I trust this folder"
)

var (
	// The second weekly heading names the model Claude caps separately
	// ("Fable" today, "Sonnet only" before), so match its shape.
	modelWeekHeading = regexp.MustCompile(`^Current week \((.+)\)$`)
	pctUsed          = regexp.MustCompile(`(\d+)%\s*used`)
	resetPhrase      = regexp.MustCompile(`(?m)Resets\s+(.+?)\s*(?:\(|$)`)
	trustPrompt      = regexp.MustCompile(`(?i)trust this folder|do you trust|project you (created|trust)`)
	datedReset       = regexp.MustCompile(`(?i)^([A-Za-z]{3,})\s+(\d{1,2})\s+at\s+(.+)$`)
	clockTime        = regexp.MustCompile(`(?i)^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$`)
)

func (claude) ProbeKind() ProbeKind { return ProbeLive }

func (c claude) ArmEnv(pc ProbeContext) map[string]string {
	return map[string]string{
		"CLAUDE_BIN":           pc.Paths.ExpandHome(pc.Cfg.Binary),
		"WARMUP_PROVIDER_NAME": c.name,
	}
}

// InferFromCache drops the week: Claude's weekly figure only comes from a live probe.
func (claude) InferFromCache(pc ProbeContext, entry domain.CacheEntry) domain.Usage {
	u := inferWindow(pc.Now, entry)
	u.Week = nil
	return u
}

func (claude) Decide(pc ProbeContext, u domain.Usage, _ domain.CacheEntry) domain.Decision {
	if d, ok := decideGates(pc, u); ok {
		return d
	}
	if u.Session != nil && u.Session.Active {
		return activeUntil(u.Session.ResetsAt)
	}
	if u.Inferred {
		return domain.Decision{Action: domain.ActionWarm, Reason: "no recent warmup (probe failed)"}
	}
	return domain.Decision{Action: domain.ActionWarm, Reason: "no active window"}
}

// RecordArm has no circuit breaker: a failed arm leaves the entry unchanged.
func (claude) RecordArm(pc ProbeContext, entry domain.CacheEntry, status int) (domain.CacheEntry, string) {
	if status == 0 {
		entry.LastWarmAt = pc.Now
	}
	return entry, ""
}

// Probe opens /usage in a tmux session named <tmux_session>-usage and parses
// the pane. Running /usage sends no message, so it never arms a window.
func (claude) Probe(ctx context.Context, pc ProbeContext) (domain.Usage, error) {
	binary := pc.Paths.ExpandHome(pc.Cfg.Binary)
	if err := checkExecutable(binary); err != nil {
		return domain.Usage{}, fmt.Errorf("claude binary: %w", err)
	}
	tmuxBin, err := exec.LookPath(pc.Paths.Tmux)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("tmux: %w", err)
	}
	readyWait, err := envSeconds("WARMUP_READY_WAIT", defaultReadyWait)
	if err != nil {
		return domain.Usage{}, err
	}
	responseWait, err := envSeconds("WARMUP_RESPONSE_WAIT", defaultResponseWait)
	if err != nil {
		return domain.Usage{}, err
	}
	if err := os.MkdirAll(pc.Paths.Workdir, 0o700); err != nil {
		return domain.Usage{}, fmt.Errorf("create workdir: %w", err)
	}

	t := tmuxSession{bin: tmuxBin, name: pc.ID.TmuxSession() + "-usage"}
	// Usually no session is left over from a crashed probe.
	_, _ = t.run(ctx, "kill-session", "-t", "="+t.name)
	defer t.close(ctx)

	_, err = t.run(ctx, "new-session", "-d", "-s", t.name, "-x", paneWidth, "-y", paneHeight,
		"-c", pc.Paths.Workdir, binary, "--safe-mode", "--model", pc.Cfg.Model)
	if err != nil {
		return domain.Usage{}, err
	}
	text, err := t.driveUsage(ctx, readyWait, responseWait)
	if err != nil {
		return domain.Usage{}, err
	}

	u := parseUsage(text, pc.Now)
	if u.Session == nil && u.Week == nil {
		return domain.Usage{}, errors.New("claude /usage pane has no session or week block")
	}
	u.CapturedAt = pc.Now
	return u, nil
}

type tmuxSession struct{ bin, name string }

// run runs one tmux command with its own timeout and returns stdout.
func (t tmuxSession) run(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, tmuxCallTimeout)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, t.bin, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		// A kill by the deadline reads "signal: killed", so report the deadline.
		if ctxErr := ctx.Err(); ctxErr != nil {
			err = ctxErr
		}
		return "", fmt.Errorf("tmux %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func (t tmuxSession) keys(ctx context.Context, keys ...string) error {
	_, err := t.run(ctx, append([]string{"send-keys", "-t", t.name}, keys...)...)
	return err
}

// driveUsage accepts a trust prompt when one shows, types /usage, and returns
// the captured pane.
func (t tmuxSession) driveUsage(ctx context.Context, readyWait, responseWait time.Duration) (string, error) {
	if err := sleep(ctx, readyWait); err != nil {
		return "", err
	}
	shown, err := t.run(ctx, "capture-pane", "-p", "-t", t.name)
	if err != nil {
		return "", err
	}
	if trustPrompt.MatchString(shown) {
		if err := t.acceptTrust(ctx, shown); err != nil {
			return "", err
		}
	}

	steps := []struct {
		keys []string
		wait time.Duration
	}{
		{[]string{"-l", "/usage"}, typeWait},
		{[]string{"Enter"}, responseWait},
	}
	for _, s := range steps {
		if err := t.keys(ctx, s.keys...); err != nil {
			return "", err
		}
		if err := sleep(ctx, s.wait); err != nil {
			return "", err
		}
	}
	return t.run(ctx, "capture-pane", "-p", "-t", t.name, "-S", paneScrollTop)
}

// acceptTrust answers both trust layouts. The cursor list highlights "No, exit"
// first, so Down moves onto "Yes". The numbered list takes the digit.
func (t tmuxSession) acceptTrust(ctx context.Context, shown string) error {
	key := "1"
	if strings.Contains(shown, trustCursorText) {
		key = "Down"
	}
	if err := t.keys(ctx, key); err != nil {
		return err
	}
	if err := sleep(ctx, trustKeyWait); err != nil {
		return err
	}
	if err := t.keys(ctx, "Enter"); err != nil {
		return err
	}
	return sleep(ctx, trustSettleWait)
}

// close leaves /usage and kills the session. It can run after ctx is
// canceled, and the session can already be gone, so close reports no errors.
func (t tmuxSession) close(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	_ = t.keys(ctx, "Escape")
	_, _ = t.run(ctx, "kill-session", "-t", "="+t.name)
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// envSeconds reads a positive number of seconds from key, or def when unset.
func envSeconds(key string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s: %q is not a positive number of seconds", key, raw)
	}
	return time.Duration(n * float64(time.Second)), nil
}

func checkExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s is not an executable file", path)
	}
	return nil
}

// parseUsage reads the three limit blocks of a /usage pane.
func parseUsage(text string, now time.Time) domain.Usage {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}

	u := domain.Usage{
		Session: parseBlock(lines, slices.Index(lines, headingSession), now),
		Week:    parseBlock(lines, slices.Index(lines, headingWeekAll), now),
	}
	modelIdx := slices.IndexFunc(lines, func(l string) bool {
		return l != headingWeekAll && modelWeekHeading.MatchString(l)
	})
	if block := parseBlock(lines, modelIdx, now); block != nil {
		label := modelWeekHeading.FindStringSubmatch(lines[modelIdx])[1]
		u.WeekModel = &domain.ModelLimitBlock{LimitBlock: *block, Label: label}
	}
	if s := u.Session; s != nil {
		s.Active = s.Pct != nil && *s.Pct > 0 && s.ResetsAt.After(now)
	}
	return u
}

// parseBlock reads the blockLines lines after the heading at i, or returns nil
// when i < 0.
func parseBlock(lines []string, i int, now time.Time) *domain.LimitBlock {
	if i < 0 {
		return nil
	}
	win := strings.Join(lines[i+1:min(len(lines), i+1+blockLines)], "\n")
	block := &domain.LimitBlock{}
	if m := pctUsed.FindStringSubmatch(win); m != nil {
		n, _ := strconv.Atoi(m[1]) // \d+ always parses
		block.Pct = &n
	}
	if m := resetPhrase.FindStringSubmatch(win); m != nil {
		block.ResetsAt = parseReset(m[1], now)
	}
	return block
}

// parseReset turns a "Resets ..." phrase into a local time relative to now:
// "3:30pm" is today, or tomorrow when not after now. "Jun 14 at 11am" is that
// day this year, or next year when more than a day in the past. An unreadable
// phrase gives the zero time.
func parseReset(phrase string, now time.Time) time.Time {
	text := strings.TrimSpace(phrase)
	now = now.Local()
	if m := datedReset.FindStringSubmatch(text); m != nil {
		month, okMonth := parseMonth(m[1])
		hour, minute, okClock := parseClock(m[3])
		if !okMonth || !okClock {
			return time.Time{}
		}
		day, _ := strconv.Atoi(m[2]) // \d{1,2} always parses
		d := time.Date(now.Year(), month, day, hour, minute, 0, 0, time.Local)
		if now.Sub(d) > dayDuration {
			d = d.AddDate(1, 0, 0)
		}
		return d
	}
	hour, minute, ok := parseClock(text)
	if !ok {
		return time.Time{}
	}
	d := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.Local)
	if !d.After(now) {
		d = d.AddDate(0, 0, 1)
	}
	return d
}

// parseClock reads "3:30pm", "11am", or "12am" into 24-hour hour and minute.
func parseClock(s string) (hour, minute int, ok bool) {
	m := clockTime.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, 0, false
	}
	hour, _ = strconv.Atoi(m[1]) // \d{1,2} always parses
	hour %= 12
	if strings.EqualFold(m[3], "pm") {
		hour += 12
	}
	if m[2] != "" {
		minute, _ = strconv.Atoi(m[2])
	}
	return hour, minute, true
}

// parseMonth reads the first three letters of an English month name.
func parseMonth(name string) (time.Month, bool) {
	prefix := strings.ToLower(name[:3])
	for m := time.January; m <= time.December; m++ {
		if strings.ToLower(m.String()[:3]) == prefix {
			return m, true
		}
	}
	return 0, false
}
