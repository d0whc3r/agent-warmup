// One tick: probe every enabled provider, decide whether to arm, and arm when
// warranted. Providers are independent (own cache entry, own work band, own
// window), so they are ticked concurrently: Claude's ~20s probe and ~45s arm no
// longer hold up codex/kimi/zai, and a provider that fails or hangs only affects
// its own result. The scheduler runs this every `tickMinutes` (smart mode) or per
// fixed-hour (fixed mode).
//
// This module is the single orchestrator for the multi-provider design in
// docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md. The
// provider-specific logic lives in src/providers/<id>.ts; this file only
// handles the cross-cutting concerns (cache, log lines, exit status).
import { readCache, updateProviderCache } from './cache.js';
import { loadConfig } from './config.js';
import { appendLog, pruneLogs } from './logs.js';
import { getProvider } from './providers/index.js';
import type { ProbeContext, Provider } from './providers/types.js';
import { runNow } from './runner.js';
import type { Decision, MultiConfig, ProviderCache, ProviderId, ProviderUsage } from './types.js';

interface ProviderTickResult {
  id: ProviderId;
  decision: Decision;
  status: number;
  usage: ProviderUsage | null;
  probed: boolean;
}

export interface TickResult {
  results: ProviderTickResult[];
  dryRun: boolean;
}

export { readCache, writeCache } from './cache.js';

// probe -> decide -> maybe arm, for every enabled provider at once.
export async function runTick({
  dryRun = false,
  now = new Date(),
  providerId,
}: { dryRun?: boolean; now?: Date; providerId?: ProviderId } = {}): Promise<TickResult> {
  const multi = loadConfig();
  const ids = (providerId ? [providerId] : multi.shared.providers).filter(
    (id) => multi.providers[id]?.enabled,
  );
  const results = await Promise.all(ids.map((id) => tickOne(id, multi, dryRun, now)));
  pruneLogs(now);
  return { results, dryRun };
}

async function tickOne(
  id: ProviderId,
  multi: MultiConfig,
  dryRun: boolean,
  now: Date,
): Promise<ProviderTickResult> {
  const provider = getProvider(id);
  const providerCache = readCache().providers[id] ?? {};
  const ctx: ProbeContext = { cfg: multi.providers[id]!, shared: multi.shared, now };

  // Live probe; fall back to the cache-derived snapshot on failure.
  let usage: ProviderUsage | null = null;
  let probed = false;
  try {
    usage = (await provider.probe(ctx)) ?? null;
    probed = !!usage;
  } catch {
    usage = null;
  }
  const snapshot: ProviderUsage = usage ?? provider.inferFromCache(ctx, providerCache);
  // Inject the per-provider cache signals decide() needs: lastWarmAt and the
  // opencode cooldown stamp. This is the bridge between the cache layer and
  // the provider's pure decide() function.
  const enriched: ProviderUsage & { lastWarmAt?: number; cooldownUntil?: number } = {
    ...snapshot,
    ...(providerCache.lastWarmAt ? { lastWarmAt: providerCache.lastWarmAt } : {}),
    ...(providerCache.cooldownUntil ? { cooldownUntil: providerCache.cooldownUntil } : {}),
  };
  const decision = decideForMode(provider, ctx, enriched);

  // Persist the decision + whatever we learned, regardless of whether we arm.
  updateProviderCache(id, (entry) => {
    const next: ProviderCache = { ...entry, lastDecision: { ...decision, at: now.toISOString() } };
    if (probed) {
      next.capturedAt = snapshot.capturedAt;
      next.session = snapshot.session;
      next.week = snapshot.week;
      if (snapshot.weekModel) next.weekModel = snapshot.weekModel;
    }
    return next;
  });

  // Logged before arming so the decision precedes the arm script's own
  // START/OK/DONE lines for this provider in warmup.log.
  const src = probed ? 'probe' : snapshot.inferred ? 'cache' : 'injected';
  appendLog(
    now,
    `TICK [${id}] ${decision.action}${dryRun ? ' (dry-run)' : ''} — ${decision.reason} [via ${src}]`,
  );

  const status = decision.action === 'warm' && !dryRun ? await runNow(id, now) : 0;
  return { id, decision, status, usage: snapshot, probed };
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
