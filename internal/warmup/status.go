package warmup

import (
	"context"

	"github.com/d0whc3r/agent-warmup/internal/cache"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/logs"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/scheduler"
)

// Status is everything the status block and the TUI snapshot show.
type Status struct {
	Config    domain.Config
	Scheduler scheduler.Status
	NextRun   string // "" when the scheduler is inactive or nothing is scheduled
	LastRun   string // newest outcome line of warmup.log, "" when none
	Cache     domain.Cache
}

func ReadStatus(ctx context.Context, p paths.Paths, cfg domain.Config) (Status, error) {
	s := Status{Config: cfg}
	var err error
	if s.Scheduler, err = scheduler.State(ctx, p); err != nil {
		return s, err
	}
	if s.Scheduler.Active {
		s.NextRun = scheduler.NextRun(cfg)
	}
	if s.LastRun, err = logs.LastRun(p); err != nil {
		return s, err
	}
	s.Cache, err = cache.Read(p)
	return s, err
}
