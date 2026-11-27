package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/sandbox"
)

type result struct {
	code        int
	out, errOut string
}

func cli(t *testing.T, args ...string) result {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(t.Context(), BuildInfo{Version: "1.2.3", Commit: "abc1234", Date: "2026-11-27"}, args, &out, &errOut)
	return result{code, out.String(), errOut.String()}
}

func (r result) want(t *testing.T, code int) result {
	t.Helper()
	if r.code != code {
		t.Fatalf("exit = %d, want %d\nstdout:\n%s\nstderr:\n%s", r.code, code, r.out, r.errOut)
	}
	return r
}

func contains(t *testing.T, text string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(text, w) {
			t.Fatalf("missing %q in:\n%s", w, text)
		}
	}
}

// setup writes a config with codex enabled beside claude, then lets edit
// change it.
func setup(t *testing.T, edit func(*domain.Config)) sandbox.Sandbox {
	t.Helper()
	s := sandbox.New(t)
	cfg := config.WithProvider(config.Defaults(), domain.Codex, func(pc *domain.ProviderConfig) { pc.Enabled = true })
	if edit != nil {
		edit(&cfg)
	}
	if err := config.Save(s.Paths, cfg); err != nil {
		t.Fatal(err)
	}
	return s
}

// jobText is the installed job: the plist on macOS, else the crontab.
func jobText(t *testing.T, s sandbox.Sandbox) string {
	t.Helper()
	if runtime.GOOS != "darwin" {
		return s.Crontab(t)
	}
	data, err := os.ReadFile(s.Paths.Plist)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(data)
}

func loadConfig(t *testing.T, s sandbox.Sandbox) domain.Config {
	t.Helper()
	cfg, err := config.Load(s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// armStub points every provider's arm at one script through WARMUP_<ID>_SCRIPT.
func armStub(t *testing.T, s sandbox.Sandbox, body string) {
	t.Helper()
	path := sandbox.WriteExec(t, filepath.Join(s.Root, "arm-stub.sh"), "#!/usr/bin/env bash\n"+body+"\n")
	for _, id := range domain.ProviderIDs {
		t.Setenv("WARMUP_"+strings.ToUpper(string(id))+"_SCRIPT", path)
	}
}

func TestHelpListsCommandsAndFiles(t *testing.T) {
	s := setup(t, nil)
	r := cli(t, "--help").want(t, 0)
	contains(t, r.out, "status", "usage", "run", "detect", "provider", "logs", "upgrade",
		s.Paths.Config, s.Paths.Cache, s.Paths.WarmupLog)
	if strings.Contains(r.out, "tick") || strings.Contains(r.out, "clean-legacy") {
		t.Fatalf("hidden commands listed:\n%s", r.out)
	}
	cli(t, "-h").want(t, 0)
	cli(t, "help").want(t, 0)
}

func TestUsageErrorsExit2(t *testing.T) {
	setup(t, nil)
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"unknown command", []string{"frobnicate"}, `unknown command "frobnicate"`},
		{"unknown flag", []string{"status", "--bogus"}, "unknown flag: --bogus"},
		{"removed mode", []string{"mode", "smart"}, `unknown command "mode"`},
		{"removed select", []string{"provider", "kimi", "select"}, `unknown command "select"`},
		{"unknown provider id", []string{"provider", "gemini", "enable"}, `unknown command "gemini"`},
		{"unknown provider action", []string{"provider", "kimi", "levitate"}, `unknown command "levitate"`},
		{"missing model", []string{"provider", "kimi", "model"}, "accepts 1 arg(s)"},
		{"missing binary", []string{"provider", "kimi", "binary"}, "accepts 1 arg(s)"},
		{"unknown agent", []string{"run", "gemini"}, `unknown provider "gemini" (want one of claude, codex`},
		{"two agents", []string{"status", "kimi", "codex"}, "accepts at most one agent, received 2"},
		{"removed --provider", []string{"usage", "--provider", "kimi"}, "unknown flag: --provider"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := cli(t, tc.args...).want(t, exitUsage)
			contains(t, r.errOut, "agent-warmup: ", tc.want, "Run 'agent-warmup --help' for usage.")
		})
	}
}

func TestVersion(t *testing.T) {
	setup(t, nil)
	want := "agent-warmup 1.2.3 (commit abc1234, built 2026-11-27)\n"
	for _, args := range [][]string{{"version"}, {"--version"}} {
		if r := cli(t, args...).want(t, 0); r.out != want {
			t.Fatalf("%v printed %q, want %q", args, r.out, want)
		}
	}
}

// TestCommitApplyFailureSaysSaved: when the save worked and the apply did not,
// the error must say so and how to apply.
func TestCommitApplyFailureSaysSaved(t *testing.T) {
	s := setup(t, nil)
	cli(t, "start").want(t, 0)
	// A legacy block without an end makes the next Apply fail.
	s.SetCrontab(t, s.Crontab(t)+"# >>> claude-warmup >>>\n")
	r := cli(t, "provider", "kimi", "enable").want(t, exitError)
	contains(t, r.errOut, "saved", "could not apply", "agent-warmup restart")
	if !loadConfig(t, s).Providers[domain.Kimi].Enabled {
		t.Error("kimi was not saved as enabled")
	}
}

func TestProviderSetters(t *testing.T) {
	s := setup(t, nil)
	cli(t, "provider", "kimi", "model", "kimi-code/kimi-for-coding-highspeed").want(t, 0)
	r := cli(t, "provider", "kimi", "binary", "~/bin/kimi").want(t, 0)
	contains(t, r.out, "✓ kimi binary: ~/bin/kimi")

	kimi := loadConfig(t, s).Providers[domain.Kimi]
	if kimi.Model != "kimi-code/kimi-for-coding-highspeed" || kimi.Binary != "~/bin/kimi" {
		t.Fatalf("kimi = %+v", kimi)
	}
}

// TestProviderEnableDisable: every agent can be off. The tick then does nothing.
func TestProviderEnableDisable(t *testing.T) {
	s := setup(t, nil)
	cli(t, "provider", "kimi", "enable").want(t, 0)
	r := cli(t, "provider", "kimi", "disable").want(t, 0)
	contains(t, r.out, "✓ kimi disabled\n")

	cli(t, "provider", "codex", "disable").want(t, 0)
	cli(t, "provider", "claude", "disable").want(t, 0)
	if got := loadConfig(t, s).Enabled(); len(got) != 0 {
		t.Fatalf("enabled = %v, want none", got)
	}
	if r := cli(t, "tick").want(t, 0); r.out != "" {
		t.Fatalf("tick with no agent printed %q", r.out)
	}
}

var listedID = regexp.MustCompile(`(?m)^[●○] (\w+)\s`)

func TestProviderList(t *testing.T) {
	setup(t, nil)
	r := cli(t, "provider", "list").want(t, 0)
	var listed []string
	for _, m := range listedID.FindAllStringSubmatch(r.out, -1) {
		listed = append(listed, m[1])
	}
	if strings.Join(listed, ",") != "claude,codex,zai,kimi,opencode,minimax,agy" {
		t.Fatalf("listed %v:\n%s", listed, r.out)
	}
	if !regexp.MustCompile(`codex .*enabled=true .*usage=live`).MatchString(r.out) ||
		!regexp.MustCompile(`kimi .*enabled=false .*usage=estimated`).MatchString(r.out) {
		t.Fatalf("unexpected list:\n%s", r.out)
	}
	if bare := cli(t, "provider").want(t, 0); bare.out != r.out {
		t.Fatalf("bare provider differs from provider list:\n%s", bare.out)
	}
}

func TestDetect(t *testing.T) {
	s := setup(t, nil)
	t.Setenv("PATH", s.Bin)
	found := s.AddBin(t, "codex", "#!/bin/sh\nexit 0\n")

	r := cli(t, "detect").want(t, 0)
	contains(t, r.out, found, "(config points at ~/.local/bin/codex)", "Run `agent-warmup detect --apply`")
	if loadConfig(t, s).Providers[domain.Codex].Binary == found {
		t.Fatal("detect without --apply saved a path")
	}

	r = cli(t, "detect", "--apply").want(t, 0)
	contains(t, r.out, "✓ saved paths for: codex\n")
	if loadConfig(t, s).Providers[domain.Codex].Binary != found {
		t.Fatal("detect --apply did not save the path")
	}
	r = cli(t, "detect", "--apply").want(t, 0)
	contains(t, r.out, "✓ nothing to change: every configured binary path is valid")
}

func TestRunDisabledProvider(t *testing.T) {
	setup(t, nil)
	r := cli(t, "run", "kimi").want(t, exitError)
	contains(t, r.errOut, "provider kimi is disabled (enable it with: agent-warmup provider kimi enable)")
}

// twoAgents enables codex and kimi only, working all day, both armed by the
// stub body.
func twoAgents(t *testing.T, body string) sandbox.Sandbox {
	t.Helper()
	s := setup(t, func(cfg *domain.Config) {
		for _, id := range domain.ProviderIDs {
			*cfg = config.WithProvider(*cfg, id, func(pc *domain.ProviderConfig) {
				pc.Enabled = id == domain.Codex || id == domain.Kimi
				pc.WorkStart, pc.WorkEnd = 0, domain.HoursPerDay
			})
		}
	})
	armStub(t, s, body)
	return s
}

const echoStub = `echo "ARMED ${WARMUP_PROVIDER}"`

// concurrentStub succeeds only when both arms run at the same time.
const concurrentStub = `touch "$WARMUP_HOME/started-$WARMUP_PROVIDER"
for _ in $(seq 1 50); do
  [ -e "$WARMUP_HOME/started-codex" ] && [ -e "$WARMUP_HOME/started-kimi" ] && break
  sleep 0.1
done
[ -e "$WARMUP_HOME/started-codex" ] && [ -e "$WARMUP_HOME/started-kimi" ] || exit 3
` + echoStub

func TestRunArmsConcurrentlyAndPassesStatus(t *testing.T) {
	s := twoAgents(t, concurrentStub+"\n[ \"$WARMUP_PROVIDER\" != kimi ] || exit 7")
	r := cli(t, "run").want(t, exitError)
	contains(t, r.out, "[codex] ARMED codex\n", "[kimi] ARMED kimi\n", "✓ codex\n", "✗ kimi failed (status 7)\n")
	if strings.Contains(r.errOut, "agent-warmup: ") {
		t.Fatalf("an arm status must not print an error:\n%s", r.errOut)
	}

	c, err := cache.Read(s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if c.Providers[domain.Codex].LastWarmAt.IsZero() || c.Providers[domain.Kimi].LastFailureAt.IsZero() {
		t.Fatalf("cache = %+v", c.Providers)
	}
}

// TestArmStatusIsNotUsageExit: an arm that exits 2 must not look like a bad
// command line.
func TestArmStatusIsNotUsageExit(t *testing.T) {
	twoAgents(t, "exit 2")
	for _, args := range [][]string{{"run"}, {"run", "kimi"}, {"tick"}} {
		// A failed arm starts a cooldown, so a later tick may skip kimi.
		r := cli(t, args...).want(t, exitError)
		contains(t, r.out, " failed (status 2)\n")
	}
}

func TestJoinedErrorsEachGetPrefix(t *testing.T) {
	s := setup(t, nil)
	if err := os.WriteFile(s.Paths.Config, []byte("[providers.codex]\nwork_start = 30\nweekly_stop_percent = 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := cli(t, "status").want(t, exitError)
	lines := strings.Split(strings.TrimSpace(r.errOut), "\n")
	if len(lines) < 2 {
		t.Fatalf("want one line per error:\n%s", r.errOut)
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "agent-warmup: ") {
			t.Errorf("line without prefix: %q", line)
		}
	}
}

func TestRunOneProvider(t *testing.T) {
	s := twoAgents(t, echoStub)
	r := cli(t, "run", "kimi").want(t, 0)
	contains(t, r.out, "ARMED kimi")
	if strings.Contains(r.out, "ARMED codex") {
		t.Fatalf("codex armed:\n%s", r.out)
	}
	c, err := cache.Read(s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Providers[domain.Codex]; ok || c.Providers[domain.Kimi].LastWarmAt.IsZero() {
		t.Fatalf("cache = %+v", c.Providers)
	}
}

func TestTick(t *testing.T) {
	s := twoAgents(t, concurrentStub)

	r := cli(t, "tick", "--dry-run", "codex").want(t, 0)
	contains(t, r.out, "[codex] warm")
	if strings.Contains(r.out, "[kimi]") {
		t.Fatalf("the agent did not narrow the tick:\n%s", r.out)
	}

	r = cli(t, "tick").want(t, 0)
	contains(t, r.out, "[codex] ARMED codex", "[kimi] ARMED kimi", "[codex] warm — ", "[kimi] warm — ")
	log, err := os.ReadFile(s.Paths.WarmupLog)
	if err != nil {
		t.Fatal(err)
	}
	contains(t, string(log), "TICK [codex] warm — ", "TICK [kimi] warm — ")
}

func TestLogs(t *testing.T) {
	s := setup(t, nil)
	r := cli(t, "logs").want(t, 0)
	contains(t, r.out, "No logs yet. Run a warmup first.")

	if err := os.MkdirAll(s.Paths.LogDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Paths.WarmupLog, []byte("[2026-09-05 10:00:00] TICK [codex] warm\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r = cli(t, "logs").want(t, 0)
	contains(t, r.out, "TICK [codex] warm")
}

func TestUsageEstimatedProvider(t *testing.T) {
	s := setup(t, nil)
	r := cli(t, "usage", "kimi").want(t, 0)
	contains(t, r.errOut, "probing kimi (kimi-code/kimi-for-coding)…")
	contains(t, r.out, "session  idle (estimated)", "source   estimated from local warmup history (Kimi Code)")
	c, err := cache.Read(s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Providers[domain.Kimi]; ok {
		t.Fatal("usage cached an estimate")
	}
}

// TestUsageFailedProbeKeepsCache: a failed probe must not replace the last
// live snapshot with an estimate.
func TestUsageFailedProbeKeepsCache(t *testing.T) {
	s := setup(t, nil)
	t.Setenv("CODEX_HOME", t.TempDir()) // no rollouts, so the probe fails
	pct := 40
	live := domain.LimitBlock{Pct: &pct}
	if err := cache.Update(s.Paths, domain.Codex, func(e domain.CacheEntry) domain.CacheEntry {
		e.Session, e.Week = &live, &live
		return e
	}); err != nil {
		t.Fatal(err)
	}
	cli(t, "usage", "codex").want(t, 0)
	c, err := cache.Read(s.Paths)
	if err != nil {
		t.Fatal(err)
	}
	e := c.Providers[domain.Codex]
	if e.Inferred || e.Session == nil || e.Session.Pct == nil || *e.Session.Pct != 40 {
		t.Fatalf("cache entry = %+v", e)
	}
}

func TestRootWithoutTTYPrintsStatus(t *testing.T) {
	setup(t, nil)
	r := cli(t).want(t, 0)
	backend := "cron"
	if runtime.GOOS == "darwin" {
		backend = "launchd"
	}
	contains(t, r.out, noTTYNote, "○ agent-warmup  inactive  ("+backend+" · 2 enabled)",
		"● codex     model=gpt-5.6-luna  window=08–23h  stop=85%", "scheduler  "+backend+" installed=no")
}

// TestUsageAndStatusCoverEnabledAgents: without an agent, usage and status
// show every enabled agent. With one, only that agent.
func TestUsageAndStatusCoverEnabledAgents(t *testing.T) {
	setup(t, func(cfg *domain.Config) {
		*cfg = config.WithProvider(*cfg, domain.Claude, func(pc *domain.ProviderConfig) { pc.Enabled = false })
		*cfg = config.WithProvider(*cfg, domain.Kimi, func(pc *domain.ProviderConfig) { pc.Enabled = true })
	})
	t.Setenv("CODEX_HOME", t.TempDir()) // no rollouts, so the codex probe fails fast
	r := cli(t, "usage").want(t, 0)
	contains(t, r.out, "codex\nsession  ", "kimi\nsession  idle (estimated)")

	r = cli(t, "status").want(t, 0)
	contains(t, r.out, "● codex ", "● kimi ")
	if strings.Contains(r.out, "claude ") {
		t.Fatalf("status shows a disabled agent:\n%s", r.out)
	}
	r = cli(t, "status", "claude").want(t, 0)
	contains(t, r.out, "○ claude ")
	if strings.Contains(r.out, "kimi ") {
		t.Fatalf("status claude shows kimi:\n%s", r.out)
	}
}

func TestFirstRunCreatesConfig(t *testing.T) {
	s := sandbox.New(t)
	r := cli(t, "status").want(t, 0)
	contains(t, r.errOut, "created config", s.Paths.Config)
	if _, err := os.Stat(s.Paths.Config); err != nil {
		t.Fatal(err)
	}
	if r = cli(t, "status").want(t, 0); strings.Contains(r.errOut, "created config") {
		t.Fatal("second run created the config again")
	}
}

func TestStartStopCron(t *testing.T) {
	s := setup(t, nil)
	s.SetCrontab(t, "# MY OWN JOB\n0 9 * * * echo hi\n")

	r := cli(t, "start").want(t, 0)
	contains(t, r.out, "✓ scheduler installed and loaded", "● agent-warmup  ACTIVE", "next run   every 15m · 08–23h")
	contains(t, jobText(t, s), "tick")
	contains(t, s.Crontab(t), "MY OWN JOB")

	r = cli(t, "provider", "kimi", "enable").want(t, 0)
	contains(t, r.out, "✓ kimi enabled (applied)")

	cli(t, "stop").want(t, 0)
	if jobText(t, s) != "" && runtime.GOOS == "darwin" {
		t.Fatal("plist survived stop")
	}
	if strings.Contains(s.Crontab(t), "agent-warmup") || !strings.Contains(s.Crontab(t), "MY OWN JOB") {
		t.Fatalf("crontab after stop:\n%s", s.Crontab(t))
	}
}

func TestUninstall(t *testing.T) {
	s := setup(t, nil)
	s.SetCrontab(t, "# MY OWN JOB\n0 9 * * * echo hi\n")
	cli(t, "start").want(t, 0)
	s.SetTmuxSessions(t, "agent-warmup-codex", "agent-warmup-codex-usage")
	armScript := filepath.Join(s.Paths.Home, "arm-codex.sh")
	for path, data := range map[string]string{armScript: "#!/bin/sh\n", s.Paths.Cache: "{}"} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	r := cli(t, "uninstall").want(t, 0)
	contains(t, r.out, "✓ tmux session agent-warmup-codex\n", "✓ "+armScript+"\n", "kept  config  "+s.Paths.Config)
	if strings.Contains(s.Crontab(t), "agent-warmup") || !strings.Contains(s.Crontab(t), "MY OWN JOB") {
		t.Fatalf("crontab after uninstall:\n%s", s.Crontab(t))
	}
	for _, path := range []string{armScript, s.Paths.Cache} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s survived: %v", path, err)
		}
	}
	if _, err := os.Stat(s.Paths.Config); err != nil {
		t.Fatalf("config removed: %v", err)
	}
}

func TestCleanLegacyNothingFound(t *testing.T) {
	setup(t, nil)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3") // bootout of the old label: not loaded
	r := cli(t, "clean-legacy").want(t, 0)
	if r.out != "" {
		t.Fatalf("clean-legacy printed %q with nothing to clean", r.out)
	}
}

func TestCompletion(t *testing.T) {
	setup(t, nil)
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"provider ids", []string{"provider", ""}, []string{"claude", "agy", "list"}},
		{"agent argument", []string{"run", ""}, []string{"claude", "minimax"}},
		{"models", []string{"provider", "claude", "model", ""}, []string{"haiku", "sonnet", "opus"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := cli(t, append([]string{"__complete"}, tc.args...)...).want(t, 0)
			contains(t, "\n"+r.out, tc.want...)
		})
	}
	if r := cli(t, "completion", "zsh").want(t, 0); !strings.Contains(r.out, "#compdef agent-warmup") {
		t.Fatalf("zsh completion:\n%.200s", r.out)
	}
}
