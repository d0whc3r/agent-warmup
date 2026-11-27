package warmup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
	"github.com/d0whc3r/agent-warmup/internal/sandbox"
)

// fake is a provider whose probe and decision the test sets. It records an
// arm like the cooldown providers: status 0 sets LastWarmAt, else LastFailureAt.
type fake struct {
	id       domain.ProviderID
	probe    func() (domain.Usage, error)
	decision domain.Decision
}

func (f fake) ID() domain.ProviderID         { return f.id }
func (f fake) Name() string                  { return "Fake " + string(f.id) }
func (f fake) ModelChoices() []string        { return nil }
func (f fake) ProbeKind() provider.ProbeKind { return provider.ProbeEstimated }
func (f fake) CredentialKey() string         { return "" }
func (f fake) ArmScript() []byte             { return []byte("echo \"embedded $WARMUP_PROVIDER\"\n") }

func (f fake) Probe(context.Context, provider.ProbeContext) (domain.Usage, error) {
	if f.probe == nil {
		return domain.Usage{}, provider.ErrNoLiveProbe
	}
	return f.probe()
}

func (f fake) InferFromCache(provider.ProbeContext, domain.CacheEntry) domain.Usage {
	return domain.Usage{Inferred: true}
}

func (f fake) Decide(provider.ProbeContext, domain.Usage, domain.CacheEntry) domain.Decision {
	return f.decision
}

func (f fake) ArmEnv(pc provider.ProbeContext) map[string]string {
	return map[string]string{"WARMUP_PROVIDER": string(pc.ID)}
}

func (f fake) RecordArm(pc provider.ProbeContext, e domain.CacheEntry, status int) (domain.CacheEntry, string) {
	if status == 0 {
		e.LastWarmAt = pc.Now
		return e, ""
	}
	e.LastFailureAt = pc.Now
	return e, "arm failed"
}

var (
	warm = domain.Decision{Action: domain.ActionWarm, Reason: "no active window"}
	skip = domain.Decision{Action: domain.ActionSkipActive, Reason: "window active until 12:00"}
	now  = time.Date(2026, 9, 5, 12, 0, 0, 0, time.Local)
)

// setup installs fakes for codex and kimi, enables only them, and returns a
// Runner whose Out and Err share one buffer.
func setup(t *testing.T, fakes ...fake) (Runner, *bytes.Buffer) {
	t.Helper()
	s := sandbox.New(t)
	byID := map[domain.ProviderID]provider.Provider{}
	for _, f := range fakes {
		byID[f.id] = f
	}
	old := lookup
	lookup = func(id domain.ProviderID) provider.Provider { return byID[id] }
	t.Cleanup(func() { lookup = old })

	cfg := config.Defaults()
	for id, pc := range cfg.Providers {
		pc.Enabled = byID[id] != nil
		cfg.Providers[id] = pc
	}
	var out bytes.Buffer
	return Runner{Paths: s.Paths, Config: cfg, Out: &out, Err: &out}, &out
}

func armStub(t *testing.T, id domain.ProviderID, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "arm.sh")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WARMUP_"+strings.ToUpper(string(id))+"_SCRIPT", path)
}

func readEntry(t *testing.T, r Runner, id domain.ProviderID) domain.CacheEntry {
	t.Helper()
	c, err := cache.Read(r.Paths)
	if err != nil {
		t.Fatal(err)
	}
	return c.Providers[id]
}

func readLog(t *testing.T, r Runner) string {
	t.Helper()
	data, err := os.ReadFile(r.Paths.WarmupLog)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestTickProbesDecidesAndArms(t *testing.T) {
	pct := 74
	probed := domain.Usage{Session: &domain.LimitBlock{Pct: &pct}, CapturedAt: now}
	r, out := setup(t,
		fake{id: domain.Codex, decision: warm, probe: func() (domain.Usage, error) { return probed, nil }},
		fake{id: domain.Kimi, decision: skip},
	)
	armStub(t, domain.Codex, "echo \"ARMED $WARMUP_PROVIDER session=$WARMUP_TMUX_SESSION\"\n")

	results, err := r.Tick(context.Background(), TickOptions{Mode: TickArm, Now: now})
	if err != nil || len(results) != 2 || results[0].Status != 0 {
		t.Fatalf("Tick = %+v, %v", results, err)
	}
	if results[0].Source != SourceProbe || results[1].Source != SourceCache {
		t.Errorf("sources = %s, %s", results[0].Source, results[1].Source)
	}

	codex := readEntry(t, r, domain.Codex)
	if codex.Session == nil || *codex.Session.Pct != 74 || !codex.LastWarmAt.Equal(now) {
		t.Errorf("codex entry = %+v", codex)
	}
	kimi := readEntry(t, r, domain.Kimi)
	if kimi.LastDecision == nil || kimi.LastDecision.Action != domain.ActionSkipActive || !kimi.LastWarmAt.IsZero() {
		t.Errorf("kimi entry = %+v", kimi)
	}

	for _, want := range []string{
		"[codex] ARMED codex session=agent-warmup-codex\n",
		"[codex] warm — no active window\n",
		"[kimi] skip-active — window active until 12:00\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	log := readLog(t, r)
	for _, want := range []string{"TICK [codex] warm — no active window [via probe]", "TICK [kimi] skip-active — window active until 12:00 [via cache]"} {
		if !strings.Contains(log, want) {
			t.Errorf("warmup.log lacks %q:\n%s", want, log)
		}
	}
}

func TestTickSkipsWhileAnotherTickRuns(t *testing.T) {
	r, out := setup(t, fake{id: domain.Kimi, decision: warm})
	armStub(t, domain.Kimi, "echo ARMED\n")
	if err := os.MkdirAll(r.Paths.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(r.Paths.Home, "tick.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}

	results, err := r.Tick(context.Background(), TickOptions{Mode: TickArm, Now: now})
	if err != nil || len(results) != 0 {
		t.Fatalf("Tick = %+v, %v", results, err)
	}
	if strings.Contains(out.String(), "ARMED") {
		t.Error("a second tick armed")
	}
	if !strings.Contains(readLog(t, r), "TICK skipped: another tick is running") {
		t.Errorf("log = %q", readLog(t, r))
	}
}

func TestTickDryRunNeverArms(t *testing.T) {
	r, out := setup(t, fake{id: domain.Kimi, decision: warm})
	armStub(t, domain.Kimi, "echo ARMED\n")

	results, err := r.Tick(context.Background(), TickOptions{Mode: TickDryRun, Now: now})
	if err != nil || results[0].Status != 0 {
		t.Fatalf("Tick = %+v, %v", results, err)
	}
	if strings.Contains(out.String(), "ARMED") {
		t.Error("dry run armed")
	}
	if !strings.Contains(readLog(t, r), "TICK [kimi] warm (dry-run) — no active window") {
		t.Errorf("log = %s", readLog(t, r))
	}
	e := readEntry(t, r, domain.Kimi)
	if !e.LastWarmAt.IsZero() || e.LastDecision == nil || e.LastDecision.Action != domain.ActionWarm {
		t.Errorf("entry = %+v", e)
	}
}

func TestTickProviderFilter(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Codex, decision: skip}, fake{id: domain.Kimi, decision: skip})
	results, err := r.Tick(context.Background(), TickOptions{Mode: TickDryRun, Provider: domain.Kimi, Now: now})
	if err != nil || len(results) != 1 || results[0].ID != domain.Kimi {
		t.Errorf("Tick(kimi) = %+v, %v", results, err)
	}
	if _, err := r.Tick(context.Background(), TickOptions{Provider: domain.Claude, Now: now}); err == nil || !strings.Contains(err.Error(), "provider claude is disabled") {
		t.Errorf("Tick(disabled claude) err = %v", err)
	}
}

func TestTickFailedArmStatus(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi, decision: warm})
	armStub(t, domain.Kimi, "exit 2\n")

	results, err := r.Tick(context.Background(), TickOptions{Mode: TickArm, Now: now})
	if err != nil || results[0].Status != 2 {
		t.Fatalf("Tick = %+v, %v; want status 2", results, err)
	}
	e := readEntry(t, r, domain.Kimi)
	if !e.LastFailureAt.Equal(now) || !e.LastWarmAt.IsZero() {
		t.Errorf("entry = %+v", e)
	}
	if !strings.Contains(readLog(t, r), "TICK [kimi] arm failed") {
		t.Error("RecordArm log line missing")
	}
}

func TestTickProbeErrorFallsBack(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Codex, decision: skip, probe: func() (domain.Usage, error) { return domain.Usage{}, errors.New("boom") }})
	results, err := r.Tick(context.Background(), TickOptions{Mode: TickArm, Now: now})
	if err != nil || results[0].Source != SourceCache {
		t.Errorf("Tick = %+v, %v", results, err)
	}
}

// TestTickInferredProbeKeepsCache: a probe that succeeds but can only infer
// (opencode stats with no spend) is not live data.
func TestTickInferredProbeKeepsCache(t *testing.T) {
	inferred := domain.Usage{CapturedAt: now, Inferred: true}
	r, _ := setup(t, fake{id: domain.Opencode, decision: skip, probe: func() (domain.Usage, error) { return inferred, nil }})
	pct := 40
	if err := cache.Update(r.Paths, domain.Opencode, func(e domain.CacheEntry) domain.CacheEntry {
		e.Week = &domain.LimitBlock{Pct: &pct}
		return e
	}); err != nil {
		t.Fatal(err)
	}
	results, err := r.Tick(context.Background(), TickOptions{Mode: TickDryRun, Now: now})
	if err != nil || results[0].Source != SourceCache {
		t.Fatalf("Tick = %+v, %v", results, err)
	}
	if e := readEntry(t, r, domain.Opencode); e.Week == nil || *e.Week.Pct != 40 {
		t.Errorf("cached week = %+v", e.Week)
	}
}

func TestRunOneWritesEmbeddedScript(t *testing.T) {
	r, out := setup(t, fake{id: domain.Kimi})
	status, err := r.RunOne(context.Background(), domain.Kimi, now)
	if err != nil || status != 0 {
		t.Fatalf("RunOne = %d, %v", status, err)
	}
	script := filepath.Join(r.Paths.Home, "arm-kimi.sh")
	info, err := os.Stat(script)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("arm script %s: %v, %v", script, info, err)
	}
	if got := out.String(); got != "[kimi] embedded kimi\n" {
		t.Errorf("output = %q", got)
	}
}

func TestRunOneRefusesDisabled(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	_, err := r.RunOne(context.Background(), domain.Claude, now)
	if err == nil || err.Error() != "provider claude is disabled (enable it with: agent-warmup provider claude enable)" {
		t.Errorf("err = %v", err)
	}
}

func TestRunOneMissingScript(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	t.Setenv("WARMUP_KIMI_SCRIPT", "/nonexistent/arm.sh")
	status, err := r.RunOne(context.Background(), domain.Kimi, now)
	if err != nil || status == 0 {
		t.Errorf("RunOne = %d, %v; want a failure status", status, err)
	}
}

func TestRunOneTimeout(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	armStub(t, domain.Kimi, "echo started\nsleep 30\n")
	old := armTimeout
	armTimeout = 200 * time.Millisecond
	t.Cleanup(func() { armTimeout = old })

	start := time.Now()
	status, err := r.RunOne(context.Background(), domain.Kimi, now)
	if err != nil || status != statusTimeout {
		t.Errorf("RunOne = %d, %v; want %d", status, err, statusTimeout)
	}
	if time.Since(start) > 10*time.Second {
		t.Error("the killed arm's children kept the run waiting")
	}
}

// TestRunOneChildHoldsOutput: a script that exits 0 while a child still holds
// its output succeeded; the pipe timeout is not a start failure.
func TestRunOneChildHoldsOutput(t *testing.T) {
	r, out := setup(t, fake{id: domain.Kimi})
	armStub(t, domain.Kimi, "sleep 2 &\nexit 0\n")
	old := killWait
	killWait = 100 * time.Millisecond
	t.Cleanup(func() { killWait = old })

	status, err := r.RunOne(context.Background(), domain.Kimi, now)
	if err != nil || status != 0 {
		t.Fatalf("RunOne = %d, %v; want 0", status, err)
	}
	if strings.Contains(out.String(), "failed to start") || !strings.Contains(out.String(), "kept its output open") {
		t.Errorf("output = %q", out)
	}
}

func TestRunAll(t *testing.T) {
	r, out := setup(t, fake{id: domain.Codex}, fake{id: domain.Kimi})
	armStub(t, domain.Codex, "echo \"ARMED $WARMUP_PROVIDER\"\n")
	armStub(t, domain.Kimi, "echo boom >&2\nexit 7\n")

	results, err := r.RunAll(context.Background(), now)
	want := []RunResult{{ID: domain.Codex}, {ID: domain.Kimi, Status: 7}}
	if err != nil || !reflect.DeepEqual(results, want) {
		t.Fatalf("RunAll = %+v, %v; want %+v", results, err, want)
	}
	for _, want := range []string{"[codex] ARMED codex\n", "[kimi] boom\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if readEntry(t, r, domain.Kimi).LastFailureAt.IsZero() {
		t.Error("kimi failure not recorded")
	}
}

// TestRunAllKeepsStatusBesideError: one provider's cache error must not hide
// another provider's arm status.
func TestRunAllKeepsStatusBesideError(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Codex}, fake{id: domain.Kimi})
	armStub(t, domain.Codex, "exit 7\n")
	// A directory where the arm script goes makes writing it fail.
	if err := os.MkdirAll(filepath.Join(r.Paths.Home, "arm-kimi.sh", "x"), 0o700); err != nil {
		t.Fatal(err)
	}

	results, err := r.RunAll(context.Background(), now)
	if err != nil || results[0].Status != 7 || results[1].Err == nil {
		t.Fatalf("RunAll = %+v, %v", results, err)
	}
}

func TestRunAllNone(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	r.Config.Providers = map[domain.ProviderID]domain.ProviderConfig{}
	if _, err := r.RunAll(context.Background(), now); err == nil || err.Error() != "no agents are enabled" {
		t.Errorf("err = %v", err)
	}
}

func TestLineWriter(t *testing.T) {
	var buf bytes.Buffer
	w := &lineWriter{prefix: "[x] ", w: &buf}
	for _, chunk := range []string{"a", "b\nc\n", "d"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	w.flush()
	if got := buf.String(); got != "[x] ab\n[x] c\n[x] d\n" {
		t.Errorf("lineWriter = %q", got)
	}
}

func TestViewLogs(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	ctx := context.Background()
	var out bytes.Buffer
	if status, err := ViewLogs(ctx, r.Paths, LogsStatic, &out); status != 0 || err != nil || out.String() != "No logs yet. Run a warmup first.\n" {
		t.Errorf("no log: %d, %v, %q", status, err, out.String())
	}

	appendLog(r.Paths, now, "TICK [kimi] warm")
	out.Reset()
	if status, err := ViewLogs(ctx, r.Paths, LogsStatic, &out); status != 0 || err != nil || !strings.HasSuffix(out.String(), "] TICK [kimi] warm\n") {
		t.Errorf("tail: %d, %v, %q", status, err, out.String())
	}
}

func TestViewLogsFollow(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	appendLog(r.Paths, now, "first")
	old := followPoll
	followPoll = 10 * time.Millisecond
	t.Cleanup(func() { followPoll = old })

	ctx, cancel := context.WithCancel(context.Background())
	out := &syncBuffer{}
	done := make(chan error)
	go func() {
		_, err := ViewLogs(ctx, r.Paths, LogsFollow, out)
		done <- err
	}()

	deadline := time.After(5 * time.Second)
	for !strings.Contains(out.String(), "first") {
		select {
		case <-deadline:
			t.Fatal("tail never printed")
		case <-time.After(5 * time.Millisecond):
		}
	}
	appendLog(r.Paths, now, "second")
	for !strings.Contains(out.String(), "second") {
		select {
		case <-deadline:
			t.Fatalf("follow never printed the appended line: %q", out.String())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestReadStatus(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	ctx := context.Background()

	s, err := ReadStatus(ctx, r.Paths, r.Config)
	if err != nil || s.Scheduler.Active || s.NextRun != "" || s.LastRun != "" {
		t.Errorf("inactive status = %+v, %v", s, err)
	}

	// Install the job of this OS by hand: the plist on macOS, else the cron block.
	job, text := os.Getenv("FAKE_CRONTAB"), "# >>> agent-warmup >>>\nx\n# <<< agent-warmup <<<\n"
	if runtime.GOOS == "darwin" {
		job, text = r.Paths.Plist, "plist"
	}
	sandbox.WriteExec(t, job, text)
	appendLog(r.Paths, now, "OK: kimi armed")
	s, err = ReadStatus(ctx, r.Paths, r.Config)
	if err != nil || !s.Scheduler.Active || s.NextRun != "every 15m · 08–23h" || !strings.HasSuffix(s.LastRun, "OK: kimi armed") {
		t.Errorf("active status = %+v, %v", s, err)
	}
}

// TestRunLessIgnoresCancel: Ctrl-C in less +F also cancels the signal context.
// less must keep the terminal until it exits by itself, not die of SIGKILL.
func TestRunLessIgnoresCancel(t *testing.T) {
	r, _ := setup(t, fake{id: domain.Kimi})
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	sandbox.WriteExec(t, filepath.Join(dir, "less"), "#!/bin/sh\ntouch "+marker+"\n")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if status, err := runLess(ctx, r.Paths, LogsFollow); status != 0 || err != nil {
		t.Fatalf("runLess = %d, %v", status, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("less did not run")
	}
}
