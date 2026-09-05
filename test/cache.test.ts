import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// paths.js resolves WARMUP_HOME at import time, so the throwaway home has to be in
// place before the module graph loads — hence the dynamic import below.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-cache-'));
process.env.WARMUP_HOME = HOME_DIR;
const CACHE = path.join(HOME_DIR, 'usage-cache.json');
const { readCache, writeCache, updateProviderCache } = await import('../src/cache.js');

function seed(text: string): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CACHE, text);
}

test('a missing, unparseable or non-object cache reads as empty', () => {
  fs.rmSync(CACHE, { force: true });
  assert.deepEqual(readCache(), { providers: {} });
  seed('{not json');
  assert.deepEqual(readCache(), { providers: {} });
  seed('42');
  assert.deepEqual(readCache(), { providers: {} });
  seed('null');
  assert.deepEqual(readCache(), { providers: {} });
});

test('the legacy flat cache is migrated to the per-provider shape on read', () => {
  // Pre-multi-provider installs wrote { session, week, lastWarmAt } at the top level.
  seed(JSON.stringify({ session: { pct: 40 }, week: { pct: 12 }, lastWarmAt: 1234 }));
  const cache = readCache();
  assert.equal(cache.selectedProvider, 'claude');
  assert.deepEqual(cache.providers.claude, {
    session: { pct: 40 },
    week: { pct: 12 },
    lastWarmAt: 1234,
  });
});

test('writeCache creates the home dir and round-trips through readCache', () => {
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  const cache = { providers: { kimi: { lastWarmAt: 99 } }, selectedProvider: 'kimi' as const };
  writeCache(cache);
  assert.deepEqual(readCache(), cache);
  // Trailing newline so the file stays diff/`cat`-friendly.
  assert.ok(fs.readFileSync(CACHE, 'utf8').endsWith('\n'));
});

test('updateProviderCache patches one entry and creates it when absent', () => {
  writeCache({ providers: {} });
  updateProviderCache('codex', (entry) => {
    assert.deepEqual(entry, {}, 'an absent entry is patched from {}');
    return { ...entry, lastWarmAt: 7 };
  });
  updateProviderCache('codex', (entry) => ({ ...entry, cooldownUntil: 8 }));
  assert.deepEqual(readCache().providers.codex, { lastWarmAt: 7, cooldownUntil: 8 });
});

test('updateProviderCache re-reads first, so a concurrent writer is never clobbered', () => {
  // The tick and a manual run arm every provider at once; each writer must merge
  // into whatever is on disk *now*, not into the snapshot it read minutes ago.
  writeCache({ providers: { codex: { lastWarmAt: 1 } } });
  const staleSnapshot = readCache();
  // Another process finishes its arm while we hold `staleSnapshot`.
  writeCache({ providers: { ...staleSnapshot.providers, kimi: { lastWarmAt: 2 } } });
  updateProviderCache('codex', (entry) => ({ ...entry, lastWarmAt: 3 }));
  const after = readCache();
  assert.equal(after.providers.codex?.lastWarmAt, 3);
  assert.equal(after.providers.kimi?.lastWarmAt, 2, 'the sibling entry survived');
});
