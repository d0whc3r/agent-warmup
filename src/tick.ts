// One smart-mode tick: iterate every enabled provider, probe usage, decide
// whether to arm, and arm when warranted. Each provider keeps its own
// per-provider cache entry under the configured warmup home. The
// scheduler runs this every `tickMinutes` (smart mode) or per fixed-hour
// (fixed mode) -- in either case the iteration order is the order the user
// set in WARMUP_PROVIDERS.
//
// This module is the single orchestrator for the multi-provider design in
// docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md. The
// provider-specific logic lives in src/providers/<id>.ts; this file only
// handles the cross-cutting concerns (cache, log lines, exit status).
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { appendLog, pruneLogs } from './logs.js';
import { USAGE_CACHE } from './paths.js';
import { getProvider } from './providers/index.js';
import type { ProbeContext, Provider } from './providers/types.js';
import { runNow } from './runner.js';
import type {
  Decision,
  MultiConfig,
  ProviderCache,
  ProviderConfig,
  ProviderId,
  ProviderUsage,
  UsageCache,
} from './types.js';

interface ProviderTickResult {
  id: ProviderId;
  decision: import('./types.js').Decision;
  status: number;
  usage: ProviderUsage | null;
  probed: boolean;
}

export interface TickResult {
  results: ProviderTickResult[];
  dryRun: boolean;
}

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

// One smart-mode tick: probe -> decide -> maybe arm, for each enabled provider.
export function runTick({
  dryRun = false,
  now = new Date(),
  providerId,
}: { dryRun?: boolean; now?: Date; providerId?: ProviderId } = {}): TickResult {
  const multi = loadConfig();
  const cache = readCache();
  const results: ProviderTickResult[] = [];

  const providers = providerId
    ? ([providerId] as ProviderId[]).filter((id) => multi.providers[id]?.enabled)
    : multi.shared.providers.filter((id) => multi.providers[id]?.enabled);

  for (const id of providers) {
    const providerCfg = multi.providers[id];
    if (!providerCfg) continue;
    const providerCache = cache.providers[id] ?? {};
    const result = tickOne({
      id,
      multi,
      providerCfg,
      providerCache,
      cache,
      dryRun,
      now,
    });
    results.push(result);
  }

  pruneLogs(now);
  return { results, dryRun };
}

interface TickOneArgs {
  id: ProviderId;
  multi: MultiConfig;
  providerCfg: ProviderConfig;
  providerCache: ProviderCache;
  cache: UsageCache;
  dryRun: boolean;
  now: Date;
}

function tickOne({
  id,
  multi,
  providerCfg,
  providerCache,
  cache,
  dryRun,
  now,
}: TickOneArgs): ProviderTickResult {
  const provider = getProvider(id);
  const ctx = { cfg: providerCfg, shared: multi.shared, now };

  // Live probe; fall back to the cache-derived snapshot on failure.
  let usage: ProviderUsage | null = null;
  let probed = false;
  try {
    const probedUsage = provider.probe(ctx);
    usage = probedUsage ?? null;
    probed = !!usage;
  } catch {
    usage = null;
  }
  if (!usage) usage = provider.inferFromCache(ctx, providerCache);
  // Inject the per-provider cache signals decide() needs: lastWarmAt and the
  // opencode cooldown stamp. This is the bridge between the cache layer and
  // the provider's pure decide() function.
  const enriched: ProviderUsage & { lastWarmAt?: number; cooldownUntil?: number } = {
    ...usage,
    ...(providerCache.lastWarmAt ? { lastWarmAt: providerCache.lastWarmAt } : {}),
    ...(providerCache.cooldownUntil ? { cooldownUntil: providerCache.cooldownUntil } : {}),
  };
  const decision = decideForMode(provider, ctx, enriched);

  // Persist the decision + whatever we learned, regardless of whether we arm.
  const next: ProviderCache = {
    ...providerCache,
    lastDecision: { ...decision, at: now.toISOString() },
  };
  if (probed) {
    next.capturedAt = usage.capturedAt;
    next.session = usage.session;
    next.week = usage.week;
    if (usage.weekSonnet) next.weekSonnet = usage.weekSonnet;
  }
  cache.providers[id] = next;

  let status = 0;
  if (decision.action === 'warm' && !dryRun) {
    status = runNow(id);
    if (provider.recordArmResult) {
      const recorded = provider.recordArmResult(ctx, next, status);
      Object.assign(next, recorded.cache);
      if (recorded.log) appendLog(now, `TICK [${id}] ${recorded.log}`);
    } else if (status === 0) {
      next.lastWarmAt = now.getTime();
    }
  }
  writeCache(cache);

  const src = probed ? 'probe' : usage.inferred ? 'cache' : 'injected';
  appendLog(
    now,
    `TICK [${id}] ${decision.action}${dryRun ? ' (dry-run)' : ''} — ${decision.reason} [via ${src}]`,
  );

  return { id, decision, status, usage, probed };
}

export function decideForMode(
  provider: Provider,
  ctx: ProbeContext,
  usage: ProviderUsage | null,
): Decision {
  if (ctx.shared.mode === 'smart') return provider.decide(ctx, usage);
  const hour = ctx.now.getHours();
  return ctx.cfg.schedule.includes(hour)
    ? { action: 'warm', reason: `scheduled for ${String(hour).padStart(2, '0')}:00` }
    : { action: 'skip-schedule', reason: 'not scheduled at this hour' };
}
