// src/providers/index.ts -- registry. The single source of truth for which
// providers ship built-in; loadConfig() reads `WARMUP_PROVIDERS` (CSV) and the
// order there is the order the tick iterates.
import type { MultiConfig, ProviderId, UsageCache, UsageView } from '../types.js';
import { claudeProvider, formatUsage } from './claude.js';
import { opencodeProvider } from './opencode.js';
import { codexProvider, kimiProvider, minimaxProvider, zaiProvider } from './subscriptions.js';
import type { Provider } from './types.js';

// The full set of built-in providers. New providers get added here (and only
// here); everything else reads from `getProvider(id)` / `listProviderIds()`.
const REGISTRY: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  zai: zaiProvider,
  kimi: kimiProvider,
  minimax: minimaxProvider,
};

export function getProvider(id: ProviderId): Provider {
  const p = REGISTRY[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

// Ordered list of all known providers (used by config migration to seed the
// default `WARMUP_PROVIDERS` list when the user has none).
export const ALL_PROVIDER_IDS: readonly ProviderId[] = [
  'claude',
  'codex',
  'zai',
  'kimi',
  'opencode',
  'minimax',
];

// Display view of one provider's usage. Providers without a live probe (or whose
// probe has not succeeded yet) have no session/week in the cache, so derive the
// snapshot from their last successful arm the same way the tick does.
export function usageView(
  id: ProviderId,
  cache: UsageCache | null | undefined,
  multi: MultiConfig,
  now: Date = new Date(),
): UsageView | null {
  const entry = cache?.providers?.[id] ?? null;
  if (entry?.session || entry?.week) return formatUsage(entry);
  const cfg = multi.providers[id];
  if (!cfg) return null;
  const inferred = getProvider(id).inferFromCache({ cfg, shared: multi.shared, now }, entry);
  return formatUsage({ ...entry, ...inferred });
}
