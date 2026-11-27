package tui

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/golden"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// at is a time on the test day, 2026-11-27, in local time.
func at(h, m int) time.Time { return time.Date(2026, 11, 27, h, m, 0, 0, time.Local) }

var testNow = at(13, 42)

func pct(n int) *int { return &n }

func fakeSnapshot() Snapshot {
	return Snapshot{
		Active: true,
		Cache: domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{
			domain.Claude: {Usage: domain.Usage{
				Session:    &domain.LimitBlock{Pct: pct(42), Active: true, ResetsAt: at(15, 30)},
				Week:       &domain.LimitBlock{Pct: pct(18), ResetsAt: time.Date(2026, 12, 1, 9, 0, 0, 0, time.Local)},
				CapturedAt: at(13, 37),
			}},
			domain.Codex: {LastWarmAt: at(11, 5)},
		}},
		Log: []logs.Entry{
			{At: at(10, 30), Text: "TICK [claude] warm — no active window [via probe]"},
			{At: at(10, 30), Text: "START claude (model=haiku workdir=/tmp/warmup)"},
			{At: at(10, 30), Text: "OK: Claude Code replied -> usage window armed"},
			{At: at(10, 30), Text: "DONE claude (status=0)"},
			{At: at(11, 5), Text: "TICK [codex] warm — no recent warmup (usage estimated) [via cache]"},
			{At: at(11, 6), Text: "DONE codex (status=0)"},
			{At: at(13, 30), Text: "TICK [claude] skip-active — window active until 15:30 [via probe]"},
		},
	}
}

// calls records which fake actions ran.
type calls struct{ apply, stop, run, detect int }

// testDeps saves a config with claude and codex enabled in a temp home, so
// a test can compare the file with what it expects.
func testDeps(t *testing.T, c *calls, edit func(*domain.Config)) Deps {
	t.Helper()
	t.Setenv("WARMUP_HOME", t.TempDir())
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.WithProvider(config.Defaults(), domain.Codex, func(pc *domain.ProviderConfig) { pc.Enabled = true })
	if edit != nil {
		edit(&cfg)
	}
	if err := config.Save(p, cfg); err != nil {
		t.Fatal(err)
	}
	return Deps{
		Paths:  p,
		Config: cfg,
		Now:    func() time.Time { return testNow },
		Actions: Actions{
			Snapshot: func(context.Context, domain.Config) (Snapshot, error) { return fakeSnapshot(), nil },
			ApplySchedule: func(context.Context, domain.Config) error {
				c.apply++
				return nil
			},
			StopSchedule: func(context.Context) error {
				c.stop++
				return nil
			},
			RunNow: func(context.Context, domain.Config) ([]warmup.RunResult, error) {
				c.run++
				return []warmup.RunResult{{ID: domain.Claude}, {ID: domain.Codex, Status: 124}}, nil
			},
			Detect: func(_ context.Context, _ domain.Config, id domain.ProviderID) (string, error) {
				c.detect++
				if id == domain.Zai {
					return "", errors.New(`no "zai-coding-plan" credential in opencode`)
				}
				return "/usr/local/bin/" + string(id), nil
			},
		},
	}
}

func enableAll(cfg *domain.Config) {
	for _, id := range domain.ProviderIDs {
		*cfg = config.WithProvider(*cfg, id, func(pc *domain.ProviderConfig) { pc.Enabled = true })
	}
}

// newTestModel returns a sized model whose first refresh has returned.
func newTestModel(t *testing.T, w, h int, edits ...func(*domain.Config)) (model, *calls) {
	t.Helper()
	c := &calls{}
	deps := testDeps(t, c, func(cfg *domain.Config) {
		for _, e := range edits {
			e(cfg)
		}
	})
	m := newModel(t.Context(), deps)
	m = update(m, tea.WindowSizeMsg{Width: w, Height: h})
	m = update(m, snapshotMsg{snap: fakeSnapshot()})
	return m, c
}

func update(m model, msg tea.Msg) model {
	next, _ := m.Update(msg)
	return next.(model)
}

// press sends keys one by one and runs the commands each returns.
func press(t *testing.T, m model, ks ...string) model {
	t.Helper()
	for _, k := range ks {
		next, cmd := m.Update(keyMsg(k))
		m = drain(t, next.(model), cmd)
	}
	return m
}

// typeText types s into the open input, one key per rune.
func typeText(t *testing.T, m model, s string) model {
	t.Helper()
	for _, r := range s {
		next, cmd := m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
		m = drain(t, next.(model), cmd)
	}
	return m
}

// cmdWait is how long drain waits for a command. A command that takes longer
// is a timer (spinner, clock, log poll, cursor blink), which drain drops.
const cmdWait = 50 * time.Millisecond

// drain runs cmd and feeds its messages back into Update, the way the
// program loop delivers them.
func drain(t *testing.T, m model, cmd tea.Cmd) model {
	t.Helper()
	if cmd == nil {
		return m
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	var msg tea.Msg
	select {
	case msg = <-done:
	case <-time.After(cmdWait):
		return m
	}
	switch msg := msg.(type) {
	case nil, spinner.TickMsg, clockMsg, logPollMsg, tea.QuitMsg:
		return m
	case tea.BatchMsg:
		for _, c := range msg {
			m = drain(t, m, c)
		}
		return m
	default:
		next, more := m.Update(msg)
		return drain(t, next.(model), more)
	}
}

func keyMsg(k string) tea.KeyPressMsg {
	switch k {
	case "ctrl+c":
		return tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
	case "ctrl+u":
		return tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl}
	}
	return keyPress(k)
}

func frame(m model) string { return ansi.Strip(m.View().Content) }

func assertFits(t *testing.T, frame string, w, h int) {
	t.Helper()
	lines := strings.Split(frame, "\n")
	if len(lines) != h {
		t.Errorf("frame has %d lines, want %d", len(lines), h)
	}
	for i, line := range lines {
		if got := ansi.StringWidth(line); got > w {
			t.Errorf("line %d is %d wide, max %d: %q", i+1, got, w, line)
		}
	}
}

type size struct {
	name string
	w, h int
}

var sizes = []size{{"80x24", 80, 24}, {"120x32", 120, 32}, {"160x40", 160, 40}}

func TestRender(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	screens := []struct {
		name  string
		edits []func(*domain.Config)
		keys  []string
	}{
		{"lanes", nil, nil},
		{"all_agents", []func(*domain.Config){enableAll}, nil},
		{"panel", nil, []string{"enter"}},
		{"help", nil, []string{"?"}},
		{"command", nil, []string{"/", "h", "o"}},
	}
	for _, s := range sizes {
		for _, sc := range screens {
			t.Run(sc.name+"_"+s.name, func(t *testing.T) {
				m, _ := newTestModel(t, s.w, s.h, sc.edits...)
				m = press(t, m, sc.keys...)
				got := frame(m)
				assertFits(t, got, s.w, s.h)
				golden.RequireEqual(t, got)
			})
		}
	}
}

// TestRenderFits: every screen, with all seven agents enabled, fills the
// terminal exactly and no line is wider than it.
func TestRenderFits(t *testing.T) {
	screens := map[string][]string{"lanes": nil, "panel": {"enter"}, "help": {"?"}, "logs": {"v"}, "command": {"/"}}
	for _, s := range append(sizes, size{"100x30", 100, 30}) {
		for name, ks := range screens {
			m, _ := newTestModel(t, s.w, s.h, enableAll)
			m = press(t, m, ks...)
			assertFits(t, frame(m), s.w, s.h)
			if t.Failed() {
				t.Fatalf("%s %s:\n%s", s.name, name, frame(m))
			}
		}
	}
}

func TestRenderFitsLongError(t *testing.T) {
	m, _ := newTestModel(t, 80, 24, enableAll)
	m = press(t, m, "/")
	m = typeText(t, m, "hours claude 30-40")
	m = press(t, m, "enter")
	assertFits(t, frame(m), 80, 24)
}

func TestNothingRendersBeforeSize(t *testing.T) {
	m := newModel(t.Context(), testDeps(t, &calls{}, nil))
	if got := m.View().Content; got != "" {
		t.Fatalf("view before WindowSizeMsg = %q, want empty", got)
	}
}

func TestInitReadsSnapshot(t *testing.T) {
	m := newModel(t.Context(), testDeps(t, &calls{}, nil))
	m = update(m, tea.WindowSizeMsg{Width: 80, Height: 24})
	if !strings.Contains(frame(m), "checking") {
		t.Fatalf("header before the snapshot should say checking:\n%s", frame(m))
	}
	m = drain(t, m, m.Init())
	if m.snap == nil || !strings.Contains(frame(m), markOn+" active") {
		t.Fatalf("snapshot not shown after Init:\n%s", frame(m))
	}
}

// TestQuitWaitsForRunningJob: after quit, Run cancels the context and must
// wait for a running warmup, so the arm is killed and its result recorded
// before the process exits.
func TestQuitWaitsForRunningJob(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	deps := testDeps(t, &calls{}, nil)
	started, recorded := make(chan struct{}), false
	deps.Actions.RunNow = func(ctx context.Context, _ domain.Config) ([]warmup.RunResult, error) {
		close(started)
		<-ctx.Done()
		time.Sleep(50 * time.Millisecond) // the arm's process group dies and RecordArm writes
		recorded = true
		return nil, ctx.Err()
	}
	m := newModel(ctx, deps)
	m = update(m, tea.WindowSizeMsg{Width: 80, Height: 24})
	m = update(m, snapshotMsg{snap: fakeSnapshot()})
	_, cmd := m.Update(keyMsg("r"))
	batch, ok := cmd().(tea.BatchMsg)
	if !ok {
		t.Fatal("run key did not return a batch")
	}
	go batch[0]()
	<-started

	cancel()
	m.jobs.wait()
	if !recorded {
		t.Error("wait returned before the job finished")
	}
}
