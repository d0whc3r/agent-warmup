// src/providers/claude.ts -- the Claude Code provider. Wraps the existing parseUsage
// + decide + arm-claude.sh body. No behavior change for users who only have claude.
// The legacy usage.ts/decide.ts code is inlined here per spec section 11/12; their
// tests import from this module via the same exported names.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ARM_SCRIPT, ARM_SCRIPT_SRC, CLAUDE_BIN, TMUX_BIN, WARMUP_WORKDIR } from '../paths.js';
import {
  FIVE_HOURS_MS,
  parseReset,
  formatClock,
  formatShortDate,
  minutesSince,
  addMilliseconds,
  differenceInMilliseconds,
  isAfter,
} from '../time.js';

import type { Decision, LimitBlock, ProviderCache, ProviderUsage } from '../types.js';
import type { ProbeContext, Provider } from './types.js';

const wait = (sec: number) => spawnSync('sleep', [String(sec)]);
const tmux = (args: string[]) => spawnSync(TMUX_BIN, args, { encoding: 'utf8' });

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Pure parser -- exposed for the unit tests (test/parse-usage.test.ts).
export function parseUsage(text: string, now: Date = new Date()): ProviderUsage {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim());
  const block = (label: string): LimitBlock | null => {
    const i = lines.indexOf(label);
    if (i < 0) return null;
    const win = lines.slice(i + 1, i + 5).join('\n');
    const pctM = win.match(/(\d+)%\s*used/);
    const resM = win.match(/Resets\s+(.+?)\s*(?:\(|$)/m);
    return {
      pct: pctM ? Number(pctM[1]) : null,
      resetsAt: resM ? parseReset(resM[1], now) : null,
    };
  };
  const session = block('Current session');
  const week = block('Current week (all models)');
  const weekSonnet = block('Current week (Sonnet only)');
  if (session) {
    session.active = (session.pct ?? 0) > 0 && !!session.resetsAt && isAfter(session.resetsAt, now);
  }
  return { session, week, weekSonnet };
}

// Read Claude's three limit blocks by driving `/usage` in a throwaway tmux session
// and parsing the rendered pane. Returns null on any failure.
export function probe(ctx: ProbeContext): ProviderUsage | null {
  if (!isExecutable(CLAUDE_BIN) || !isExecutable(TMUX_BIN)) return null;
  const session = `${ctx.cfg.tmuxSession}-usage`;
  const readyWait = Number(process.env.WARMUP_READY_WAIT || 12);
  const responseWait = Number(process.env.WARMUP_RESPONSE_WAIT || 6);
  try {
    tmux(['kill-session', '-t', session]);
    fs.mkdirSync(WARMUP_WORKDIR, { recursive: true });
    const started = tmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      '220',
      '-y',
      '55',
      '-c',
      WARMUP_WORKDIR,
      CLAUDE_BIN,
      '--safe-mode',
      '--model',
      ctx.cfg.model,
    ]);
    if (started.status !== 0) return null;
    wait(readyWait);
    const pane = () => tmux(['capture-pane', '-p', '-t', session]).stdout || '';
    if (/trust this folder|do you trust|project you (created|trust)/i.test(pane())) {
      tmux(['send-keys', '-t', session, '1']);
      tmux(['send-keys', '-t', session, 'Enter']);
      wait(4);
    }
    tmux(['send-keys', '-t', session, '-l', '/usage']);
    wait(1);
    tmux(['send-keys', '-t', session, 'Enter']);
    wait(responseWait);
    const text = tmux(['capture-pane', '-p', '-t', session, '-S', '-200']).stdout || '';
    const usage = parseUsage(text, ctx.now);
    if (!usage.session && !usage.week) return null;
    return { ...usage, capturedAt: ctx.now.getTime() };
  } finally {
    tmux(['send-keys', '-t', session, 'Escape']);
    tmux(['kill-session', '-t', session]);
  }
}

// Pure decision (legacy `decide()` body inlined; same unit tests in test/decide.test.ts).
export function decide(ctx: ProbeContext, usage: ProviderUsage | null): Decision {
  const { workStart, workEnd, weeklyStopPercent } = ctx.cfg;
  const hour = ctx.now.getHours();
  if (hour < workStart || hour >= workEnd) {
    return { action: 'skip-offhours', reason: `outside working hours ${workStart}-${workEnd}` };
  }
  const weekPct = usage?.week?.pct;
  if (weekPct != null && Number.isFinite(weekPct) && weekPct >= weeklyStopPercent) {
    return { action: 'skip-weekly', reason: `weekly ${weekPct}% >= ${weeklyStopPercent}%` };
  }
  if (usage?.session?.active) {
    return {
      action: 'skip-active',
      reason: `window active until ${formatClock(usage.session.resetsAt, '?')}`,
    };
  }
  return {
    action: 'warm',
    reason: usage?.inferred ? 'no recent warmup (probe failed)' : 'no active window',
  };
}

// Display helpers (re-exposed for backward-compat with print-status and the UI).
export function formatUsage(cache: ProviderCache | null | undefined): {
  session: string;
  week: string;
  ageMin: number | null;
  lastDecision?: Decision & { at: string };
} | null {
  if (!cache || (!cache.session && !cache.week)) return null;
  const s = cache.session;
  const w = cache.week;
  const session = s
    ? `${s.pct ?? '—'}%${s.active ? '' : ' (idle)'}${s.resetsAt ? ` · resets ${formatClock(s.resetsAt)}` : ''}`
    : '—';
  const week = w
    ? `${w.pct ?? '—'}%${w.resetsAt ? ` · resets ${formatShortDate(w.resetsAt)}` : ''}`
    : '—';
  return {
    session,
    week,
    ageMin: minutesSince(cache.capturedAt),
    ...(cache.lastDecision ? { lastDecision: cache.lastDecision } : {}),
  };
}

// Cache-based fallback (used when the live probe fails). Same semantics as the
// legacy `inferFromCache` in usage.ts: a warmup within the last 5h counts as an
// active window.
export function inferFromCache(now: Date, cache: ProviderCache | null): ProviderUsage {
  const last = cache?.lastWarmAt;
  const active = last != null && differenceInMilliseconds(now, last) < FIVE_HOURS_MS;
  return {
    inferred: true,
    session: {
      pct: active ? 1 : 0,
      resetsAt: active && last != null ? addMilliseconds(last, FIVE_HOURS_MS) : null,
      active,
    },
    week: null,
  };
}

// The arm script body for Claude Code. Read all its config from env so the
// CLI can drive it headlessly (passing WARMUP_MODEL, WARMUP_TMUX_SESSION, etc).
// The arm script lives in src/assets/arm-claude.sh so the linter (and editors)
// can see the bash content as bash, not as a JS template literal. At runtime the
// runner passes the right WARMUP_* env keys for the script to read.
export function armScript(): string {
  return fs.readFileSync(ARM_SCRIPT_SRC('claude'), 'utf8');
}

export const claudeProvider: Provider = {
  id: 'claude',
  probe,
  decide,
  armScript,
  armScriptPath: () => ARM_SCRIPT('claude'),
};
