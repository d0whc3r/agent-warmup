import { spawnSync } from 'node:child_process';
// src/providers/claude.ts -- the Claude Code provider. Wraps the existing parseUsage
// + decide + arm-claude.sh body. No behavior change for users who only have claude.
// The legacy usage.ts/decide.ts code is inlined here per spec section 11/12; their
// tests import from this module via the same exported names.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { ARM_SCRIPT, ARM_SCRIPT_SRC, TMUX_BIN, WARMUP_WORKDIR, expandHome } from '../paths.js';
import { parseReset, formatClock, formatShortDate, minutesSince, isAfter } from '../time.js';
import type {
  Decision,
  LimitBlock,
  ModelLimitBlock,
  ProviderCache,
  ProviderUsage,
} from '../types.js';
import { inferWindow } from './common.js';
import type { ProbeContext, Provider } from './types.js';

// "Current week (Fable)" -> "Fable". Only the per-model weekly heading has a
// parenthesised name; the all-models one is filtered out by value.
const MODEL_WEEK_HEADING = /^Current week \((.+)\)$/;

// Async on purpose: the tick probes all providers at once, and this probe sleeps
// ~20s driving the TUI, which must not block the others.
const wait = (sec: number) => sleep(sec * 1000);
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
  const blockAt = (i: number): LimitBlock | null => {
    if (i < 0) return null;
    const win = lines.slice(i + 1, i + 5).join('\n');
    const pctM = win.match(/(\d+)%\s*used/);
    const resM = win.match(/Resets\s+(.+?)\s*(?:\(|$)/m);
    return {
      pct: pctM ? Number(pctM[1]) : null,
      resetsAt: resM ? parseReset(resM[1], now) : null,
    };
  };
  const block = (label: string): LimitBlock | null => blockAt(lines.indexOf(label));
  const session = block('Current session');
  const week = block('Current week (all models)');

  // The second weekly heading names whichever model Claude caps separately, and that
  // name changes with the lineup ("Sonnet only" then, "Fable" now), so match the
  // shape and keep the heading rather than hard-coding one model.
  const modelWeekIdx = lines.findIndex(
    (l) => MODEL_WEEK_HEADING.test(l) && l !== 'Current week (all models)',
  );
  const modelBlock = blockAt(modelWeekIdx);
  const weekModel: ModelLimitBlock | null = modelBlock
    ? { ...modelBlock, label: MODEL_WEEK_HEADING.exec(lines[modelWeekIdx]!)![1]! }
    : null;

  if (session) {
    session.active = (session.pct ?? 0) > 0 && !!session.resetsAt && isAfter(session.resetsAt, now);
  }
  return { session, week, weekModel };
}

// Read Claude's three limit blocks by driving `/usage` in a throwaway tmux session
// and parsing the rendered pane. Returns null on any failure.
export async function probe(ctx: ProbeContext): Promise<ProviderUsage | null> {
  // Honor the per-provider binary path the user set in WARMUP_CLAUDE_BIN (the
  // legacy `CLAUDE_BIN` env var still works for the arm script's own fallback,
  // but the probe should always read the provider config so a custom install
  // location is respected here too).
  const binary = expandHome(ctx.cfg.binary);
  if (!isExecutable(binary) || !isExecutable(TMUX_BIN)) return null;
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
      binary,
      '--safe-mode',
      '--model',
      ctx.cfg.model,
    ]);
    if (started.status !== 0) return null;
    await wait(readyWait);
    const pane = () => tmux(['capture-pane', '-p', '-t', session]).stdout || '';
    const shown = pane();
    if (/trust this folder|do you trust|project you (created|trust)/i.test(shown)) {
      // Two layouts: the numbered list ("1. Yes, proceed") takes the digit; the
      // cursor list (Claude Code ≥ 2.1.2xx) highlights "No, exit" first, so Down
      // moves onto "Yes, I trust this folder" before Enter confirms.
      if (/Yes, I trust this folder/.test(shown)) tmux(['send-keys', '-t', session, 'Down']);
      else tmux(['send-keys', '-t', session, '1']);
      await wait(0.5);
      tmux(['send-keys', '-t', session, 'Enter']);
      await wait(4);
    }
    tmux(['send-keys', '-t', session, '-l', '/usage']);
    await wait(1);
    tmux(['send-keys', '-t', session, 'Enter']);
    await wait(responseWait);
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
  // Inferred snapshots carry no real percentage (pct is a 1/0 active flag), so
  // describe the estimated window instead of printing a number.
  const session = cache.inferred
    ? s?.active
      ? `active (estimated) · resets ${formatClock(s.resetsAt, '?')}`
      : 'idle (estimated)'
    : s
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
// active window. Claude's weekly figure only ever comes from a live `/usage` probe,
// never from the cache, so the inferred snapshot drops it.
export function inferFromCache(now: Date, cache: ProviderCache | null): ProviderUsage {
  return { ...inferWindow(now, cache), week: null };
}

// The arm script body for Claude Code. Read all its config from env so the
// CLI can drive it headlessly (passing WARMUP_MODEL, WARMUP_TMUX_SESSION, etc).
// The arm script lives in src/assets/arm-claude.sh so the linter (and editors)
// can see the bash content as bash, not as a JS template literal. At runtime the
// runner passes the right WARMUP_* env keys for the script to read.
function armScript(): string {
  return fs.readFileSync(ARM_SCRIPT_SRC('claude'), 'utf8');
}

export const claudeProvider: Provider = {
  id: 'claude',
  name: 'Claude Code',
  modelChoices: ['haiku', 'sonnet', 'opus'],
  probeKind: 'live',
  probe,
  inferFromCache: (ctx, cache) => inferFromCache(ctx.now, cache),
  decide,
  armScript,
  armScriptPath: () => ARM_SCRIPT('claude'),
  armEnv: (ctx) => ({ CLAUDE_BIN: ctx.cfg.binary, WARMUP_PROVIDER_NAME: 'Claude Code' }),
};
