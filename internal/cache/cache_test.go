package cache

import (
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

func testPaths(t *testing.T) paths.Paths {
	t.Helper()
	t.Setenv("WARMUP_HOME", t.TempDir()+"/home")
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func mustRead(t *testing.T, p paths.Paths) domain.Cache {
	t.Helper()
	c, err := Read(p)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestReadMissingIsEmpty(t *testing.T) {
	p := testPaths(t)
	c := mustRead(t, p)
	if c.Providers == nil || len(c.Providers) != 0 {
		t.Errorf("Read of a missing file = %+v, want empty providers", c)
	}
}

// TestReadCorruptResets: a cache that does not parse must not stop every
// tick. It moves to .bad and the read starts empty.
func TestReadCorruptResets(t *testing.T) {
	for _, text := range []string{"{not json", "42", `{"providers":[]}`} {
		p := testPaths(t)
		if err := os.MkdirAll(p.Home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p.Cache, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		c, err := Read(p)
		if err != nil || len(c.Providers) != 0 || c.Providers == nil {
			t.Errorf("Read(%q) = %+v, %v; want an empty cache", text, c, err)
		}
		if bad, err := os.ReadFile(p.Cache + ".bad"); err != nil || string(bad) != text {
			t.Errorf("Read(%q) kept %q, %v in .bad", text, bad, err)
		}
		if _, err := os.Stat(p.Cache); !os.IsNotExist(err) {
			t.Errorf("Read(%q) left the corrupt cache in place", text)
		}
	}
}

func TestWriteRoundTrip(t *testing.T) {
	p := testPaths(t)
	pct := 40
	now := time.Date(2026, 6, 13, 15, 30, 0, 0, time.UTC)
	want := domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{
		domain.Claude: {
			Usage: domain.Usage{
				Session:    &domain.LimitBlock{Pct: &pct, ResetsAt: now.Add(time.Hour), Active: true},
				WeekModel:  &domain.ModelLimitBlock{LimitBlock: domain.LimitBlock{Pct: &pct}, Label: "Fable"},
				CapturedAt: now,
			},
			LastDecision: &domain.CachedDecision{Decision: domain.Decision{Action: domain.ActionSkipActive, Reason: "r"}, At: now},
		},
		domain.Kimi: {LastWarmAt: now},
	}}
	if err := write(p, want); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, p); !reflect.DeepEqual(got, want) {
		t.Errorf("round trip:\n got %+v\nwant %+v", got, want)
	}
	data, err := os.ReadFile(p.Cache)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(data), "\n") {
		t.Error("cache file has no trailing newline")
	}
}

func TestUpdateCreatesAndPatches(t *testing.T) {
	p := testPaths(t)
	t1, t2 := time.Unix(7, 0).UTC(), time.Unix(8, 0).UTC()
	err := Update(p, domain.Codex, func(e domain.CacheEntry) domain.CacheEntry {
		if !reflect.DeepEqual(e, domain.CacheEntry{}) {
			t.Errorf("absent entry = %+v, want zero", e)
		}
		e.LastWarmAt = t1
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	err = Update(p, domain.Codex, func(e domain.CacheEntry) domain.CacheEntry {
		e.CooldownUntil = t2
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	got := mustRead(t, p).Providers[domain.Codex]
	if !got.LastWarmAt.Equal(t1) || !got.CooldownUntil.Equal(t2) {
		t.Errorf("codex entry = %+v", got)
	}
}

func TestUpdateKeepsSiblingWrites(t *testing.T) {
	p := testPaths(t)
	if err := write(p, domain.Cache{Providers: map[domain.ProviderID]domain.CacheEntry{domain.Codex: {}}}); err != nil {
		t.Fatal(err)
	}
	stale := mustRead(t, p)
	stale.Providers[domain.Kimi] = domain.CacheEntry{LastWarmAt: time.Unix(2, 0).UTC()}
	if err := write(p, stale); err != nil { // another process wrote kimi meanwhile
		t.Fatal(err)
	}
	err := Update(p, domain.Codex, func(e domain.CacheEntry) domain.CacheEntry {
		e.LastWarmAt = time.Unix(3, 0).UTC()
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, p).Providers[domain.Kimi].LastWarmAt; got.Unix() != 2 {
		t.Errorf("sibling kimi entry lost: %v", got)
	}
}

func TestUpdateConcurrent(t *testing.T) {
	p := testPaths(t)
	var wg sync.WaitGroup
	errs := make(chan error, len(domain.ProviderIDs))
	for i, id := range domain.ProviderIDs {
		wg.Go(func() {
			errs <- Update(p, id, func(e domain.CacheEntry) domain.CacheEntry {
				e.LastWarmAt = time.Unix(int64(i+1), 0).UTC()
				return e
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	c := mustRead(t, p)
	for i, id := range domain.ProviderIDs {
		if got := c.Providers[id].LastWarmAt.Unix(); got != int64(i+1) {
			t.Errorf("%s lastWarmAt = %d, want %d", id, got, i+1)
		}
	}
}
