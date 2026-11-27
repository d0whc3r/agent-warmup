package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

func readFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertBlock(t *testing.T, name string, b *domain.LimitBlock, pct int, resets time.Time) {
	t.Helper()
	if b == nil || b.Pct == nil {
		t.Fatalf("%s block = %+v, want pct %d", name, b, pct)
	}
	if *b.Pct != pct || !b.ResetsAt.Equal(resets) {
		t.Errorf("%s = %d%% resets %v, want %d%% resets %v", name, *b.Pct, b.ResetsAt, pct, resets)
	}
}

func local(y int, mo time.Month, d, h, mi int) time.Time {
	return time.Date(y, mo, d, h, mi, 0, 0, time.Local)
}

func TestParseUsage(t *testing.T) {
	now := local(2026, 6, 13, 13, 0)
	u := parseUsage(readFixture(t, "usage-2026-06.txt"), now)
	assertBlock(t, "session", u.Session, 30, local(2026, 6, 13, 15, 30))
	assertBlock(t, "week", u.Week, 4, local(2026, 6, 14, 11, 0))
	if !u.Session.Active {
		t.Error("session should be active")
	}
	if u.WeekModel == nil || u.WeekModel.Label != "Sonnet only" {
		t.Fatalf("weekModel = %+v", u.WeekModel)
	}
	assertBlock(t, "weekModel", &u.WeekModel.LimitBlock, 0, time.Time{})
}

func TestParseUsageRenamedModelHeading(t *testing.T) {
	now := local(2026, 9, 6, 7, 0)
	u := parseUsage(readFixture(t, "usage-2026-09.txt"), now)
	assertBlock(t, "session", u.Session, 93, local(2026, 9, 6, 8, 59))
	assertBlock(t, "week", u.Week, 36, local(2026, 9, 6, 10, 59))
	if u.WeekModel == nil || u.WeekModel.Label != "Fable" {
		t.Fatalf("weekModel = %+v", u.WeekModel)
	}
	assertBlock(t, "weekModel", &u.WeekModel.LimitBlock, 45, local(2026, 9, 6, 10, 59))
}

func TestParseUsageTwoBlocks(t *testing.T) {
	u := parseUsage(readFixture(t, "usage-two-blocks.txt"), local(2026, 6, 13, 13, 0))
	if u.WeekModel != nil {
		t.Errorf("weekModel = %+v, want nil", u.WeekModel)
	}
	// A fresh 0% session has no reset line and is not active.
	assertBlock(t, "session", u.Session, 0, time.Time{})
	if u.Session.Active {
		t.Error("0% session should not be active")
	}
}

func TestParseReset(t *testing.T) {
	cases := []struct {
		phrase string
		now    time.Time
		want   time.Time
	}{
		{"3:30pm", local(2026, 6, 13, 13, 0), local(2026, 6, 13, 15, 30)},
		{"1:00am", local(2026, 6, 13, 22, 0), local(2026, 6, 14, 1, 0)},
		{"1pm", local(2026, 6, 13, 13, 0), local(2026, 6, 14, 13, 0)}, // not after now
		{"12pm", local(2026, 6, 13, 8, 0), local(2026, 6, 13, 12, 0)},
		{"11:30am", local(2026, 6, 13, 8, 0), local(2026, 6, 13, 11, 30)},
		{"12am", local(2026, 6, 13, 10, 0), local(2026, 6, 14, 0, 0)},
		{"12:30pm", local(2026, 6, 13, 10, 0), local(2026, 6, 13, 12, 30)},
		{"Jun 14 at 11am", local(2026, 6, 13, 13, 0), local(2026, 6, 14, 11, 0)},
		{"Jun 12 at 11am", local(2026, 6, 13, 10, 0), local(2026, 6, 12, 11, 0)}, // under a day past
		{"Jun 14 at 11am", local(2026, 12, 15, 10, 0), local(2027, 6, 14, 11, 0)},
		{"pretty soon", local(2026, 6, 13, 10, 0), time.Time{}},
		{"Foo 14 at 11am", local(2026, 6, 13, 10, 0), time.Time{}},
		{"Jun 14 at sometime", local(2026, 6, 13, 10, 0), time.Time{}},
	}
	for _, tc := range cases {
		if got := parseReset(tc.phrase, tc.now); !got.Equal(tc.want) {
			t.Errorf("parseReset(%q, %v) = %v, want %v", tc.phrase, tc.now, got, tc.want)
		}
	}
}

const (
	trustCursorPane   = "Do you trust the files in this folder?\n  ❯ 1. No, exit\n    2. Yes, I trust this folder"
	trustNumberedPane = "Do you trust the files in this folder?\n  1. Yes, proceed\n  2. No, exit"
	readyPane         = "Welcome to Claude Code"
	usagePane         = "  Current session\n  ███   30% used\n  Resets 3:30pm (Europe/Madrid)\n\n" +
		"  Current week (all models)\n  ██   4% used\n  Resets Jun 14 at 11am (Europe/Madrid)"
)

// fakeClaude points TMUX_BIN at testdata/fake-tmux.sh and returns a probe
// context with a stub claude binary and the tmux fake's state directory.
func fakeClaude(t *testing.T, initialPane string) (ProbeContext, string) {
	t.Helper()
	stub, err := filepath.Abs("testdata/fake-tmux.sh")
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	t.Setenv("TMUX_BIN", stub)
	t.Setenv("TMUX_FAKE_DIR", state)
	t.Setenv("TMUX_INITIAL_PANE", initialPane)
	t.Setenv("TMUX_READY_PANE", readyPane)
	t.Setenv("TMUX_USAGE_PANE", usagePane)
	t.Setenv("WARMUP_READY_WAIT", "0.01")
	t.Setenv("WARMUP_RESPONSE_WAIT", "0.01")

	binary := filepath.Join(state, "claude")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	pc := pcAt(domain.Claude, local(2026, 6, 13, 13, 0))
	pc.Paths = testPaths(t)
	pc.Cfg.Binary = binary
	return pc, state
}

func sentKeys(t *testing.T, state string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(state, "keys"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestClaudeProbe(t *testing.T) {
	cases := []struct {
		name      string
		pane      string
		wantFirst string // first key sent
	}{
		{"cursor trust prompt", trustCursorPane, "Down"},
		{"numbered trust prompt", trustNumberedPane, "1"},
		{"ready session", readyPane, "/usage"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pc, state := fakeClaude(t, tc.pane)
			u, err := Get(domain.Claude).Probe(context.Background(), pc)
			if err != nil {
				t.Fatal(err)
			}
			assertBlock(t, "session", u.Session, 30, local(2026, 6, 13, 15, 30))
			assertBlock(t, "week", u.Week, 4, local(2026, 6, 14, 11, 0))
			if !u.CapturedAt.Equal(pc.Now) {
				t.Errorf("CapturedAt = %v", u.CapturedAt)
			}
			keys := sentKeys(t, state)
			if keys[0] != tc.wantFirst || keys[len(keys)-1] != "Escape" {
				t.Errorf("keys = %v", keys)
			}
		})
	}
}

func TestClaudeProbeErrors(t *testing.T) {
	t.Run("no limit blocks", func(t *testing.T) {
		pc, _ := fakeClaude(t, readyPane)
		t.Setenv("TMUX_USAGE_PANE", "nothing to see here")
		if _, err := Get(domain.Claude).Probe(context.Background(), pc); err == nil {
			t.Error("want an error")
		}
	})
	t.Run("missing binary", func(t *testing.T) {
		pc, _ := fakeClaude(t, readyPane)
		pc.Cfg.Binary = filepath.Join(t.TempDir(), "missing-claude")
		if _, err := Get(domain.Claude).Probe(context.Background(), pc); err == nil {
			t.Error("want an error")
		}
	})
	t.Run("new-session fails", func(t *testing.T) {
		pc, _ := fakeClaude(t, readyPane)
		t.Setenv("TMUX_NEW_SESSION_STATUS", "1")
		if _, err := Get(domain.Claude).Probe(context.Background(), pc); err == nil {
			t.Error("want an error")
		}
	})
	t.Run("canceled during the ready wait", func(t *testing.T) {
		pc, _ := fakeClaude(t, readyPane)
		t.Setenv("WARMUP_READY_WAIT", "30")
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if _, err := Get(domain.Claude).Probe(ctx, pc); !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("err = %v, want DeadlineExceeded", err)
		}
	})
	t.Run("bad wait value", func(t *testing.T) {
		pc, _ := fakeClaude(t, readyPane)
		t.Setenv("WARMUP_READY_WAIT", "soon")
		if _, err := Get(domain.Claude).Probe(context.Background(), pc); err == nil {
			t.Error("want an error")
		}
	})
}
