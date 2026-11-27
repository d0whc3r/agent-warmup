package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

const backupSuffix = ".bak"

// migrate converts the TypeScript release's warmup.env to config.toml once.
// It writes config.toml, then renames warmup.env and the old usage cache, whose
// JSON format changed, to *.bak. It does not change a warmup.env that is not valid.
func migrate(p paths.Paths) (domain.Config, error) {
	data, err := os.ReadFile(p.LegacyEnv)
	if err != nil {
		return domain.Config{}, fmt.Errorf("read %s: %w", p.LegacyEnv, err)
	}
	cfg, err := fromEnv(parseEnv(string(data)))
	if err != nil {
		return domain.Config{}, fmt.Errorf("convert %s: %w", p.LegacyEnv, err)
	}
	if err := Validate(cfg); err != nil {
		return domain.Config{}, fmt.Errorf("convert %s: correct the value or delete the file: %w", p.LegacyEnv, err)
	}
	if err := Save(p, cfg); err != nil {
		return domain.Config{}, err
	}

	for _, old := range []string{p.LegacyEnv, p.Cache} {
		err := os.Rename(old, old+backupSuffix)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return domain.Config{}, fmt.Errorf("back up %s: %w", old, err)
		}
	}
	slog.Info("migrated config", "from", p.LegacyEnv, "to", p.Config, "backup", p.LegacyEnv+backupSuffix)
	return cfg, nil
}

// parseEnv reads the .env syntax the TypeScript release wrote and accepted:
// blank and # lines are skipped, the key ends at the first '=', surrounding
// quotes are stripped, and an unquoted value ends at " #".
func parseEnv(text string) map[string]string {
	env := map[string]string{}
	for raw := range strings.SplitSeq(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		} else if i := strings.Index(value, " #"); i >= 0 {
			value = strings.TrimSpace(value[:i])
		}
		env[strings.TrimSpace(key)] = value
	}
	return env
}

// envReader looks up keys and keeps the first parse error, so fromEnv reads
// as a flat list of assignments. An empty value counts as absent.
type envReader struct {
	env map[string]string
	err error
}

func (r *envReader) str(key string, dst *string) {
	if v := r.env[key]; v != "" {
		*dst = v
	}
}

func (r *envReader) int(key string, dst *int) {
	v := r.env[key]
	if v == "" || r.err != nil {
		return
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		r.err = fmt.Errorf("%s: %q is not a whole number", key, v)
		return
	}
	*dst = n
}

func (r *envReader) bool(key string, dst *bool) {
	v := r.env[key]
	if v == "" || r.err != nil {
		return
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		r.err = fmt.Errorf("%s: %q is not true or false", key, v)
		return
	}
	*dst = b
}

// fromEnv maps both .env schemas onto Defaults. The multi-provider schema has
// WARMUP_PROVIDERS and WARMUP_<ID>_* keys. A provider is enabled when it is in
// WARMUP_PROVIDERS and its _ENABLED key is not false. The older flat schema has
// no WARMUP_PROVIDERS. Its keys belong to Claude, the only provider it had.
// A key that config.toml no longer has is dropped with one log line.
func fromEnv(env map[string]string) (domain.Config, error) {
	cfg := Defaults()
	r := &envReader{env: env}
	for _, key := range droppedKeys() {
		if v, ok := env[key]; ok {
			slog.Info("dropped warmup.env key: agent-warmup no longer has this setting", "key", key, "value", v)
		}
	}

	list, multi := env["WARMUP_PROVIDERS"]
	if !multi {
		claude := cfg.Providers[domain.Claude]
		r.str("WARMUP_MODEL", &claude.Model)
		r.int("WARMUP_WORK_START", &claude.WorkStart)
		r.int("WARMUP_WORK_END", &claude.WorkEnd)
		r.int("WARMUP_WEEKLY_STOP_PERCENT", &claude.WeeklyStopPercent)
		cfg.Providers[domain.Claude] = claude
		return cfg, r.err
	}

	listed := map[domain.ProviderID]bool{}
	for part := range strings.SplitSeq(list, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		id, err := domain.ParseProviderID(part)
		if err != nil {
			return domain.Config{}, fmt.Errorf("WARMUP_PROVIDERS: %w", err)
		}
		listed[id] = true
	}

	for _, id := range domain.ProviderIDs {
		pc := cfg.Providers[id]
		prefix := envPrefix(id)
		r.bool(prefix+"ENABLED", &pc.Enabled)
		pc.Enabled = pc.Enabled && listed[id]
		r.str(prefix+"BIN", &pc.Binary)
		r.str(prefix+"MODEL", &pc.Model)
		r.int(prefix+"WORK_START", &pc.WorkStart)
		r.int(prefix+"WORK_END", &pc.WorkEnd)
		r.int(prefix+"WEEKLY_STOP_PERCENT", &pc.WeeklyStopPercent)
		cfg.Providers[id] = pc
	}
	return cfg, r.err
}

func envPrefix(id domain.ProviderID) string { return "WARMUP_" + strings.ToUpper(string(id)) + "_" }

// droppedKeys are the warmup.env keys of settings that config.toml does not
// have: the mode, the scheduler, the tick, the selected provider, the fixed
// hours, and the tmux session.
func droppedKeys() []string {
	keys := make([]string, 0, 5+len(domain.ProviderIDs))
	keys = append(keys, "WARMUP_MODE", "WARMUP_SCHEDULER", "WARMUP_TICK_MINUTES", "WARMUP_SELECTED_PROVIDER", "WARMUP_SCHEDULE")
	for _, id := range domain.ProviderIDs {
		keys = append(keys, envPrefix(id)+"SCHEDULE")
	}
	return append(keys, sessionKeys()...)
}

// sessionKeys are the warmup.env keys of a tmux session: the flat schema's
// and each provider's.
func sessionKeys() []string {
	keys := make([]string, 0, 1+len(domain.ProviderIDs))
	keys = append(keys, "WARMUP_TMUX_SESSION")
	for _, id := range domain.ProviderIDs {
		keys = append(keys, envPrefix(id)+"TMUX_SESSION")
	}
	return keys
}

// LegacySessions lists the tmux sessions the TypeScript release used: the
// default "<id>-warmup" of every provider, and each session that warmup.env,
// or its backup after the migration, set.
func LegacySessions(p paths.Paths) []string {
	var sessions []string
	for _, id := range domain.ProviderIDs {
		sessions = append(sessions, string(id)+"-warmup")
	}
	for _, path := range []string{p.LegacyEnv, p.LegacyEnv + backupSuffix} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		env := parseEnv(string(data))
		for _, key := range sessionKeys() {
			if s := env[key]; s != "" && !slices.Contains(sessions, s) {
				sessions = append(sessions, s)
			}
		}
	}
	return sessions
}
