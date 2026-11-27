package scheduler

import (
	"context"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sandbox"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const foreign = "0 0 * * * /usr/bin/backup\n# my own note\n"

// kimiConfig enables only kimi, from 08 to 18.
func kimiConfig() domain.Config {
	cfg := config.WithProvider(config.Defaults(), domain.Claude, func(pc *domain.ProviderConfig) { pc.Enabled = false })
	return config.WithProvider(cfg, domain.Kimi, func(pc *domain.ProviderConfig) {
		pc.Enabled, pc.WorkStart, pc.WorkEnd = true, 8, 18
	})
}

func TestBackendByOS(t *testing.T) {
	for goos, want := range map[string]Backend{"darwin": BackendLaunchd, "linux": BackendCron, "freebsd": BackendCron} {
		if got := backendFor(goos); got != want {
			t.Errorf("backendFor(%q) = %s, want %s", goos, got, want)
		}
	}
}

// TestTickEvery15Minutes: the job fires every 15 minutes inside the work hours.
func TestTickEvery15Minutes(t *testing.T) {
	at := func(d, h, m int) time.Time { return time.Date(2026, 6, d, h, m, 0, 0, time.Local) }
	got := Ticks(kimiConfig(), at(13, 17, 20), at(14, 8, 31))
	want := []time.Time{at(13, 17, 30), at(13, 17, 45), at(14, 8, 0), at(14, 8, 15), at(14, 8, 30)}
	if !slices.Equal(got, want) {
		t.Errorf("Ticks = %v, want %v", got, want)
	}
	if NextRun(kimiConfig()) != "every 15m · 08–18h" {
		t.Errorf("NextRun = %q", NextRun(kimiConfig()))
	}
}

func TestPlist(t *testing.T) {
	t.Setenv("WARMUP_HOME", "/w&h")
	p := paths.Paths{UserHome: "/home/a&b", Home: "/w&h", LaunchdOutLog: "/l/out.log", LaunchdErrLog: "/l/err.log"}
	smart := plist(p, kimiConfig(), "/bin/agent-warmup")
	if got := strings.Count(smart, "<key>Hour</key>"); got != 40 {
		t.Errorf("8-18 every 15m: %d intervals, want 40", got)
	}
	for _, want := range []string{
		"<string>" + paths.Label + "</string>",
		"<string>/bin/agent-warmup</string>\n        <string>tick</string>",
		"<integer>8</integer><key>Minute</key><integer>0</integer>",
		"<integer>17</integer><key>Minute</key><integer>45</integer>",
		"<string>/l/out.log</string>", "<string>/home/a&amp;b</string>", "<false/>",
		"<key>WARMUP_HOME</key>\n        <string>/w&amp;h</string>",
		"<key>Umask</key>\n    <integer>63</integer>",
	} {
		if !strings.Contains(smart, want) {
			t.Errorf("smart plist lacks %q", want)
		}
	}
	if strings.Contains(smart, "<integer>18</integer>") {
		t.Error("work_end is exclusive, hour 18 must not fire")
	}

	t.Setenv("WARMUP_HOME", "")
	if strings.Contains(plist(p, kimiConfig(), "/bin/aw"), "WARMUP_HOME") {
		t.Error("the plist sets WARMUP_HOME although it is unset")
	}
}

func TestCronBlock(t *testing.T) {
	t.Setenv("WARMUP_HOME", "")
	p := paths.Paths{CronLog: "/w/logs/cron.log"}
	none := config.WithProvider(kimiConfig(), domain.Kimi, func(pc *domain.ProviderConfig) { pc.Enabled = false })
	oneHour := config.WithProvider(kimiConfig(), domain.Kimi, func(pc *domain.ProviderConfig) { pc.WorkStart, pc.WorkEnd = 9, 10 })

	cases := []struct {
		name string
		cfg  domain.Config
		exe  string
		want string
	}{
		{"work band", kimiConfig(), "/bin/aw", "*/15 8-17 * * * umask 077; /bin/aw tick >> /w/logs/cron.log 2>&1"},
		{"percent escaped", kimiConfig(), "/bin/a%b", `umask 077; /bin/a\%b tick`},
		{"one hour", oneHour, "/bin/aw", "*/15 9 * * * umask 077; /bin/aw tick"},
		{"quoted exe", kimiConfig(), "/my bin/it's", `'/my bin/it'\''s' tick`},
		{"no enabled provider", none, "/bin/aw", cronBegin + "\n# (no enabled providers)\n" + cronEnd},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := cronBlock(p, tc.cfg, tc.exe)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(got, tc.want) || !strings.HasPrefix(got, cronBegin+"\n") || !strings.HasSuffix(got, "\n"+cronEnd) {
				t.Errorf("cronBlock = %q, want it to contain %q", got, tc.want)
			}
		})
	}
}

func TestCronBlockHome(t *testing.T) {
	t.Setenv("WARMUP_HOME", "/w/h")
	got, err := cronBlock(paths.Paths{CronLog: "/w/h/logs/cron.log"}, kimiConfig(), "/bin/aw")
	if err != nil || !strings.Contains(got, "* * * umask 077; WARMUP_HOME=/w/h /bin/aw tick") {
		t.Errorf("cronBlock = %q, %v", got, err)
	}
}

func TestCronBlockRejectsNewline(t *testing.T) {
	t.Setenv("WARMUP_HOME", "")
	for _, exe := range []string{"/bin/a\nb", "/bin/a\rb"} {
		if _, err := cronBlock(paths.Paths{CronLog: "/l"}, kimiConfig(), exe); err == nil {
			t.Errorf("cronBlock(%q) accepted a line break", exe)
		}
	}
}

func TestStripBlock(t *testing.T) {
	text := foreign + cronBegin + "\n*/30 8-17 * * * x tick\n" + cronEnd + "\n\n"
	if got, err := stripBlock(text); err != nil || got != strings.TrimSpace(foreign) {
		t.Errorf("stripBlock = %q, %v", got, err)
	}
	if _, err := stripBlock(cronBegin + "\n* * * * * x tick\n" + foreign); err == nil {
		t.Error("stripBlock accepted a begin marker without an end marker")
	}
}

// TestUnterminatedBlockKeepsCrontab: a begin marker without an end marker
// must not delete the user's lines below it.
func TestUnterminatedBlockKeepsCrontab(t *testing.T) {
	s := sandbox.New(t)
	text := cronBegin + "\n* * * * * x tick\n" + foreign
	s.SetCrontab(t, text)
	ctx := context.Background()
	if _, err := Stop(ctx, s.Paths); err == nil {
		t.Error("Stop accepted an unterminated block")
	}
	if got := s.Crontab(t); got != text {
		t.Errorf("crontab = %q", got)
	}
}

func TestApplyLocksDownHome(t *testing.T) {
	s := sandbox.New(t)
	if err := os.MkdirAll(s.Paths.LogDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(s.Paths.Home, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := apply(context.Background(), s.Paths, kimiConfig(), BackendCron); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{s.Paths.Home, s.Paths.LogDir} {
		info, err := os.Stat(dir)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Errorf("%s: mode %v, %v; want 0700", dir, info.Mode().Perm(), err)
		}
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{"/usr/bin/x": "/usr/bin/x", "/a b": "'/a b'", "it's": `'it'\''s'`, "": "''"} {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestApplyCronKeepsForeignLines(t *testing.T) {
	s := sandbox.New(t)
	s.SetCrontab(t, foreign+"# >>> claude-warmup >>>\n0 8 * * * /old/agent-warmup tick\n# <<< claude-warmup <<<\n")
	cfg := kimiConfig()
	ctx := context.Background()

	if _, err := apply(ctx, s.Paths, cfg, BackendCron); err != nil {
		t.Fatal(err)
	}
	if _, err := apply(ctx, s.Paths, cfg, BackendCron); err != nil {
		t.Fatal(err)
	}
	text := s.Crontab(t)
	if !strings.Contains(text, "0 0 * * * /usr/bin/backup") {
		t.Error("foreign entry lost")
	}
	if strings.Contains(text, "claude-warmup") {
		t.Errorf("legacy block survived:\n%s", text)
	}
	if strings.Count(text, cronBegin) != 1 || !strings.Contains(text, "*/15 8-17 * * * ") || !strings.Contains(text, s.Paths.CronLog) {
		t.Errorf("want exactly one block logging to cron.log:\n%s", text)
	}
	if _, err := os.Stat(s.Paths.Plist); !os.IsNotExist(err) {
		t.Error("a cron install wrote a plist")
	}
	st, err := state(ctx, s.Paths, BackendCron)
	if err != nil || !st.Active || !st.Cron.Installed {
		t.Errorf("state = %+v, %v; want active cron", st, err)
	}
}

func TestApplyLaunchd(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd exists only on macOS")
	}
	s := sandbox.New(t)
	cfg := kimiConfig()
	exe, err := sysexec.Self()
	if err != nil {
		t.Fatal(err)
	}
	block, err := cronBlock(s.Paths, cfg, exe)
	if err != nil {
		t.Fatal(err)
	}
	s.SetCrontab(t, foreign+block+"\n")
	ctx := context.Background()

	if _, err := Apply(ctx, s.Paths, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(s.Paths.Plist)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), s.Paths.LaunchdOutLog) {
		t.Error("the plist does not log under the warmup home")
	}
	if strings.Contains(s.Crontab(t), cronBegin) || !strings.Contains(s.Crontab(t), "/usr/bin/backup") {
		t.Errorf("cron block not removed or foreign lost:\n%s", s.Crontab(t))
	}
	target := sysexec.LaunchDomain() + "/" + paths.Label
	calls := s.Launchctl(t)
	for _, want := range []string{"bootout " + target, "bootstrap " + sysexec.LaunchDomain() + " " + s.Paths.Plist, "enable " + target} {
		if !slices.Contains(calls, want) {
			t.Errorf("launchctl calls %q lack %q", calls, want)
		}
	}
	// A disabled label makes bootstrap fail, so enable must come first.
	if slices.Index(calls, "enable "+target) > slices.Index(calls, "bootstrap "+sysexec.LaunchDomain()+" "+s.Paths.Plist) {
		t.Errorf("enable ran after bootstrap: %q", calls)
	}

	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3")
	if _, err := Apply(ctx, s.Paths, cfg); err == nil {
		t.Error("a failing bootstrap must return an error")
	}
}

func TestLaunchdState(t *testing.T) {
	s := sandbox.New(t)
	ctx := context.Background()
	if err := os.MkdirAll(s.Root+"/Library/LaunchAgents", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Paths.Plist, []byte("plist"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, state, status, disabled string
		want                          LaunchdStatus
	}{
		{"running and enabled", "running", "0", `"` + paths.Label + `" => false`, LaunchdStatus{true, true, true, true}},
		{"disabled", "waiting", "0", `"` + paths.Label + `" => true`, LaunchdStatus{true, true, false, false}},
		{"absent from disabled list", "", "0", "", LaunchdStatus{true, true, false, true}},
		{"not loaded", "", "1", "", LaunchdStatus{true, false, false, true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("FAKE_PRINT_STATE", tc.state)
			t.Setenv("FAKE_PRINT_STATUS", tc.status)
			t.Setenv("FAKE_PRINT_DISABLED", tc.disabled)
			got, err := launchdState(ctx, s.Paths)
			if err != nil || got != tc.want {
				t.Errorf("launchdState = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestStopIsIdempotent(t *testing.T) {
	s := sandbox.New(t)
	cfg := kimiConfig()
	block, err := cronBlock(s.Paths, cfg, "/bin/aw")
	if err != nil {
		t.Fatal(err)
	}
	s.SetCrontab(t, foreign+block+"\n")
	ctx := context.Background()

	if _, err := Stop(ctx, s.Paths); err != nil {
		t.Fatal(err)
	}
	if got := s.Crontab(t); strings.TrimSpace(got) != strings.TrimSpace(foreign) {
		t.Errorf("crontab after stop = %q", got)
	}
	writes := s.CrontabWrites(t)
	if _, err := Stop(ctx, s.Paths); err != nil {
		t.Fatal(err)
	}
	if s.CrontabWrites(t) != writes {
		t.Error("a no-op stop rewrote the crontab")
	}
}
