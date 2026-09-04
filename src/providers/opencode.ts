// src/providers/opencode.ts -- the OpenCode Go provider. Probe = `opencode stats`
// (built-in) for weekly; session-active is not queryable, falls back to the cache
// (see spec A-4 + the circuit-breaker in decide()).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ARM_SCRIPT, ARM_SCRIPT_SRC, expandHome } from '../paths.js';
import { differenceInMilliseconds } from '../time.js';

import type { Decision, ProviderCache, ProviderUsage } from '../types.js';
import type { ProbeContext, Provider } from './types.js';
import { inferWindowFromCache, recordArmWithCooldown } from './common.js';

const GO_WEEKLY_USD = 30; // 30 USD per week
const FAIL_WINDOW_MS = 30 * 60 * 1000; // 30 min
const COOLDOWN_MS = 60 * 60 * 1000; // 1h
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function isExecutable(p: string): boolean {
  try {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8' });
    return r.status === 0 || r.status === 1; // any runnable
  } catch {
    return false;
  }
}

// Cheap percent parser for `opencode stats --models 1` lines like
// "  deepseek-v4-flash      1,234 in / 567 out   $0.12".
// Returns USD spent on the matching model line, or null if not found.
// Exported so the regression test in test/opencode.test.ts can lock the
// $X.YY / USD X.YY detection in (the original bug: the first regex had an
// unescaped `$`, which JS reads as end-of-string, so $0.12 never matched).
export function parseStatsCost(text: string, model: string): number | null {
  // The model id from WARMUP_OPENCODE_MODEL may be "opencode-go/deepseek-v4-flash"
  // or just "deepseek-v4-flash"; we match the tail.
  const needle = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.includes(needle)) continue;
    // Heuristic: a dollar amount somewhere on the line. opencode stats is still
    // settling its format (v1.17.7+); accept either "$0.12" or "USD 0.12".
    const m =
      line.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/) || line.match(/USD\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// Probe by parsing `opencode stats --days 7` (built-in) and pulling the running
// model's USD cost. Returns null if opencode isn't on PATH. On a fresh install
// with no recorded usage, returns a "no usage yet" snapshot so the cache-based
// fallback (lastWarmAt < 5h ago) drives the decision.
export function probe(ctx: ProbeContext): ProviderUsage | null {
  const binary = expandHome(ctx.cfg.binary);
  if (!isExecutable(binary)) return null;
  const r = spawnSync(binary, ['stats', '--days', '7', '--models', '1'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  const text = (r.stdout || '') + (r.stderr || '');
  const cost = parseStatsCost(text, ctx.cfg.model);
  if (cost == null) {
    // First-day / first-run: no usage recorded. Let inferFromCache decide.
    return { session: null, week: null, capturedAt: ctx.now.getTime(), inferred: true };
  }
  // Map the dollar spend to the weekly $30 cap; the 5h session-active is
  // unknowable from the CLI (issue #19190 in flight), so leave it null and let
  // inferFromCache handle it.
  const weekPct = Math.min(100, Math.round((cost / GO_WEEKLY_USD) * 100));
  return {
    session: null, // see A-4 -- actively unknown
    week: { pct: weekPct, resetsAt: null },
    capturedAt: ctx.now.getTime(),
  };
}

// Pure decision. The "active window" check is cache-based (the 5h $12 cap isn't
// queryable today; see spec A-4). The tick injects `cache.lastWarmAt` into the
// usage object before calling decide, so we can read it here.
function decide(ctx: ProbeContext, usage: ProviderUsage | null): Decision {
  const { workStart, workEnd, weeklyStopPercent } = ctx.cfg;
  const hour = ctx.now.getHours();
  if (hour < workStart || hour >= workEnd) {
    return { action: 'skip-offhours', reason: `outside working hours ${workStart}-${workEnd}` };
  }
  const weekPct = usage?.week?.pct;
  if (weekPct != null && Number.isFinite(weekPct) && weekPct >= weeklyStopPercent) {
    return { action: 'skip-weekly', reason: `weekly ${weekPct}% >= ${weeklyStopPercent}%` };
  }
  // Cooldown from the circuit breaker: if a recent arm failed twice in 30 min,
  // the tick sets cooldownUntil to now+1h. Honor that here.
  const lastWarm = (usage as { lastWarmAt?: number } | null)?.lastWarmAt ?? 0;
  const u = usage as unknown as { cooldownUntil?: number };
  if (u && typeof u.cooldownUntil === 'number') {
    const until = u.cooldownUntil;
    if (until > ctx.now.getTime()) {
      const remaining = Math.ceil((until - ctx.now.getTime()) / 60_000);
      return { action: 'skip-active', reason: `cooldown (${remaining}m remaining)` };
    }
  }
  if (lastWarm > 0 && differenceInMilliseconds(ctx.now, lastWarm) < FIVE_HOURS_MS) {
    return { action: 'skip-active', reason: 'window likely active (cache-derived)' };
  }
  return { action: 'warm', reason: 'no active window probe available' };
}

// The arm script body for OpenCode. Spawns `opencode run` in a tmux session,
// reads the prompt reply, and exits. No `--safe-mode` (that's a Claude flag).
// Reads all its config from env so the CLI can drive it headlessly.
// The arm script lives in src/assets/arm-opencode.sh; see the comment in
// claude.ts for why we keep bash out of JS template literals.
function armScript(): string {
  return fs.readFileSync(ARM_SCRIPT_SRC('opencode'), 'utf8');
}

// Circuit-breaker: when 2 consecutive arm failures happen within 30 min, set a
// 1h cooldown on the provider. The next decide() consults `cooldownUntil` and
// returns skip-active. Cooldown is cleared on the next successful arm (the tick
// calls `clearCooldown` after a 0-status runProvider).
export function onArmFailure(
  cache: ProviderCache | null,
  now: number = Date.now(),
): { next: ProviderCache; escalated: boolean } {
  const last = cache?.cooldownUntil ?? 0;
  // If we already failed within the 30-min window, escalate to 1h cooldown from now.
  if (last > 0 && now - last < FAIL_WINDOW_MS) {
    return { next: { ...cache, cooldownUntil: now + COOLDOWN_MS }, escalated: true };
  }
  // First failure in a while: set a stamp; the next failure within 30 min
  // escalates. (cooldownUntil doubles as the "last failure" stamp when not
  // escalated; decide() only honors it when it's in the future.)
  return { next: { ...cache, cooldownUntil: now }, escalated: false };
}

// Clear any cooldown on a successful arm.
export function clearCooldown(cache: ProviderCache | null): ProviderCache {
  if (!cache?.cooldownUntil) return cache ?? {};
  const next = { ...cache };
  delete next.cooldownUntil;
  return next;
}

export const opencodeProvider: Provider = {
  id: 'opencode',
  name: 'OpenCode Go',
  modelChoices: [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/glm-5.3-flash',
    'opencode-go/kimi-k2.7-code',
  ],
  probeKind: 'live',
  probe,
  inferFromCache: inferWindowFromCache,
  decide,
  armScript,
  armScriptPath: () => ARM_SCRIPT('opencode'),
  armEnv: (ctx) => ({
    OPENCODE_BIN: ctx.cfg.binary,
    WARMUP_PROVIDER: 'opencode',
    WARMUP_PROVIDER_NAME: 'OpenCode Go',
  }),
  onArmFailure: (ctx, err) => {
    // The tick reads/writes the per-provider cache itself; this hook is here
    // for future in-process state (e.g. metrics) -- kept as a no-op for now.
    void ctx;
    void err;
  },
  recordArmResult: (ctx, cache, status) => recordArmWithCooldown(cache, status, ctx.now),
};
