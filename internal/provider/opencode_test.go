package provider

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

func TestParseStatsCost(t *testing.T) {
	flat := readFixture(t, "opencode-stats-flat.txt")
	boxed := readFixture(t, "opencode-stats-boxed.txt")
	cases := []struct {
		name, text, model string
		want              float64
		found             bool
	}{
		{"flat with prefix", flat, "opencode-go/deepseek-v4-flash", 0.12, true},
		{"flat bare model", flat, "deepseek-v4-flash", 0.12, true},
		{"flat other row", flat, "gpt-4o", 0.05, true},
		{"flat first row", flat, "claude-sonnet-4", 4.21, true},
		{"flat missing model", flat, "no-such-model", 0, false},
		{"USD with space", "  gpt-4o     120 in / 90 out   USD 4.56\n", "gpt-4o", 4.56, true},
		{"USD tight", "  gpt-4o     120 in / 90 out   USD4.56\n", "gpt-4o", 4.56, true},
		{"empty input", "", "deepseek-v4-flash", 0, false},
		{"row without cost", "  deepseek-v4-flash      1,234 in / 567 out\n", "deepseek-v4-flash", 0, false},
		{"whole dollars", "  deepseek-v4-flash      1,234 in / 567 out   $1\n", "deepseek-v4-flash", 1, true},
		{"thousands separator", "  deepseek-v4-flash      1,234 in / 567 out   $1,234.50\n", "deepseek-v4-flash", 1234.5, true},
		{"boxed first block", boxed, "opencode-go/deepseek-v4-flash", 7.5, true},
		{"boxed second block", boxed, "opencode-go/glm-5.3-flash", 1.25, true},
		{"boxed ignores Total Cost", boxed, "opencode-go/no-such-model", 0, false},
	}
	for _, tc := range cases {
		got, found := parseStatsCost(tc.text, tc.model)
		if got != tc.want || found != tc.found {
			t.Errorf("%s: got %v %v, want %v %v", tc.name, got, found, tc.want, tc.found)
		}
	}
}

func stubOpencode(t *testing.T, body string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "opencode")
	if err := os.WriteFile(file, []byte("#!/usr/bin/env bash\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return file
}

func probeOpencode(t *testing.T, binary string) (domain.Usage, error) {
	t.Helper()
	pc := pcAt(domain.Opencode, noon)
	pc.Cfg.Binary = binary
	pc.Cfg.Model = "opencode-go/deepseek-v4-flash"
	return Get(domain.Opencode).Probe(context.Background(), pc)
}

func TestOpencodeProbe(t *testing.T) {
	const statsLine = `[ "$1" = "--version" ] && exit 0` + "\necho '  opencode-go/deepseek-v4-flash  1 in / 2 out   "
	cases := []struct {
		name     string
		body     string
		wantPct  int // -1: no week block
		inferred bool
	}{
		{"spend maps onto the $30 cap", statsLine + "$7.50'", 25, false},
		{"over-spend caps at 100", statsLine + "$45.00'", 100, false},
		{"version exit 1 still runs", `[ "$1" = "--version" ] && exit 1` + "\necho 'deepseek-v4-flash $3'", 10, false},
		{"no recorded spend", `[ "$1" = "--version" ] && exit 0` + "\necho 'no usage yet'", -1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u, err := probeOpencode(t, stubOpencode(t, tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if u.Session != nil || u.Inferred != tc.inferred || !u.CapturedAt.Equal(noon) {
				t.Errorf("got %+v", u)
			}
			if tc.wantPct < 0 {
				if u.Week != nil {
					t.Errorf("week = %+v, want nil", u.Week)
				}
				return
			}
			if u.Week == nil || *u.Week.Pct != tc.wantPct {
				t.Errorf("week = %+v, want %d%%", u.Week, tc.wantPct)
			}
		})
	}
}

func TestOpencodeProbeErrors(t *testing.T) {
	cases := map[string]string{
		"missing binary":  "/nonexistent/opencode",
		"stats fails":     stubOpencode(t, `[ "$1" = "--version" ] && exit 0`+"\nexit 3"),
		"version exits 2": stubOpencode(t, "exit 2"),
	}
	for name, bin := range cases {
		if _, err := probeOpencode(t, bin); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}
