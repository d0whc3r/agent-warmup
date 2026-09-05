import { FIVE_HOURS_MS, addMilliseconds, differenceInMilliseconds, formatClock } from '../time.js';
import type { Decision, ProviderCache, ProviderUsage } from '../types.js';
import type { ProbeContext } from './types.js';

// Two failures inside this window trip the breaker. Wider than the slowest tick
// cadence (60m) so two consecutive failing ticks always count as a pair; at 30m it
// was a coin flip whether a 30m-cadence tick landed inside or just outside it.
const FAILURE_WINDOW_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 60 * 1000;

// The shared cache-based fallback: a warmup inside the last five hours counts as an
// active session. Takes a bare `now` so the Claude provider -- which has its own
// signature and deliberately drops the weekly figure -- can reuse it too.
export function inferWindow(now: Date, cache: ProviderCache | null): ProviderUsage {
  const last = cache?.lastWarmAt;
  const active = last != null && differenceInMilliseconds(now, last) < FIVE_HOURS_MS;
  return {
    inferred: true,
    session: {
      pct: active ? 1 : 0,
      resetsAt: active && last != null ? addMilliseconds(last, FIVE_HOURS_MS) : null,
      active,
    },
    week: cache?.week ?? null,
  };
}

export const inferWindowFromCache = (ctx: ProbeContext, cache: ProviderCache | null) =>
  inferWindow(ctx.now, cache);

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
  // A probe read from a log file (codex) can predate our own last arm; the arm
  // we did is the freshest signal, so honor it before the probe's session flag.
  const lastWarmAt = (usage as { lastWarmAt?: number } | null)?.lastWarmAt ?? 0;
  if (lastWarmAt > 0 && differenceInMilliseconds(ctx.now, lastWarmAt) < FIVE_HOURS_MS) {
    return { action: 'skip-active', reason: 'window likely active (cache-derived)' };
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
      log: 'cooldown set (1h after 2 failures in 2h)',
    };
  }
  return { cache: { ...cache, lastFailureAt: now.getTime() } };
}
