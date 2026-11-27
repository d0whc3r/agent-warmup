// Package detect finds each agent's binary. launchd and cron start with a
// minimal PATH, so the config must hold an absolute path. Detection scans
// the usual install prefixes and the interactive PATH.
package detect

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

// lookup is provider.Get. Tests replace it with a fake provider.
var lookup = provider.Get

// extraDirs are searched after the default binary's directory and PATH.
var extraDirs = []string{"~/.local/bin", "~/.bun/bin", "~/.volta/bin", "~/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}

// extraDirsByID are install places that do not follow from the default binary.
var extraDirsByID = map[domain.ProviderID][]string{domain.Claude: {"~/.claude/local"}}

type Detection struct {
	ID           domain.ProviderID
	Name         string // display name
	Binary       string // executable name looked for, for example "opencode"
	Path         string // first executable found, "" when none
	Configured   string // binary value in the config, as written
	ConfiguredOK bool   // Configured is an executable file now
	Blocked      string // why Path is "" even when the binary exists, else ""
}

// Detect finds id's binary. A working configured path wins, so a hand-picked
// location is never replaced by one found on PATH. A plan that runs through
// opencode needs its credential key in opencode's auth.json, because the
// shared binary alone proves nothing.
func Detect(p paths.Paths, id domain.ProviderID, configured string) Detection {
	prov := lookup(id)
	fallback := config.DefaultProvider(id).Binary
	if configured == "" {
		configured = fallback
	}
	d := Detection{ID: id, Name: prov.Name(), Binary: filepath.Base(fallback), Configured: configured}

	if key := prov.CredentialKey(); key != "" && !hasCredential(p.OpencodeAuth, key) {
		d.Blocked = fmt.Sprintf("no %q credential in opencode", key)
		return d
	}

	expanded := p.ExpandHome(configured)
	d.ConfiguredOK = isExecutable(expanded)
	if d.ConfiguredOK {
		d.Path = expanded
		return d
	}

	dirs := slices.Concat([]string{filepath.Dir(p.ExpandHome(fallback))}, filepath.SplitList(os.Getenv("PATH")), extraDirsByID[id], extraDirs)
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(p.ExpandHome(dir), d.Binary)
		if isExecutable(candidate) {
			d.Path = candidate
			return d
		}
	}
	return d
}

// All detects every provider in domain.ProviderIDs order.
func All(p paths.Paths, cfg domain.Config) []Detection {
	out := make([]Detection, len(domain.ProviderIDs))
	for i, id := range domain.ProviderIDs {
		out[i] = Detect(p, id, cfg.Providers[id].Binary)
	}
	return out
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

// hasCredential reports whether auth.json has key at the top level. A missing
// or unreadable file means the plan cannot arm, which is the same answer.
func hasCredential(authFile, key string) bool {
	data, err := os.ReadFile(authFile)
	if err != nil {
		return false
	}
	var auth map[string]json.RawMessage
	if json.Unmarshal(data, &auth) != nil {
		return false
	}
	_, ok := auth[key]
	return ok
}
