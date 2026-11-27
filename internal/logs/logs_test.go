package logs

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/paths"
)

func testPaths(t *testing.T) paths.Paths {
	t.Helper()
	t.Setenv("WARMUP_HOME", t.TempDir())
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRetainRecent(t *testing.T) {
	cutoff := time.Date(2026, 6, 5, 0, 0, 0, 0, time.Local)
	tests := []struct {
		name, in, want string
		maxLines       int
	}{
		{"drops old, keeps new", "[2026-06-01 10:00:00] old TICK\n[2026-06-10 09:00:00] fresh TICK\n", "[2026-06-10 09:00:00] fresh TICK\n", 10},
		{"continuation lines follow their stamp", "[2026-06-01 10:00:00] old\n  stale detail\n[2026-06-10 09:00:00] new\n  fresh detail\n", "[2026-06-10 09:00:00] new\n  fresh detail\n", 10},
		{"leading unstamped lines dropped", "preamble\n[2026-06-10 09:00:00] new\n", "[2026-06-10 09:00:00] new\n", 10},
		{"all old", "[2026-06-01 10:00:00] old\n", "", 10},
		{"empty", "", "", 10},
		{"no stamps keeps last N", "a\nb\nc\nd\ne\n", "d\ne\n", 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := retainRecent(tc.in, cutoff, tc.maxLines); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAppend(t *testing.T) {
	p := testPaths(t)
	if err := Append(p, time.Date(2026, 6, 13, 9, 5, 7, 0, time.Local), "TICK [kimi] warm"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p.WarmupLog); got != "[2026-06-13 09:05:07] TICK [kimi] warm\n" {
		t.Errorf("warmup.log = %q", got)
	}
}

func TestPrune(t *testing.T) {
	p := testPaths(t)
	now := time.Date(2026, 6, 13, 12, 0, 0, 0, time.Local)
	writeFile(t, p.WarmupLog, "[2026-06-01 10:00:00] old\n[2026-06-12 23:00:00] fresh\n")
	writeFile(t, p.CronLog, "[2026-06-01 10:00:00] old cron\n[2026-06-13 11:00:00] new cron\n")
	oldPane := filepath.Join(p.LogDir, "pane-old.txt")
	newPane := filepath.Join(p.LogDir, "pane-new.txt")
	notes := filepath.Join(p.LogDir, "notes.txt")
	writeFile(t, oldPane, "x")
	writeFile(t, newPane, "x")
	writeFile(t, notes, "x")
	threeDaysAgo := now.Add(-3 * day)
	if err := os.Chtimes(oldPane, threeDaysAgo, threeDaysAgo); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(notes, threeDaysAgo, threeDaysAgo); err != nil {
		t.Fatal(err)
	}

	if err := Prune(p, now, 1); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p.WarmupLog); got != "[2026-06-12 23:00:00] fresh\n" {
		t.Errorf("warmup.log = %q", got)
	}
	if got := readFile(t, p.CronLog); got != "[2026-06-13 11:00:00] new cron\n" {
		t.Errorf("cron.log = %q", got)
	}
	for path, want := range map[string]bool{oldPane: false, newPane: true, notes: true} {
		if _, err := os.Stat(path); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(path), err == nil, want)
		}
	}
}

func TestPruneMissingDir(t *testing.T) {
	if err := Prune(testPaths(t), time.Now(), 14); err != nil {
		t.Errorf("Prune on a missing log dir: %v", err)
	}
}

func TestRetentionDays(t *testing.T) {
	tests := []struct {
		env     string
		want    int
		wantErr bool
	}{
		{"", 14, false},
		{"3", 3, false},
		{"0", 0, true},
		{"soon", 0, true},
	}
	for _, tc := range tests {
		t.Setenv(retentionEnv, tc.env)
		got, err := RetentionDays()
		if got != tc.want || (err != nil) != tc.wantErr {
			t.Errorf("RetentionDays(%q) = %d, %v", tc.env, got, err)
		}
	}
}

func TestLastRunAndTail(t *testing.T) {
	p := testPaths(t)
	if got, err := LastRun(p); got != "" || err != nil {
		t.Errorf("LastRun on a missing log = %q, %v", got, err)
	}
	writeFile(t, p.WarmupLog, "")
	if got, err := LastRun(p); got != "" || err != nil {
		t.Errorf("LastRun on an empty log = %q, %v", got, err)
	}

	writeFile(t, p.WarmupLog, "[a] START codex\n[b] OK: replied\n[c] DONE codex\n")
	if got, _ := LastRun(p); got != "[b] OK: replied" {
		t.Errorf("LastRun = %q, want the OK line", got)
	}
	writeFile(t, p.WarmupLog, "[a] START codex\n[c] DONE codex\n")
	if got, _ := LastRun(p); got != "[c] DONE codex" {
		t.Errorf("LastRun without an outcome line = %q, want the last line", got)
	}

	lines, err := Tail(p, 1)
	if err != nil || !slices.Equal(lines, []string{"[c] DONE codex"}) {
		t.Errorf("Tail = %v, %v", lines, err)
	}
}

// TestPruneKeepsConcurrentAppends: a prune that rewrites the log while another
// process appends must not drop the appended lines, and must keep the inode
// that launchd and cron hold open.
func TestPruneKeepsConcurrentAppends(t *testing.T) {
	p := testPaths(t)
	now := time.Now()
	old := now.Add(-30 * day)
	if err := Append(p, now, "first"); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(p.WarmupLog)
	if err != nil {
		t.Fatal(err)
	}

	const appends = 300
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range appends {
			// The old line makes every prune rewrite the file.
			_ = Append(p, old, "old")
			_ = Append(p, now, "keep "+strconv.Itoa(i))
		}
	}()
	for running := true; running; {
		select {
		case <-done:
			running = false
		default:
		}
		if err := Prune(p, now, 14); err != nil {
			t.Fatal(err)
		}
	}

	text := readFile(t, p.WarmupLog)
	for i := range appends {
		if !strings.Contains(text, "] keep "+strconv.Itoa(i)+"\n") {
			t.Fatalf("append %d was lost", i)
		}
	}
	after, err := os.Stat(p.WarmupLog)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Error("prune replaced the log file")
	}
}

func TestRecent(t *testing.T) {
	p := testPaths(t)
	writeFile(t, p.WarmupLog, "orphan\n[2026-11-27 13:30:01] START claude\npane dump\n[2026-11-27 13:31:00] DONE claude (status=0)\n")
	got, err := Recent(p, 10)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 27, 13, 30, 1, 0, time.Local)
	done := time.Date(2026, 11, 27, 13, 31, 0, 0, time.Local)
	want := []Entry{{Text: "orphan"}, {start, "START claude"}, {start, "pane dump"}, {done, "DONE claude (status=0)"}}
	if !slices.Equal(got, want) {
		t.Errorf("Recent = %+v, want %+v", got, want)
	}
}
