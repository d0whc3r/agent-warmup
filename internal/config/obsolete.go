package config

import (
	"fmt"
	"log/slog"
	"slices"

	toml "github.com/pelletier/go-toml/v2"
)

// Keys that earlier Go builds wrote to config.toml before the options were
// removed. Load drops them so an existing file keeps loading.
var (
	obsoleteTopKeys      = []string{"mode", "scheduler", "selected_provider", "tick_minutes"}
	obsoleteProviderKeys = []string{"tmux_session", "schedule"}
)

// dropObsolete removes the obsolete keys from data. It returns the cleaned
// TOML and the dotted names of the dropped keys, or data unchanged when none.
func dropObsolete(data []byte) ([]byte, []string, error) {
	var doc map[string]any
	if err := toml.Unmarshal(data, &doc); err != nil {
		return nil, nil, fmt.Errorf("parse config: %w", err)
	}

	var dropped []string
	for _, key := range obsoleteTopKeys {
		if _, ok := doc[key]; ok {
			delete(doc, key)
			dropped = append(dropped, key)
		}
	}
	providers, _ := doc["providers"].(map[string]any)
	for _, id := range slices.Sorted(mapKeys(providers)) {
		table, _ := providers[id].(map[string]any)
		for _, key := range obsoleteProviderKeys {
			if _, ok := table[key]; ok {
				delete(table, key)
				dropped = append(dropped, "providers."+id+"."+key)
			}
		}
	}
	if len(dropped) == 0 {
		return data, nil, nil
	}

	clean, err := toml.Marshal(doc)
	if err != nil {
		return nil, nil, fmt.Errorf("encode config: %w", err)
	}
	for _, key := range dropped {
		slog.Info("dropped removed option from config", "key", key)
	}
	return clean, dropped, nil
}

func mapKeys(m map[string]any) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}
