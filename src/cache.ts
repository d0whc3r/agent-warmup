// The on-disk usage cache: one entry per provider (last probe snapshot, last
// decision, last successful arm). Lives in its own module so both the tick and
// the runner can read/write it without importing each other.
import fs from 'node:fs';
import path from 'node:path';

import { USAGE_CACHE } from './paths.js';
import type { ProviderCache, ProviderId, UsageCache } from './types.js';

// Read the on-disk cache. Migrates the LEGACY flat shape (session/week/... at
// the top level) to the new per-provider map on first read.
export function readCache(): UsageCache {
  let text: string;
  try {
    text = fs.readFileSync(USAGE_CACHE, 'utf8');
  } catch {
    return { providers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { providers: {} };
  }
  if (!parsed || typeof parsed !== 'object') return { providers: {} };
  const obj = parsed as Record<string, unknown>;
  // New shape: { providers: { claude: {...}, opencode: {...} }, selectedProvider? }
  if (obj.providers && typeof obj.providers === 'object') {
    return obj as unknown as UsageCache;
  }
  // Legacy shape: { session, week, lastDecision, lastWarmAt, ... } at the top.
  // Wrap as { providers: { claude: <legacy> }, selectedProvider: 'claude' }.
  return {
    providers: { claude: obj as unknown as ProviderCache },
    selectedProvider: 'claude',
  };
}

export function writeCache(cache: UsageCache): void {
  fs.mkdirSync(path.dirname(USAGE_CACHE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE, JSON.stringify(cache, null, 2) + '\n');
}

// Read-patch-write one provider's entry. Providers run concurrently (parallel tick
// and run), so every writer re-reads the file first instead of writing back an
// in-memory copy that no longer has the other providers' latest entries.
export function updateProviderCache(
  id: ProviderId,
  patch: (entry: ProviderCache) => ProviderCache,
): void {
  const cache = readCache();
  cache.providers[id] = patch(cache.providers[id] ?? {});
  writeCache(cache);
}
