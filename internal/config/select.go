package config

import (
	"maps"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// WithProvider returns a copy of cfg with one provider changed by edit. The
// copy has its own providers map, so cfg stays as it was.
func WithProvider(cfg domain.Config, id domain.ProviderID, edit func(*domain.ProviderConfig)) domain.Config {
	next := cfg
	next.Providers = maps.Clone(cfg.Providers)
	pc := next.Providers[id]
	edit(&pc)
	next.Providers[id] = pc
	return next
}
