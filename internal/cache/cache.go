// Package cache reads and writes usage-cache.json: one entry per provider with
// the last probed usage, the last decision, and arm bookkeeping.
package cache

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

// Read returns the cache, or an empty cache when the file does not exist yet.
// A cache that does not parse moves to <file>.bad, with a warning, and the
// read returns an empty cache. A broken cache must not stop every tick.
func Read(p paths.Paths) (domain.Cache, error) {
	empty := domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{}}
	data, err := os.ReadFile(p.Cache)
	if errors.Is(err, fs.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return domain.Cache{}, fmt.Errorf("read cache: %w", err)
	}

	c := empty
	if err := json.Unmarshal(data, &c); err != nil {
		bad := p.Cache + ".bad"
		slog.Warn("moved the unreadable cache aside and started with an empty cache", "file", p.Cache, "moved_to", bad, "err", err)
		// A concurrent reader can move it first.
		if err := os.Rename(p.Cache, bad); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return domain.Cache{}, fmt.Errorf("move %s aside: %w", p.Cache, err)
		}
		return domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{}}, nil
	}
	if c.Providers == nil {
		c.Providers = empty.Providers
	}
	return c, nil
}

// write replaces the cache file atomically.
func write(p paths.Paths, c domain.Cache) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cache: %w", err)
	}
	return atomicfile.Write(p.Cache, append(data, '\n'))
}

// Update applies patch to one provider's entry (a zero entry when absent) and
// writes the result. Providers arm concurrently, in goroutines and in separate
// tick and run processes, so Update holds an exclusive flock on a sibling lock
// file and re-reads the cache under it: no writer drops another's entry.
func Update(p paths.Paths, id domain.ProviderID, patch func(domain.CacheEntry) domain.CacheEntry) error {
	unlock, err := lock(p.Cache + ".lock")
	if err != nil {
		return err
	}
	defer unlock()

	c, err := Read(p)
	if err != nil {
		return err
	}
	c.Providers[id] = patch(c.Providers[id])
	return write(p, c)
}

// lock takes an exclusive flock. Each call opens its own file description, so
// two goroutines in one process exclude each other as well as two processes.
func lock(path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), atomicfile.DirMode); err != nil {
		return nil, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, atomicfile.FileMode)
	if err != nil {
		return nil, fmt.Errorf("open cache lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock cache: %w", err)
	}
	// Closing the file releases the flock.
	return func() { f.Close() }, nil
}
