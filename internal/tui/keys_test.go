package tui

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// Edit panel rows, in rows order.
const (
	rowEnabled = iota
	rowModel
	rowWork
	rowWeekly
	rowBinary
)

func saved(t *testing.T, m model) domain.Config {
	t.Helper()
	cfg, err := config.Load(m.deps.Paths)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// toRow opens the edit panel on the selected agent and moves to row.
func toRow(t *testing.T, m model, row int) model {
	t.Helper()
	m = press(t, m, "enter")
	for range row {
		m = press(t, m, "down")
	}
	return m
}

func TestKeyToggle(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "down", "space")
	if saved(t, m).Providers[domain.Codex].Enabled || !m.unapplied {
		t.Fatalf("space did not turn codex off and mark the schedule unapplied:\n%s", frame(m))
	}
	if !strings.Contains(frame(m), markPending+" unapplied") {
		t.Errorf("header does not show unapplied:\n%s", frame(m))
	}
	m = press(t, m, "space")
	if !saved(t, m).Providers[domain.Codex].Enabled {
		t.Error("second space did not turn codex on")
	}
}

func TestKeyModel(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "m")
	if got := saved(t, m).Providers[domain.Claude].Model; got != "sonnet" {
		t.Errorf("m: model = %q, want sonnet", got)
	}
	m = toRow(t, m, rowModel)
	m = press(t, m, "left")
	if got := saved(t, m).Providers[domain.Claude].Model; got != "haiku" {
		t.Errorf("panel ←: model = %q, want haiku", got)
	}
}

func TestKeyBinary(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = toRow(t, m, rowBinary)
	m = press(t, m, "enter", "ctrl+u")
	m = typeText(t, m, "/opt/claude/bin/claude")
	m = press(t, m, "enter")
	if got := saved(t, m).Providers[domain.Claude].Binary; got != "/opt/claude/bin/claude" || m.prompt != nil {
		t.Errorf("binary = %q, prompt open = %v", got, m.prompt != nil)
	}
}

func TestKeyEscCancelsField(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = toRow(t, m, rowBinary)
	m = press(t, m, "enter")
	m = typeText(t, m, "-x")
	m = press(t, m, "esc")
	if got := saved(t, m).Providers[domain.Claude].Binary; got != "~/.local/bin/claude" || m.prompt != nil {
		t.Errorf("esc saved %q or left the input open", got)
	}
}

func TestKeyWorkHours(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "left", "left", "left", "left", "[")
	pc := saved(t, m).Providers[domain.Claude]
	if pc.WorkStart != 9 || pc.WorkEnd != 23 {
		t.Fatalf("[ at 09: work hours %d-%d, want 9-23", pc.WorkStart, pc.WorkEnd)
	}
	m = press(t, m, "l", "l", "l", "l", "l", "l", "l", "l", "]")
	pc = saved(t, m).Providers[domain.Claude]
	if pc.WorkStart != 9 || pc.WorkEnd != 18 {
		t.Errorf("] at 17: work hours %d-%d, want 9-18", pc.WorkStart, pc.WorkEnd)
	}
}

func TestKeyWeeklyStop(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = toRow(t, m, rowWeekly)
	m = press(t, m, "left")
	if got := saved(t, m).Providers[domain.Claude].WeeklyStopPercent; got != 85 {
		t.Errorf("← on weekly stop: %d, want 85", got)
	}
	m = press(t, m, "esc", "w", "ctrl+u")
	m = typeText(t, m, "70")
	m = press(t, m, "enter")
	if got := saved(t, m).Providers[domain.Claude].WeeklyStopPercent; got != 70 || m.prompt != nil {
		t.Errorf("w: weekly stop = %d, prompt open = %v", got, m.prompt != nil)
	}
}

func TestKeyRun(t *testing.T) {
	m, c := newTestModel(t, 80, 24)
	m = press(t, m, "r")
	if c.run != 1 || m.busy != "" {
		t.Fatalf("run calls = %d, busy = %q", c.run, m.busy)
	}
	if m.note.kind != noteFail || !strings.Contains(m.note.text, "codex: arm script exited with status 124") {
		t.Errorf("note = %+v, want the codex failure", m.note)
	}
}

func TestKeyOneJobAtATime(t *testing.T) {
	m, c := newTestModel(t, 80, 24)
	next, _ := m.Update(keyMsg("r"))
	m = press(t, next.(model), "a")
	if c.apply != 0 || !strings.Contains(m.note.text, "wait: "+jobRun) {
		t.Errorf("apply ran during a run: calls %d, note %q", c.apply, m.note.text)
	}
}

func TestKeyApply(t *testing.T) {
	m, c := newTestModel(t, 80, 24)
	m = press(t, m, "down", "space", "a")
	if c.apply != 1 || m.unapplied {
		t.Errorf("apply calls = %d, unapplied = %v", c.apply, m.unapplied)
	}
}

func TestKeyStop(t *testing.T) {
	m, c := newTestModel(t, 80, 24)
	m = press(t, m, "x")
	if c.stop != 1 || m.note.text != "schedulers removed" {
		t.Errorf("stop calls = %d, note = %q", c.stop, m.note.text)
	}
}

func TestKeyLogs(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	if err := os.MkdirAll(filepath.Dir(m.deps.Paths.WarmupLog), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.deps.Paths.WarmupLog, []byte("[2026-11-27 13:30:00] TICK [kimi] warm — test line\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m = press(t, m, "v")
	if m.focus != focusLogs || !strings.Contains(frame(m), "TICK [kimi] warm — test line") {
		t.Fatalf("v did not show warmup.log:\n%s", frame(m))
	}
	m = press(t, m, "esc")
	if m.focus != focusLanes {
		t.Error("esc did not close the log")
	}
}

func TestKeyDetect(t *testing.T) {
	m, c := newTestModel(t, 80, 24)
	m = press(t, m, "d")
	if got := saved(t, m).Providers[domain.Claude].Binary; got != "/usr/local/bin/claude" || c.detect != 1 {
		t.Fatalf("d: binary = %q, detect calls = %d", got, c.detect)
	}
	m = press(t, m, "down", "down", "d")
	if m.note.kind != noteFail || !strings.Contains(m.note.text, "zai-coding-plan") {
		t.Errorf("zai detect note = %+v", m.note)
	}
}

func TestKeyHelp(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "?")
	if m.focus != focusHelp || !strings.Contains(frame(m), "Commands") {
		t.Fatalf("? did not open the help:\n%s", frame(m))
	}
	m = press(t, m, "esc")
	if m.focus != focusLanes {
		t.Error("esc did not close the help")
	}
}

func TestKeyQuit(t *testing.T) {
	for _, k := range []string{"q", "ctrl+c"} {
		m, _ := newTestModel(t, 80, 24)
		_, cmd := m.Update(keyMsg(k))
		if cmd == nil {
			t.Fatalf("%s returned no command", k)
		}
		if _, ok := cmd().(tea.QuitMsg); !ok {
			t.Errorf("%s did not quit", k)
		}
	}
}

func TestKeyCommandLine(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "/")
	m = typeText(t, m, "ena")
	m = press(t, m, "tab")
	m = typeText(t, m, " ki")
	m = press(t, m, "tab")
	if got := m.input.Value(); got != "enable kimi" {
		t.Fatalf("tab completion = %q, want %q", got, "enable kimi")
	}
	m = press(t, m, "enter")
	if !saved(t, m).Providers[domain.Kimi].Enabled || m.prompt != nil {
		t.Fatalf("enable kimi did not save or left the line open:\n%s", frame(m))
	}
	m = press(t, m, "/")
	m = typeText(t, m, "hours kimi 9-17")
	m = press(t, m, "enter")
	if pc := saved(t, m).Providers[domain.Kimi]; pc.WorkStart != 9 || pc.WorkEnd != 17 {
		t.Errorf("hours kimi 9-17 saved %d-%d", pc.WorkStart, pc.WorkEnd)
	}
}

// TestKeyCommandMatchesKey: a key and its command run the same action, so
// they leave the same config.
func TestKeyCommandMatchesKey(t *testing.T) {
	byKey, _ := newTestModel(t, 80, 24)
	byKey = press(t, byKey, "m")
	byCmd, _ := newTestModel(t, 80, 24)
	byCmd = press(t, byCmd, "/")
	byCmd = typeText(t, byCmd, "model claude")
	byCmd = press(t, byCmd, "enter")
	if !reflect.DeepEqual(byKey.cfg, byCmd.cfg) {
		t.Errorf("key and command differ:\nkey %+v\ncmd %+v", byKey.cfg.Providers[domain.Claude], byCmd.cfg.Providers[domain.Claude])
	}
}

func TestInvalidBinaryKeepsConfig(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	before := saved(t, m)
	m = toRow(t, m, rowBinary)
	m = press(t, m, "enter", "ctrl+u")
	m = typeText(t, m, "   ")
	m = press(t, m, "enter")
	if !reflect.DeepEqual(saved(t, m), before) || !reflect.DeepEqual(m.cfg, before) {
		t.Fatal("an empty binary changed the config")
	}
	if m.prompt == nil || m.input.Value() != "   " {
		t.Errorf("the input closed or lost the text after an error")
	}
	if !strings.Contains(frame(m), "providers.claude.binary") {
		t.Errorf("the error is not shown:\n%s", frame(m))
	}
}

func TestInvalidCommandKeepsConfig(t *testing.T) {
	cases := map[string]string{
		"hours claude 20-8":   "work_end",
		"weekly claude 105":   "weekly_stop_percent",
		"tick claude":         "unknown command",
		"hours claude nine-5": "not a whole number",
		"frobnicate":          "unknown command",
	}
	for line, want := range cases {
		t.Run(line, func(t *testing.T) {
			m, _ := newTestModel(t, 80, 24)
			before := saved(t, m)
			m = press(t, m, "/")
			m = typeText(t, m, line)
			m = press(t, m, "enter")
			if !reflect.DeepEqual(saved(t, m), before) || !reflect.DeepEqual(m.cfg, before) {
				t.Fatal("the invalid edit changed the config")
			}
			if m.note.kind != noteFail || !strings.Contains(m.note.text, want) {
				t.Errorf("note = %+v, want an error with %q", m.note, want)
			}
		})
	}
}

// TestDisableLastAgent: every agent may be off. The tick then does nothing.
func TestDisableLastAgent(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = press(t, m, "space", "down", "space")
	if got := saved(t, m).Enabled(); len(got) != 0 || m.note.kind != noteOK {
		t.Fatalf("enabled = %v, note = %+v", got, m.note)
	}
}
