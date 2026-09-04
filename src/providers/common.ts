import { addMilliseconds, differenceInMilliseconds, formatClock } from '../time.js';
import type { Decision, ProviderCache, ProviderUsage } from '../types.js';
import type { ProbeContext } from './types.js';

export const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 60 * 1000;

export function inferWindowFromCache(
  ctx: ProbeContext,
  cache: ProviderCache | null,
  windowMs = DEFAULT_WINDOW_MS,
): ProviderUsage {
  const last = cache?.lastWarmAt;
  const active = last != null && differenceInMilliseconds(ctx.now, last) < windowMs;
  return {
    inferred: true,
    session: {
      pct: active ? 1 : 0,
      resetsAt: active && last != null ? addMilliseconds(last, windowMs) : null,
      active,
    },
    week: cache?.week ?? null,
  };
}

export function decideWindow(ctx: ProbeContext, usage: ProviderUsage | null): Decision {
  const { workStart, workEnd, weeklyStopPercent } = ctx.cfg;
  const hour = ctx.now.getHours();
  if (hour < workStart || hour >= workEnd) {
    return { action: 'skip-offhours', reason: `outside working hours ${workStart}-${workEnd}` };
  }
  const weekPct = usage?.week?.pct;
  if (weekPct != null && Number.isFinite(weekPct) && weekPct >= weeklyStopPercent) {
    return { action: 'skip-weekly', reason: `weekly ${weekPct}% >= ${weeklyStopPercent}%` };
  }
  const cooldownUntil = (usage as { cooldownUntil?: number } | null)?.cooldownUntil;
  if (cooldownUntil != null && cooldownUntil > ctx.now.getTime()) {
    const remaining = Math.ceil((cooldownUntil - ctx.now.getTime()) / 60_000);
    return { action: 'skip-active', reason: `cooldown (${remaining}m remaining)` };
  }
  if (usage?.session?.active) {
    return {
      action: 'skip-active',
      reason: usage.inferred
        ? 'window likely active (cache-derived)'
        : `window active until ${formatClock(usage.session.resetsAt, '?')}`,
    };
  }
  return {
    action: 'warm',
    reason: usage?.inferred ? 'no recent warmup (usage estimated)' : 'no active window',
  };
}

export function recordArmWithCooldown(
  cache: ProviderCache,
  status: number,
  now: Date,
): { cache: ProviderCache; log?: string } {
  if (status === 0) {
    const next = { ...cache, lastWarmAt: now.getTime() };
    delete next.cooldownUntil;
    delete next.lastFailureAt;
    return { cache: next };
  }
  const lastFailureAt = cache.lastFailureAt ?? 0;
  if (lastFailureAt > 0 && now.getTime() - lastFailureAt < FAILURE_WINDOW_MS) {
    const next = { ...cache, cooldownUntil: now.getTime() + COOLDOWN_MS };
    delete next.lastFailureAt;
    return {
      cache: next,
      log: 'cooldown set (1h after 2 failures in 30m)',
    };
  }
  return { cache: { ...cache, lastFailureAt: now.getTime() } };
}
