import { spawnSync } from 'node:child_process';
// src/providers/opencode.ts -- the OpenCode Go provider. Probe = `opencode stats`
// (built-in) for weekly; session-active is not queryable, falls back to the cache
// (see spec A-4 + the circuit-breaker in decide()).
import fs from 'node:fs';

import { ARM_SCRIPT, ARM_SCRIPT_SRC, expandHome } from '../paths.js';
import { differenceInMilliseconds } from '../time.js';
import type { Decision, ProviderUsage } from '../types.js';
import { inferWindowFromCache, recordArmWithCooldown } from './common.js';
import type { ProbeContext, Provider } from './types.js';

const GO_WEEKLY_USD = 30; // 30 USD per week
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
// A model block in the boxed layout is Messages / Input / Output / Cache Read /
// Cache Write / Cost — six rows. Ten keeps a row or two of slack without ever
// reaching the *next* model's Cost row.
const COST_ROW_LOOKAHEAD = 10;

// A dollar figure anywhere on a line. opencode stats keeps moving its format, so
// accept "$0.12", "USD 0.12" and thousands separators alike.
function parseAmount(line: string): number | null {
  const m =
    line.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/) ||
    line.match(/USD\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

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
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(needle)) continue;
    // Flat layout (opencode <= 1.17): "model  1,234 in / 567 out   $0.12".
    const inline = parseAmount(lines[i]!);
    if (inline != null) return inline;
    // Boxed layout (opencode >= 1.18): the model heads a block of label/value rows
    // and its spend sits on the "Cost" row a few lines down.
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + COST_ROW_LOOKAHEAD); j++) {
      if (!/\bCost\b/i.test(lines[j]!)) continue;
      const cost = parseAmount(lines[j]!);
      if (cost != null) return cost;
    }
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

export const opencodeProvider: Provider = {
  id: 'opencode',
  name: 'OpenCode Go',
  modelChoices: [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/glm-5.3-flash',
    'opencode-go/kimi-k2.7-code',
  ],
  probeKind: 'live',
  credentialKey: 'opencode-go',
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
  recordArmResult: (ctx, cache, status) => recordArmWithCooldown(cache, status, ctx.now),
};
