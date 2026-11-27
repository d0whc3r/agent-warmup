package sysexec

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/sandbox"
)

func TestRunErrors(t *testing.T) {
	s := sandbox.New(t)
	s.AddBin(t, "fails", "#!/bin/sh\necho oops >&2\nexit 3\n")
	ctx := context.Background()

	_, err := Run(ctx, "fails", "a")
	if !Exited(err) || !strings.Contains(err.Error(), "fails a") || !strings.Contains(err.Error(), "oops") {
		t.Errorf("exit error = %v", err)
	}
	if _, err := Run(ctx, "no-such-command-xyz"); err == nil || Exited(err) {
		t.Errorf("start error = %v, want a non-exit error", err)
	}
}

func TestCrontabRoundTrip(t *testing.T) {
	s := sandbox.New(t)
	ctx := context.Background()
	if text, err := ReadCrontab(ctx); text != "" || err != nil {
		t.Errorf("no crontab = %q, %v", text, err)
	}
	if err := WriteCrontab(ctx, "0 0 * * * x\n"); err != nil {
		t.Fatal(err)
	}
	if text, err := ReadCrontab(ctx); text != "0 0 * * * x\n" || err != nil || s.CrontabWrites(t) != 1 {
		t.Errorf("crontab = %q, %v", text, err)
	}
}

func TestDevNullIsNotTerminal(t *testing.T) {
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if IsTerminal(f) {
		t.Error("IsTerminal(/dev/null) = true")
	}
}
