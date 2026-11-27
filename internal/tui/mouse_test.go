package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// zoneOf is the first zone of kind with index, from the frame View draws.
func zoneOf(t *testing.T, m model, kind zoneKind, index int) zone {
	t.Helper()
	for _, z := range m.frame().zones {
		if z.kind == kind && z.index == index {
			return z
		}
	}
	t.Fatalf("no %s zone %d in:\n%s", kind, index, frame(m))
	return zone{}
}

func chipOf(t *testing.T, m model, key string) zone {
	t.Helper()
	for _, z := range m.frame().zones {
		if z.kind == zoneChip && z.key == key {
			return z
		}
	}
	t.Fatalf("no chip for %q in:\n%s", key, frame(m))
	return zone{}
}

// line is row y of the drawn frame.
func line(m model, y int) string { return strings.Split(frame(m), "\n")[y] }

// hourX is the column of hour h on the strip z.
func hourX(z zone, h int) int { return z.x + h*z.w/domain.HoursPerDay }

func send(t *testing.T, m model, msg tea.Msg) model {
	t.Helper()
	next, cmd := m.Update(msg)
	return drain(t, next.(model), cmd)
}

func clickAt(t *testing.T, m model, x, y int) model {
	t.Helper()
	return send(t, m, tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
}

// barText is the two key bar lines at the bottom of the frame.
func barText(m model) string {
	lines := strings.Split(frame(m), "\n")
	return strings.Join(lines[len(lines)-barRows:], "\n")
}

// writeLog fills warmup.log with n lines, enough to scroll.
func writeLog(t *testing.T, m model, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(m.deps.Paths.WarmupLog), 0o700); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for i := range n {
		fmt.Fprintf(&b, "[2026-11-27 10:%02d:00] TICK [kimi] warm — line %d\n", i%60, i)
	}
	if err := os.WriteFile(m.deps.Paths.WarmupLog, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

// barContexts are the screens with their own key bar, each with the keys
// that open it from a fresh model and the labels its bar must show.
var barContexts = []struct {
	name   string
	keys   []string
	labels []string
}{
	{"lanes", nil, []string{"on/off", "model", "work start/end", "weekly stop", "edit", "hour", "run now"}},
	{"panel", []string{"enter", "down"}, []string{"field", "change", "type", "detect binary", "close"}},
	{"field", []string{"enter", "down", "enter"}, []string{"save", "cancel"}},
	{"command", []string{"/", "e", "n"}, []string{"complete", "run", "cancel"}},
	{"logs", []string{"v", "up", "up"}, []string{"scroll", "close", "quit"}},
	{"help", []string{"?"}, []string{"close", "quit"}},
}

func TestKeyBarChangesWithContext(t *testing.T) {
	seen := map[string]string{}
	for _, c := range barContexts {
		m, _ := newTestModel(t, 80, 24)
		writeLog(t, m, 60)
		m = press(t, m, c.keys...)
		bar := barText(m)
		for _, label := range c.labels {
			if !strings.Contains(bar, label) {
				t.Errorf("%s bar lacks %q:\n%s", c.name, label, bar)
			}
		}
		if other, ok := seen[bar]; ok {
			t.Errorf("%s and %s show the same bar:\n%s", c.name, other, bar)
		}
		seen[bar] = c.name
	}
}

// TestKeyBarChipsAreHandled: each chip box presses a key that the open
// screen handles: the frame or the typed text changes, or a command starts.
// Tab can leave the frame as it was, because the input already shows the
// completion as a suggestion.
func TestKeyBarChipsAreHandled(t *testing.T) {
	for _, c := range barContexts {
		base, _ := newTestModel(t, 80, 24)
		writeLog(t, base, 60)
		base = press(t, base, c.keys...)
		chips := 0
		for _, z := range base.frame().zones {
			if z.kind != zoneChip {
				continue
			}
			chips++
			next, cmd := base.Update(tea.MouseClickMsg{X: z.x + z.w/2, Y: z.y, Button: tea.MouseLeft})
			nm := next.(model)
			if cmd == nil && frame(nm) == frame(base) && nm.input.Value() == base.input.Value() {
				t.Errorf("%s: chip %q did nothing", c.name, z.key)
			}
		}
		if chips == 0 {
			t.Errorf("%s: no chips", c.name)
		}
	}
}

// TestKeyBarFitsNarrow: at 80 columns the lane bar shows every chip.
func TestKeyBarFitsNarrow(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	want := 0
	for _, chips := range m.keyBar() {
		for _, c := range chips {
			want += len(c.keys)
		}
	}
	got := 0
	for _, z := range m.frame().zones {
		if z.kind == zoneChip {
			got++
		}
	}
	if got != want {
		t.Errorf("%d of %d chip boxes drawn:\n%s", got, want, barText(m))
	}
}

func TestMouseSelectsLane(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	z := zoneOf(t, m, zoneLane, 3)
	m = clickAt(t, m, 1, z.y)
	if m.selAgent() != domain.Kimi || !strings.HasPrefix(line(m, z.y), markSelected+" kimi") {
		t.Errorf("click on the kimi row selected %s:\n%s", m.selAgent(), frame(m))
	}
}

func TestMouseMovesHourCursor(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	before := saved(t, m)
	z := zoneOf(t, m, zoneHours, 1)
	m = clickAt(t, m, hourX(z, 5), z.y)
	m = send(t, m, tea.MouseReleaseMsg{X: hourX(z, 5), Y: z.y, Button: tea.MouseLeft})
	if m.cursor != 5 || m.selAgent() != domain.Codex {
		t.Errorf("cursor = %d, agent = %s; want 5 on codex", m.cursor, m.selAgent())
	}
	if saved(t, m).Providers[domain.Codex] != before.Providers[domain.Codex] {
		t.Error("a click without a drag saved the work hours")
	}
}

func TestMouseDragSetsWorkHours(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	z := zoneOf(t, m, zoneHours, 0)
	m = clickAt(t, m, hourX(z, 17), z.y)
	m = send(t, m, tea.MouseMotionMsg{X: hourX(z, 12), Y: z.y + 3, Button: tea.MouseLeft})
	if m.cursor != 12 {
		t.Errorf("the cursor did not follow the drag: %d", m.cursor)
	}
	m = send(t, m, tea.MouseReleaseMsg{X: hourX(z, 9), Y: z.y + 3, Button: tea.MouseLeft})
	pc := saved(t, m).Providers[domain.Claude]
	if pc.WorkStart != 9 || pc.WorkEnd != 18 || !m.unapplied {
		t.Errorf("drag 17 to 09: work hours %d-%d, unapplied %v; want 9-18", pc.WorkStart, pc.WorkEnd, m.unapplied)
	}
}

func TestMouseWheel(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	m = send(t, m, tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = send(t, m, tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	if m.selAgent() != domain.Zai {
		t.Errorf("two wheel downs selected %s, want zai", m.selAgent())
	}
	m = send(t, m, tea.MouseWheelMsg{Button: tea.MouseWheelUp})
	if m.selAgent() != domain.Codex {
		t.Errorf("wheel up selected %s, want codex", m.selAgent())
	}

	writeLog(t, m, 60)
	m = press(t, m, "v")
	bottom := m.logs.YOffset()
	m = send(t, m, tea.MouseWheelMsg{Button: tea.MouseWheelUp})
	if m.logs.YOffset() >= bottom {
		t.Errorf("wheel up did not scroll the log: offset %d, was %d", m.logs.YOffset(), bottom)
	}
}

func TestMouseChipClick(t *testing.T) {
	m, _ := newTestModel(t, 80, 24)
	z := chipOf(t, m, "m")
	m = clickAt(t, m, z.x, z.y)
	if got := saved(t, m).Providers[domain.Claude].Model; got != "sonnet" {
		t.Errorf("the m chip set model %q, want sonnet", got)
	}
	z = chipOf(t, m, "enter")
	m = clickAt(t, m, z.x, z.y)
	if m.focus != focusPanel {
		t.Errorf("the enter chip did not open the panel")
	}
}

// TestMousePanelField: a click on a field or its hint selects the field, in
// the full-width panel and in the drawer.
func TestMousePanelField(t *testing.T) {
	for _, s := range []size{{"80x24", 80, 24}, {"160x40", 160, 40}} {
		m, _ := newTestModel(t, s.w, s.h)
		m = press(t, m, "enter")
		z := zoneOf(t, m, zoneField, rowWeekly)
		m = clickAt(t, m, z.x+3, z.y+1)
		if m.panelRow != rowWeekly || !strings.Contains(line(m, z.y), markSelected+" weekly stop") {
			t.Errorf("%s: panel row = %d, want %d:\n%s", s.name, m.panelRow, rowWeekly, frame(m))
		}
	}
}
