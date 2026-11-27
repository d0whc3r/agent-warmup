package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

var codexNow = time.Date(2026, 9, 5, 10, 0, 0, 0, time.UTC)

func rateLine(t *testing.T, pct float64, resetsIn time.Duration) string {
	t.Helper()
	line, err := json.Marshal(map[string]any{
		"timestamp": codexNow.Format(time.RFC3339Nano),
		"payload": map[string]any{
			"type": "token_count",
			"rate_limits": map[string]any{
				"primary":   map[string]any{"used_percent": pct, "window_minutes": 300, "resets_at": codexNow.Add(resetsIn).Unix()},
				"secondary": nil,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(line)
}

func TestParseCodexRateLimits(t *testing.T) {
	resets := codexNow.Add(time.Hour).Unix()
	week := resets + 6*24*3600
	text := strings.Join([]string{
		`{"timestamp":"2026-09-05T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1},"secondary":null}}}`,
		`{"timestamp":"2026-09-05T09:30:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":74.4,"window_minutes":300,"resets_at":` +
			strconv.FormatInt(resets, 10) + `},"secondary":{"used_percent":27.0,"window_minutes":10080,"resets_at":` + strconv.FormatInt(week, 10) + `}}}}`,
		"not json at all",
	}, "\n")

	u, ok := parseCodexRateLimits(text, codexNow)
	if !ok {
		t.Fatal("no rate limits parsed")
	}
	assertBlock(t, "session", u.Session, 74, time.Unix(resets, 0))
	assertBlock(t, "week", u.Week, 27, time.Unix(week, 0))
	if !u.Session.Active {
		t.Error("session should be active")
	}
	if !u.CapturedAt.Equal(time.Date(2026, 9, 5, 9, 30, 0, 0, time.UTC)) {
		t.Errorf("CapturedAt = %v", u.CapturedAt)
	}
	if _, ok := parseCodexRateLimits(`{"payload":{}}`+"\n", codexNow); ok {
		t.Error("a line without rate_limits parsed")
	}
}

func TestCodexProbe(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	pc := pcAt(domain.Codex, codexNow)
	pc.Paths = testPaths(t)
	probe := func() (domain.Usage, error) { return Get(domain.Codex).Probe(context.Background(), pc) }

	if _, err := probe(); err == nil {
		t.Error("missing sessions dir: want an error")
	}

	sessions := filepath.Join(codexHome, "sessions", "2026", "09")
	write := func(rel, text string) {
		path := filepath.Join(sessions, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("04/rollout-2026-09-04T23-10-00-aaaa.jsonl", rateLine(t, 10, time.Hour))
	write("05/rollout-2026-09-05T09-40-00-bbbb.jsonl",
		strings.Join([]string{"garbage", `{"payload":{}}`, rateLine(t, 74.4, time.Hour)}, "\n"))

	u, err := probe()
	if err != nil {
		t.Fatal(err)
	}
	if *u.Session.Pct != 74 || u.Week != nil {
		t.Errorf("newest rollout not read: %+v", u)
	}

	// A rollout without rate limits falls through to the next newest.
	write("05/rollout-2026-09-05T09-55-00-cccc.jsonl", `{"type":"session_meta"}`+"\n")
	if u, err := probe(); err != nil || *u.Session.Pct != 74 {
		t.Errorf("fall-through: %+v, %v", u, err)
	}

	if err := os.RemoveAll(filepath.Join(codexHome, "sessions")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(codexHome, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := probe(); err == nil {
		t.Error("empty sessions dir: want an error")
	}
}

// TestCodexProbeReadsOnlyNewestDays: the probe lists the newest day
// directories first and stops at rolloutsScanned, so an old year it never
// needs is not read at all.
func TestCodexProbeReadsOnlyNewestDays(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	pc := pcAt(domain.Codex, codexNow)
	pc.Paths = testPaths(t)
	sessions := filepath.Join(codexHome, "sessions")
	for i := range rolloutsScanned {
		path := filepath.Join(sessions, "2026", "09", "05", "rollout-2026-09-05T09-0"+strconv.Itoa(i)+"-00-x.jsonl")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(rateLine(t, 40, time.Hour)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := filepath.Join(sessions, "2024")
	if err := os.MkdirAll(filepath.Join(old, "01"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(old, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(old, 0o700) })

	if u, err := Get(domain.Codex).Probe(context.Background(), pc); err != nil || *u.Session.Pct != 40 {
		t.Fatalf("Probe = %+v, %v", u, err)
	}
}
