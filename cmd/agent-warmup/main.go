package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/d0whc3r/agent-warmup/internal/cli"
)

// Set with -ldflags "-X main.version=... -X main.commit=... -X main.date=...".
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Execute(ctx, cli.BuildInfo{Version: version, Commit: commit, Date: date})
	stop()
	os.Exit(code)
}
