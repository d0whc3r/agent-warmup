// Package config loads, validates, and saves ~/.agent-warmup/config.toml.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"slices"
	"strings"

	toml "github.com/pelletier/go-toml/v2"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

const (
	maxHour    = domain.HoursPerDay - 1
	maxWorkEnd = domain.HoursPerDay // work_end is exclusive, so 24 covers the last hour of the day
	minPercent = 1
	maxPercent = 100
)

const header = `# agent-warmup configuration.
# Edit a value and run "agent-warmup restart" to apply it.
`

type providerDefaults struct {
	binary            string
	model             string
	weeklyStopPercent int
}

var defaultsByID = map[domain.ProviderID]providerDefaults{
	domain.Claude:   {"~/.local/bin/claude", "haiku", 90},
	domain.Codex:    {"~/.local/bin/codex", "gpt-5.6-luna", 85},
	domain.Zai:      {"~/.opencode/bin/opencode", "zai-coding-plan/glm-5.3-flash", 85},
	domain.Kimi:     {"~/.kimi-code/bin/kimi", "kimi-code/kimi-for-coding", 85},
	domain.Opencode: {"~/.opencode/bin/opencode", "opencode-go/deepseek-v4-flash", 85},
	domain.Minimax:  {"~/.opencode/bin/opencode", "minimax-coding-plan/MiniMax-M2.7", 85},
	domain.Agy:      {"~/.local/bin/agy", "gemini-4-hydrogen", 85},
}

// Defaults is the documented starting configuration: every provider present
// but only Claude enabled, because each warmup spends real quota.
func Defaults() domain.Config {
	providers := make(map[domain.ProviderID]domain.ProviderConfig, len(domain.ProviderIDs))
	for _, id := range domain.ProviderIDs {
		providers[id] = DefaultProvider(id)
	}
	return domain.Config{Providers: providers}
}

// DefaultProvider is the default [providers.<id>] table. Detection also uses
// its binary as the install location to look in first.
func DefaultProvider(id domain.ProviderID) domain.ProviderConfig {
	d := defaultsByID[id]
	return domain.ProviderConfig{
		Enabled:           id == domain.Claude,
		Binary:            d.binary,
		Model:             d.model,
		WorkStart:         8,
		WorkEnd:           23,
		WeeklyStopPercent: d.weeklyStopPercent,
	}
}

// Load reads config.toml on top of Defaults, so a missing key or provider table
// keeps its default value. When config.toml does not exist, Load converts
// warmup.env if it exists, else writes Defaults to config.toml.
func Load(p paths.Paths) (domain.Config, error) {
	data, err := os.ReadFile(p.Config)
	if errors.Is(err, fs.ErrNotExist) {
		return firstLoad(p)
	}
	if err != nil {
		return domain.Config{}, fmt.Errorf("read config: %w", err)
	}

	data, dropped, err := dropObsolete(data)
	if err != nil {
		return domain.Config{}, fmt.Errorf("%s: %w", p.Config, err)
	}

	cfg := Defaults()
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return domain.Config{}, fmt.Errorf("parse %s: %w", p.Config, describeDecodeError(err))
	}
	if err := Validate(cfg); err != nil {
		return domain.Config{}, fmt.Errorf("%s is not valid: %w", p.Config, err)
	}

	// Rewrite the file so the dropped keys are gone for good.
	if len(dropped) > 0 {
		if err := Save(p, cfg); err != nil {
			return domain.Config{}, err
		}
	}
	return cfg, nil
}

func firstLoad(p paths.Paths) (domain.Config, error) {
	_, err := os.Stat(p.LegacyEnv)
	if err == nil {
		return migrate(p)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return domain.Config{}, fmt.Errorf("check %s: %w", p.LegacyEnv, err)
	}

	cfg := Defaults()
	if err := Save(p, cfg); err != nil {
		return domain.Config{}, err
	}
	slog.Info("created config", "path", p.Config)
	return cfg, nil
}

// describeDecodeError keeps the key and line of a strict-mode or syntax error,
// which go-toml only prints through its own String methods.
func describeDecodeError(err error) error {
	var strict *toml.StrictMissingError
	if errors.As(err, &strict) {
		return fmt.Errorf("unknown key:\n%s", strict.String())
	}
	var syntax *toml.DecodeError
	if errors.As(err, &syntax) {
		return fmt.Errorf("%s", syntax.String())
	}
	return err
}

// Save validates cfg and writes it atomically to config.toml.
func Save(p paths.Paths, cfg domain.Config) error {
	if err := Validate(cfg); err != nil {
		return fmt.Errorf("configuration is not valid and was not saved: %w", err)
	}
	body, err := toml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	return atomicfile.Write(p.Config, append([]byte(header+"\n"), body...))
}

// Validate returns every rule cfg breaks, each prefixed with its config.toml key.
func Validate(cfg domain.Config) error {
	var errs []error
	fail := func(key, format string, args ...any) {
		errs = append(errs, fmt.Errorf("%s: "+format, append([]any{key}, args...)...))
	}

	for _, id := range slices.Sorted(maps.Keys(cfg.Providers)) {
		if _, err := domain.ParseProviderID(string(id)); err != nil {
			fail("providers."+string(id), "%v", err)
		}
	}
	for _, id := range domain.ProviderIDs {
		pc, ok := cfg.Providers[id]
		if !ok {
			fail("providers."+string(id), "table is missing")
			continue
		}
		for _, err := range validateProvider(pc) {
			errs = append(errs, fmt.Errorf("providers.%s.%w", id, err))
		}
	}
	return errors.Join(errs...)
}

func validateProvider(pc domain.ProviderConfig) []error {
	var errs []error
	fail := func(key, format string, args ...any) {
		errs = append(errs, fmt.Errorf("%s: "+format, append([]any{key}, args...)...))
	}

	if strings.TrimSpace(pc.Binary) == "" {
		fail("binary", "must not be empty")
	}
	if strings.TrimSpace(pc.Model) == "" {
		fail("model", "must not be empty")
	}
	if pc.WorkStart < 0 || pc.WorkStart > maxHour {
		fail("work_start", "%d is out of range 0-%d", pc.WorkStart, maxHour)
	}
	if pc.WorkEnd <= pc.WorkStart || pc.WorkEnd > maxWorkEnd {
		fail("work_end", "%d must be after work_start (%d) and at most %d", pc.WorkEnd, pc.WorkStart, maxWorkEnd)
	}
	if pc.WeeklyStopPercent < minPercent || pc.WeeklyStopPercent > maxPercent {
		fail("weekly_stop_percent", "%d is out of range %d-%d", pc.WeeklyStopPercent, minPercent, maxPercent)
	}
	return errs
}
