# Multi-provider warmup Implementation Plan (superseded)

> Superseded by `../specs/2026-09-04-agent-warmup-scope.md` and the provider-neutral implementation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `claude-warmup` so it keeps two independent usage windows warm (Claude Code + opencode) from a single CLI, scheduler, status, and log set, with per-provider cadence and per-provider usage cache, while keeping 100% behavior parity for users who only enable the `claude` provider.

**Architecture:** New `Provider` interface under `src/providers/<id>.ts`. A `Provider` owns its binary/model/session/probe-decide-arm quadruple. The CLI, scheduler, log dir, and TUI stay shared. Config is rewritten as a `WARMUP_PROVIDERS=claude,opencode` list with `WARMUP_<ID>_*` stanzas. `usage-cache.json` becomes a per-provider map. Migration is one-way and silent (old shape wrapped as `{claude: <old>}` on first read; first `saveConfig` writes `.bak`).

**Tech Stack:** Node 24 + TypeScript 6, tsx + tsdown, Ink 7 + React 19, node:test, launchd (macOS) / cron (Linux), bash for arm scripts, Node SEA for single-binary builds.

**Spec:** `docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md`

**Pre-flight:** Before any task, complete the A-4 spike in Phase 0. Everything in Phase 5+ depends on its output.

---

## Phase 0 — Pre-flight: opencode usage probe spike

### Task 0: Discover how opencode exposes usage

**Files:** none (read-only investigation).

**Outcome:** A short note in `docs/superpowers/specs/2026-06-15-opencode-spike.md` that records:

- the exact command(s) tried to read opencode's usage (slash command, CLI subcommand, state-file read),
- the rendered output (paste the raw pane),
- which fields map to `{ session, week, weekSonnet }`,
- the arm-command shape (does opencode have a `--safe-mode` equivalent? what flags control model?).

- [ ] **Step 1: Open a real tmux session against `opencode`**

```bash
TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.local/bin/opencode}"
"$TMUX_BIN" kill-session -t opencode-spike 2>/dev/null || true
"$TMUX_BIN" new-session -d -s opencode-spike -x 220 -y 50 \
  -c "$HOME/.claude/warmup/workdir" \
  "$OPENCODE_BIN"
sleep 8
```

- [ ] **Step 2: Try the most plausible usage command(s)**

The engineer should try, in this order, recording the rendered output for each:

```bash
# Slash command inside the running opencode session:
"$TMUX_BIN" send-keys -t opencode-spike -l '/usage'
"$TMUX_BIN" send-keys -t opencode-spike Enter
sleep 4
"$TMUX_BIN" capture-pane -p -t opencode-spike -S -200
```

If `/usage` is not recognized, try the opencode CLI outside the TUI:

```bash
"$OPENCODE_BIN" usage 2>&1 | tee /tmp/opencode-usage.txt
"$OPENCODE_BIN" --help 2>&1 | head -40
```

- [ ] **Step 3: Identify the arm flag**

```bash
"$OPENCODE_BIN" --help 2>&1 | grep -iE 'safe|model|headless|non.interactive'
```

- [ ] **Step 4: Write the spike note**

Create `docs/superpowers/specs/2026-06-15-opencode-spike.md` with the recorded outputs, the chosen probe command, and the chosen arm command. This file gates Phase 5.

- [ ] **Step 5: Tear down the tmux session**

```bash
"$TMUX_BIN" send-keys -t opencode-spike -l '/exit'
"$TMUX_BIN" send-keys -t opencode-spike Enter
sleep 2
"$TMUX_BIN" kill-session -t opencode-spike 2>/dev/null || true
```

---

## Phase 1 — Foundation: Provider types and registry

### Task 1: Define the `Provider` interface

**Files:**

- Create: `src/providers/types.ts`

- [ ] **Step 1: Write the file**

```ts
// src/providers/types.ts
// The seam between the multi-provider orchestration and a single backend
// (claude, opencode, …). The CLI, scheduler, log dir, and TUI live above
// this interface; everything that varies per backend lives behind it.

export type ProviderId = 'claude' | 'opencode';

/** Block shape shared by all backends (session, week, weekSonnet, …). */
export interface LimitBlock {
  pct: number | null;
  active?: boolean;
  resetsAt?: Date | null;
}

/** Per-provider tunables (parsed from WARMUP_<ID>_* keys). */
export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  binary: string;
  model: string;
  tmuxSession: string;
  /** Resolved at runtime; defaults to ~/.claude/warmup/arm-<id>.sh. */
  armScriptPath: string;
  workStart: number;
  workEnd: number;
  weeklyStopPercent: number;
  schedule: number[]; // empty in smart mode
  /** Provider-specific knobs. For claude: {}. For opencode: filled by the spike. */
  extra: Record<string, unknown>;
}

/** Per-provider usage snapshot. Mirrors UsageSnapshot from src/types.ts. */
export interface ProviderUsage {
  session: LimitBlock | null;
  week: LimitBlock | null;
  capturedAt?: number;
  inferred?: boolean;
  [k: string]: unknown;
}

export type DecisionAction = 'warm' | 'skip-offhours' | 'skip-weekly' | 'skip-active';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

/** Shared top-level config passed to each provider's loadConfig. */
export interface SharedConfig {
  mode: 'smart' | 'fixed';
  tickMinutes: number;
  scheduler: 'launchd' | 'cron';
}

/** What every provider must expose. */
export interface Provider {
  id: ProviderId;
  /** Parse WARMUP_<ID>_* keys (plus the shared top-level defaults). */
  loadConfig(env: Record<string, string>, shared: SharedConfig): ProviderConfig;
  /** Read current usage from the running CLI. Returns null on failure. */
  probe(cfg: ProviderConfig, now: Date): ProviderUsage | null;
  /** Pure decision: given the usage and the config, decide warm or skip. */
  decide(cfg: ProviderConfig, usage: ProviderUsage | null, now: Date): Decision;
  /** The shell script that arms a usage window for this provider. */
  armScript(): string;
  /** Where the script gets materialized for this provider. */
  armScriptPath(): string;
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm run typecheck
```

Expected: PASS (no consumers yet, file is standalone).

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat(providers): add Provider interface and shared types"
```

### Task 2: Provider registry

**Files:**

- Create: `src/providers/index.ts`
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, listProviderIds } from '../src/providers/index.js';

test('registry exposes claude and opencode', () => {
  const ids = listProviderIds();
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('opencode'));
});

test('getProvider returns a provider with the expected id', () => {
  for (const id of listProviderIds()) {
    const p = getProvider(id);
    assert.equal(p.id, id);
  }
});

test('getProvider throws for unknown ids', () => {
  assert.throws(() => getProvider('not-a-real-provider' as never), /unknown provider/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- --test-name-pattern='registry'
```

Expected: FAIL — `Cannot find module '../src/providers/index.js'`.

- [ ] **Step 3: Implement the registry (with provider stubs)**

```ts
// src/providers/index.ts
import type { Provider, ProviderId } from './types.js';
import { claude } from './claude.js';
import { opencode } from './opencode.js';

const providers: Record<ProviderId, Provider> = { claude, opencode };

export function getProvider(id: ProviderId): Provider {
  const p = providers[id];
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export function listProviderIds(): ProviderId[] {
  return Object.keys(providers) as ProviderId[];
}
```

```ts
// src/providers/claude.ts (stub — filled in Phase 2)
import type { Provider } from './types.js';
export const claude: Provider = {
  id: 'claude',
  loadConfig: () => {
    throw new Error('not implemented');
  },
  probe: () => null,
  decide: () => ({ action: 'skip-offhours', reason: 'stub' }),
  armScript: () => '',
  armScriptPath: () => '',
};
```

```ts
// src/providers/opencode.ts (stub — filled in Phase 5)
import type { Provider } from './types.js';
export const opencode: Provider = {
  id: 'opencode',
  loadConfig: () => {
    throw new Error('not implemented');
  },
  probe: () => null,
  decide: () => ({ action: 'skip-offhours', reason: 'stub' }),
  armScript: () => '',
  armScriptPath: () => '',
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test -- --test-name-pattern='registry'
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/index.ts src/providers/claude.ts src/providers/opencode.ts test/registry.test.ts
git commit -m "feat(providers): add registry with claude + opencode stubs"
```

---

## Phase 2 — Move claude logic into `src/providers/claude/`

### Task 3: Move `parseUsage` to `claude/probe.ts`

**Files:**

- Create: `src/providers/claude/probe.ts`
- Create: `src/providers/claude/probe.test.ts` (moved from `test/parse-usage.test.ts`)
- Delete: `test/parse-usage.test.ts` (after move)
- Modify: `src/providers/claude.ts` (call into the new probe)

- [ ] **Step 1: Move the parser test**

```bash
git mv test/parse-usage.test.ts src/providers/claude/probe.test.ts
```

Edit `src/providers/claude/probe.test.ts`: change the import path

```ts
// from:
import { parseUsage, formatUsage, inferFromCache } from '../src/usage.js';
// to:
import { parseUsage, formatUsage, inferFromCache } from './probe.js';
```

(Leave the rest of the test file untouched.)

- [ ] **Step 2: Run test to verify it fails on the new path**

```bash
pnpm test -- src/providers/claude/probe.test.ts
```

Expected: FAIL — `Cannot find module './probe.js'`.

- [ ] **Step 3: Move the parser (without the tmux-driving probe)**

```ts
// src/providers/claude/probe.ts
// Pure /usage pane parser + cache helpers, plus the tmux-driving probe. The
// non-tmux parts are pure so they can be unit-tested without a real Claude
// install; the tmux probe is exercised by integration / smoke tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FIVE_HOURS_MS,
  parseReset,
  formatClock,
  formatShortDate,
  minutesSince,
  addMilliseconds,
  differenceInMilliseconds,
  isAfter,
} from '../../time.js';
import { CLAUDE_BIN, TMUX_BIN, WARMUP_WORKDIR, USAGE_CACHE } from '../../paths.js';
import type { Config, LimitBlock, UsageCache, UsageSnapshot, UsageView } from '../../types.js';
import type { ProviderConfig, ProviderUsage } from '../types.js';

const wait = (sec: number) => spawnSync('sleep', [String(sec)]);
const tmux = (args: string[]) => spawnSync(TMUX_BIN, args, { encoding: 'utf8' });

export function parseUsage(text: string, now: Date = new Date()): UsageSnapshot {
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

export function readUsageCache(): UsageCache | null {
  try {
    return JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeUsageCache(patch: Partial<UsageCache>): UsageCache {
  const next = { ...readUsageCache(), ...patch };
  fs.mkdirSync(path.dirname(USAGE_CACHE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function formatUsage(cache: UsageCache | null): UsageView | null {
  if (!cache || (!cache.session && !cache.week)) return null;
  const s = cache.session;
  const w = cache.week;
  const session = s
    ? `${s.pct ?? '—'}%${s.active ? '' : ' (idle)'}${s.resetsAt ? ` · resets ${formatClock(s.resetsAt)}` : ''}`
    : '—';
  const week = w
    ? `${w.pct ?? '—'}%${w.resetsAt ? ` · resets ${formatShortDate(w.resetsAt)}` : ''}`
    : '—';
  const ageMin = minutesSince(cache.capturedAt);
  return { session, week, ageMin, lastDecision: cache.lastDecision };
}

export function inferFromCache(
  now: Date = new Date(),
  cache: UsageCache | null = readUsageCache(),
): UsageSnapshot {
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
    weekSonnet: null,
  };
}

// Tmux-driving probe (moved verbatim from src/usage.ts).
export function probe(
  config: Pick<Config, 'model' | 'tmuxSession'>,
  now: Date = new Date(),
): UsageSnapshot | null {
  if (!isExecutable(CLAUDE_BIN) || !isExecutable(TMUX_BIN)) return null;
  const session = `${config.tmuxSession}-usage`;
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
      config.model,
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
    const usage = parseUsage(text, now);
    if (!usage.session && !usage.week) return null;
    return { ...usage, capturedAt: now.getTime() };
  } finally {
    tmux(['send-keys', '-t', session, 'Escape']);
    tmux(['kill-session', '-t', session]);
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes on the new path**

```bash
pnpm test -- src/providers/claude/probe.test.ts
```

Expected: PASS — same assertions as before, just on the new path.

- [ ] **Step 5: Wire `claude.ts` to the new probe (interface adapter)**

```ts
// src/providers/claude.ts (replace the stub)
import path from 'node:path';
import { WARMUP_HOME } from '../paths.js';
import { decide } from './claude/decide.js';
import { probe, parseUsage, inferFromCache } from './claude/probe.js';
import type { Provider, ProviderConfig, ProviderUsage, SharedConfig } from './types.js';
import type { UsageSnapshot } from '../types.js';

function cfgFromEnv(env: Record<string, string>, shared: SharedConfig): ProviderConfig {
  const num = (v: string | undefined): number | undefined =>
    v == null || v === '' ? undefined : Number(v);
  return {
    id: 'claude',
    enabled: (env.WARMUP_CLAUDE_ENABLED ?? 'true').toLowerCase() !== 'false',
    binary: env.WARMUP_CLAUDE_BIN || path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    model: env.WARMUP_CLAUDE_MODEL || 'haiku',
    tmuxSession: env.WARMUP_CLAUDE_TMUX_SESSION || 'claude-warmup',
    armScriptPath: path.join(WARMUP_HOME, 'arm-claude.sh'),
    workStart: num(env.WARMUP_CLAUDE_WORK_START) ?? 8,
    workEnd: num(env.WARMUP_CLAUDE_WORK_END) ?? 23,
    weeklyStopPercent: num(env.WARMUP_CLAUDE_WEEKLY_STOP_PERCENT) ?? 90,
    schedule: (env.WARMUP_CLAUDE_SCHEDULE || '').split(',').map(Number).filter(Number.isInteger),
    extra: {},
  };
}

export const claude: Provider = {
  id: 'claude',
  loadConfig: cfgFromEnv,
  probe: (cfg, now) => {
    const snap = probe({ model: cfg.model, tmuxSession: cfg.tmuxSession }, now);
    return snap ? (snap as ProviderUsage) : null;
  },
  decide: (cfg, usage, now) =>
    decide(
      {
        smart: {
          workStart: cfg.workStart,
          workEnd: cfg.workEnd,
          tickMinutes: shared.tickMinutes,
          weeklyStopPercent: cfg.weeklyStopPercent,
        },
      },
      usage as UsageSnapshot | null,
      now,
    ),
  armScript: () => ARM_CLAUDE_SH,
  armScriptPath: () => path.join(WARMUP_HOME, 'arm-claude.sh'),
};
```

(The `ARM_CLAUDE_SH` constant is defined in Phase 4. For now, export an empty string.)

- [ ] **Step 6: Delete the old `src/usage.ts`**

```bash
git rm src/usage.ts
```

- [ ] **Step 7: Typecheck**

```bash
pnpm run typecheck
```

Expected: errors. **Stop here.** Phase 2 is incomplete; Phases 3–9 fix the dependents. Continue with Phase 3; do not commit yet.

---

## Phase 3 — Decide module under `src/providers/claude/`

### Task 4: Move `decide.ts`

**Files:**

- Create: `src/providers/claude/decide.ts`
- Create: `src/providers/claude/decide.test.ts` (moved from `test/decide.test.ts`)
- Delete: `test/decide.test.ts` (after move)
- Delete: `src/decide.ts`

- [ ] **Step 1: Move the test**

```bash
git mv test/decide.test.ts src/providers/claude/decide.test.ts
```

Edit the import:

```ts
// from:
import { decide } from '../src/decide.js';
// to:
import { decide } from './decide.js';
```

- [ ] **Step 2: Run test to verify it fails on the new path**

```bash
pnpm test -- src/providers/claude/decide.test.ts
```

Expected: FAIL — `Cannot find module './decide.js'`.

- [ ] **Step 3: Move the implementation**

```ts
// src/providers/claude/decide.ts
import { formatClock, getHours } from '../../time.js';
import type { Config, Decision, UsageSnapshot } from '../../types.js';

export function decide(
  config: Pick<Config, 'smart'>,
  usage: UsageSnapshot | null,
  now: Date = new Date(),
): Decision {
  const { workStart, workEnd, weeklyStopPercent } = config.smart;
  const hour = getHours(now);

  if (hour < workStart || hour >= workEnd) {
    return { action: 'skip-offhours', reason: `outside working hours ${workStart}-${workEnd}` };
  }

  const weekPct = usage?.week?.pct;
  if (weekPct != null && Number.isFinite(weekPct) && weekPct >= weeklyStopPercent) {
    return { action: 'skip-weekly', reason: `weekly ${weekPct}% ≥ ${weeklyStopPercent}%` };
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test -- src/providers/claude/decide.test.ts
```

Expected: PASS — same assertions as before.

- [ ] **Step 5: Delete the old file**

```bash
git rm src/decide.ts
```

- [ ] **Step 6: Commit (combined with Phase 2 work)**

```bash
git add -A src/providers src/providers/claude
git commit -m "refactor(providers): move claude probe + decide under src/providers/claude/"
```

---

## Phase 4 — Config schema + migration

### Task 5: Update `types.ts` with new shared types

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add `SharedConfig` and `ProviderConfig` re-exports**

```ts
// src/types.ts (add at the bottom, before the closing of the file)
import type { ProviderConfig, SharedConfig } from './providers/types.js';
export type { ProviderConfig, SharedConfig } from './providers/types.js';
```

- [ ] **Step 2: Typecheck**

```bash
pnpm run typecheck
```

Expected: PASS (types.ts re-exports, no consumers yet).

### Task 6: New config schema with per-provider parsing

**Files:**

- Modify: `src/config.ts`
- Modify: `test/config.test.ts`
- Create: `test/config-migration.test.ts`

- [ ] **Step 1: Write the failing test for migration**

```ts
// test/config-migration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, serializeConfig } from '../src/config.js';

const OLD_ENV = `
WARMUP_MODE=smart
WARMUP_MODEL=haiku
WARMUP_TMUX_SESSION=claude-warmup
WARMUP_SCHEDULE=8,13,18
WARMUP_WORK_START=8
WARMUP_WORK_END=23
WARMUP_TICK_MINUTES=30
WARMUP_WEEKLY_STOP_PERCENT=90
WARMUP_SCHEDULER=launchd
`;

test('old env parses with a single claude provider', () => {
  const c = parseConfig(OLD_ENV);
  assert.deepEqual(c.providerIds, ['claude']);
  const claude = c.providers.claude;
  assert.equal(claude.model, 'haiku');
  assert.equal(claude.tmuxSession, 'claude-warmup');
  assert.equal(claude.workStart, 8);
  assert.equal(claude.workEnd, 23);
  assert.equal(claude.weeklyStopPercent, 90);
  assert.deepEqual(claude.schedule, [8, 13, 18]);
});

test('old env serializes into the new schema with WARMUP_PROVIDERS', () => {
  const c = parseConfig(OLD_ENV);
  const text = serializeConfig(c);
  assert.match(text, /WARMUP_PROVIDERS=claude/);
  assert.match(text, /WARMUP_CLAUDE_MODEL=haiku/);
  assert.match(text, /WARMUP_CLAUDE_TMUX_SESSION=claude-warmup/);
});

test('new env with two providers parses both', () => {
  const env = `
WARMUP_MODE=smart
WARMUP_PROVIDERS=claude,opencode
WARMUP_CLAUDE_MODEL=haiku
WARMUP_OPENCODE_MODEL=minimax-m3
WARMUP_OPENCODE_BIN=/opt/opencode/bin/opencode
`;
  const c = parseConfig(env);
  assert.deepEqual(c.providerIds, ['claude', 'opencode']);
  assert.equal(c.providers.opencode.model, 'minimax-m3');
  assert.equal(c.providers.opencode.binary, '/opt/opencode/bin/opencode');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- test/config-migration.test.ts
```

Expected: FAIL — `parseConfig` returns the old shape (no `providerIds`, no `providers`).

- [ ] **Step 3: Rewrite `config.ts`**

Replace `src/config.ts` with:

```ts
// src/config.ts
// Multi-provider config. Old top-level keys (WARMUP_MODEL, WARMUP_TMUX_SESSION,
// WARMUP_SCHEDULE, WARMUP_WORK_*, WARMUP_WEEKLY_STOP_PERCENT) are still read as
// defaults for the `claude` provider when WARMUP_PROVIDERS is absent.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './paths.js';
import type { Config, ConfigInput, Mode, Model, Scheduler, SmartConfig } from './types.js';
import type { ProviderConfig, ProviderId, SharedConfig } from './providers/types.js';

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus'];
const IS_DARWIN = process.platform === 'darwin';
export const SCHEDULERS: readonly Scheduler[] = IS_DARWIN ? ['launchd', 'cron'] : ['cron'];
export const MODES: readonly Mode[] = ['smart', 'fixed'];
export const TICK_CHOICES: readonly number[] = [5, 10, 15, 20, 30, 60];

export const DEFAULT_SMART: SmartConfig = {
  workStart: 8,
  workEnd: 23,
  tickMinutes: 30,
  weeklyStopPercent: 90,
};

export const DEFAULT_CLAUDE: ProviderConfig = {
  id: 'claude',
  enabled: true,
  binary: process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`,
  model: 'haiku',
  tmuxSession: 'claude-warmup',
  armScriptPath: `${process.env.HOME}/.claude/warmup/arm-claude.sh`,
  workStart: 8,
  workEnd: 23,
  weeklyStopPercent: 90,
  schedule: [8, 13, 18],
  extra: {},
};

export const DEFAULT_OPENCODE: ProviderConfig = {
  id: 'opencode',
  enabled: true,
  binary: `${process.env.HOME}/.local/bin/opencode`,
  model: '', // user must pick; spec A-6
  tmuxSession: 'opencode-warmup',
  armScriptPath: `${process.env.HOME}/.claude/warmup/arm-opencode.sh`,
  workStart: 7,
  workEnd: 22,
  weeklyStopPercent: 85,
  schedule: [9, 14, 19],
  extra: {},
};

export interface Config {
  mode: Mode;
  scheduler: Scheduler;
  tickMinutes: number;
  /** Top-level shared values passed to each provider's loadConfig. */
  shared: SharedConfig;
  /** Ordered list of provider ids (drives tick iteration order). */
  providerIds: ProviderId[];
  /** Parsed config per provider. */
  providers: Record<ProviderId, ProviderConfig>;
  /** Persisted as WARMUP_SELECTED_PROVIDER. */
  selectedProvider: ProviderId;
}

export interface ConfigInput {
  mode?: string;
  scheduler?: string;
  tickMinutes?: number;
  providerIds?: string[];
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
  selectedProvider?: string;
}

export function loadConfig(): Config {
  try {
    return parseConfig(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return defaults();
  }
}

export function saveConfig(input: ConfigInput): Config {
  const clean = normalize(input);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // First save after migration: keep a backup of the old env (if any).
  if (fs.existsSync(CONFIG_PATH)) {
    const oldText = fs.readFileSync(CONFIG_PATH, 'utf8');
    const newText = serialize(clean);
    if (oldText !== newText && !fs.existsSync(`${CONFIG_PATH}.bak`)) {
      fs.writeFileSync(`${CONFIG_PATH}.bak`, oldText);
    }
  }
  fs.writeFileSync(CONFIG_PATH, serialize(clean));
  return clean;
}

export function parseConfig(text: string): Config {
  const env = parseEnv(text);
  return normalize(envToInput(env));
}

export function serializeConfig(input: ConfigInput): string {
  return serialize(normalize(input));
}

function defaults(): Config {
  return normalize({});
}

function envToInput(env: Record<string, string>): ConfigInput {
  const num = (v: string | undefined): number | undefined =>
    v == null || v === '' ? undefined : Number(v);
  const providers: ConfigInput['providers'] = { claude: {}, opencode: {} };

  // Old schema → defaults for claude.
  const oldClaude: Partial<ProviderConfig> = {};
  if (env.WARMUP_MODEL) oldClaude.model = env.WARMUP_MODEL;
  if (env.WARMUP_TMUX_SESSION) oldClaude.tmuxSession = env.WARMUP_TMUX_SESSION;
  if (env.WARMUP_SCHEDULE)
    oldClaude.schedule = env.WARMUP_SCHEDULE.split(',').map(Number).filter(Number.isInteger);
  if (env.WARMUP_WORK_START) oldClaude.workStart = num(env.WARMUP_WORK_START);
  if (env.WARMUP_WORK_END) oldClaude.workEnd = num(env.WARMUP_WORK_END);
  if (env.WARMUP_WEEKLY_STOP_PERCENT)
    oldClaude.weeklyStopPercent = num(env.WARMUP_WEEKLY_STOP_PERCENT);
  if (env.WARMUP_CLAUDE_ENABLED)
    oldClaude.enabled = env.WARMUP_CLAUDE_ENABLED.toLowerCase() !== 'false';
  if (env.WARMUP_CLAUDE_BIN) oldClaude.binary = env.WARMUP_CLAUDE_BIN;
  providers.claude = { ...oldClaude, ...(providers.claude || {}) };

  // New schema: WARMUP_<ID>_* per provider.
  providers.claude = {
    ...(providers.claude || {}),
    ...(env.WARMUP_CLAUDE_MODEL ? { model: env.WARMUP_CLAUDE_MODEL } : {}),
    ...(env.WARMUP_CLAUDE_TMUX_SESSION ? { tmuxSession: env.WARMUP_CLAUDE_TMUX_SESSION } : {}),
    ...(env.WARMUP_CLAUDE_BIN ? { binary: env.WARMUP_CLAUDE_BIN } : {}),
    ...(env.WARMUP_CLAUDE_SCHEDULE
      ? { schedule: env.WARMUP_CLAUDE_SCHEDULE.split(',').map(Number).filter(Number.isInteger) }
      : {}),
    ...(env.WARMUP_CLAUDE_WORK_START ? { workStart: num(env.WARMUP_CLAUDE_WORK_START) } : {}),
    ...(env.WARMUP_CLAUDE_WORK_END ? { workEnd: num(env.WARMUP_CLAUDE_WORK_END) } : {}),
    ...(env.WARMUP_CLAUDE_WEEKLY_STOP_PERCENT
      ? { weeklyStopPercent: num(env.WARMUP_CLAUDE_WEEKLY_STOP_PERCENT) }
      : {}),
    ...(env.WARMUP_CLAUDE_ENABLED
      ? { enabled: env.WARMUP_CLAUDE_ENABLED.toLowerCase() !== 'false' }
      : {}),
  };
  providers.opencode = {
    ...(env.WARMUP_OPENCODE_MODEL ? { model: env.WARMUP_OPENCODE_MODEL } : {}),
    ...(env.WARMUP_OPENCODE_TMUX_SESSION ? { tmuxSession: env.WARMUP_OPENCODE_TMUX_SESSION } : {}),
    ...(env.WARMUP_OPENCODE_BIN ? { binary: env.WARMUP_OPENCODE_BIN } : {}),
    ...(env.WARMUP_OPENCODE_SCHEDULE
      ? { schedule: env.WARMUP_OPENCODE_SCHEDULE.split(',').map(Number).filter(Number.isInteger) }
      : {}),
    ...(env.WARMUP_OPENCODE_WORK_START ? { workStart: num(env.WARMUP_OPENCODE_WORK_START) } : {}),
    ...(env.WARMUP_OPENCODE_WORK_END ? { workEnd: num(env.WARMUP_OPENCODE_WORK_END) } : {}),
    ...(env.WARMUP_OPENCODE_WEEKLY_STOP_PERCENT
      ? { weeklyStopPercent: num(env.WARMUP_OPENCODE_WEEKLY_STOP_PERCENT) }
      : {}),
    ...(env.WARMUP_OPENCODE_ENABLED
      ? { enabled: env.WARMUP_OPENCODE_ENABLED.toLowerCase() !== 'false' }
      : {}),
  };

  const providerIds = env.WARMUP_PROVIDERS
    ? (env.WARMUP_PROVIDERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean) as ProviderId[])
    : ['claude'];

  return {
    mode: env.WARMUP_MODE,
    scheduler: env.WARMUP_SCHEDULER,
    tickMinutes: num(env.WARMUP_TICK_MINUTES),
    providerIds,
    providers,
    selectedProvider: env.WARMUP_SELECTED_PROVIDER,
  };
}

function normalize(input: ConfigInput): Config {
  const mode: Mode = input.mode === 'fixed' ? 'fixed' : 'smart';
  const scheduler: Scheduler = input.scheduler === 'cron' ? 'cron' : SCHEDULERS[0];
  const tickMinutes = TICK_CHOICES.includes(input.tickMinutes ?? 0)
    ? (input.tickMinutes as number)
    : DEFAULT_SMART.tickMinutes;

  const providerIds: ProviderId[] = (
    input.providerIds?.length ? input.providerIds : ['claude']
  ) as ProviderId[];

  const claude: ProviderConfig = { ...DEFAULT_CLAUDE, ...(input.providers?.claude || {}) };
  const opencode: ProviderConfig = { ...DEFAULT_OPENCODE, ...(input.providers?.opencode || {}) };

  // Clamp + validate.
  claude.workStart = clampHour(claude.workStart, DEFAULT_CLAUDE.workStart);
  claude.workEnd = Math.max(
    claude.workStart + 1,
    clampHour(claude.workEnd, DEFAULT_CLAUDE.workEnd),
  );
  claude.weeklyStopPercent = clampPercent(
    claude.weeklyStopPercent,
    DEFAULT_CLAUDE.weeklyStopPercent,
  );
  opencode.workStart = clampHour(opencode.workStart, DEFAULT_OPENCODE.workStart);
  opencode.workEnd = Math.max(
    opencode.workStart + 1,
    clampHour(opencode.workEnd, DEFAULT_OPENCODE.workEnd),
  );
  opencode.weeklyStopPercent = clampPercent(
    opencode.weeklyStopPercent,
    DEFAULT_OPENCODE.weeklyStopPercent,
  );

  // Schedule: only used in fixed mode; sort + dedupe.
  claude.schedule = [...new Set(claude.schedule || [])]
    .map(Number)
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  opencode.schedule = [...new Set(opencode.schedule || [])]
    .map(Number)
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);

  const selectedProvider: ProviderId =
    input.selectedProvider === 'opencode' ? 'opencode' : 'claude';

  return {
    mode,
    scheduler,
    tickMinutes,
    shared: { mode, tickMinutes, scheduler },
    providerIds,
    providers: { claude, opencode },
    selectedProvider,
  };
}

function clampHour(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : d;
}
function clampPercent(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : d;
}

function serialize(c: Config): string {
  return `# claude-warmup configuration (multi-provider)
# Edit a value and run \`claude-warmup restart\` to apply. Keys are the WARMUP_*
# environment variables warmup.sh reads, so you can also \`set -a; source\` this file.

# smart | fixed  — smart probes /usage each tick and arms only when needed
WARMUP_MODE=${c.mode}

# launchd | cron  — which scheduler installs the timers
WARMUP_SCHEDULER=${c.scheduler}

# how often the scheduler probes + decides (5 | 10 | 15 | 20 | 30 | 60)
WARMUP_TICK_MINUTES=${c.tickMinutes}

# enabled providers, in tick order
WARMUP_PROVIDERS=${c.providerIds.join(',')}

# TUI/CLI selection (which provider the unprefixed subcommands mutate)
WARMUP_SELECTED_PROVIDER=${c.selectedProvider}

# ── claude ────────────────────────────────────────────────────────────
WARMUP_CLAUDE_ENABLED=${c.providers.claude.enabled}
WARMUP_CLAUDE_BIN=${c.providers.claude.binary}
WARMUP_CLAUDE_MODEL=${c.providers.claude.model}
WARMUP_CLAUDE_TMUX_SESSION=${c.providers.claude.tmuxSession}
WARMUP_CLAUDE_WORK_START=${c.providers.claude.workStart}
WARMUP_CLAUDE_WORK_END=${c.providers.claude.workEnd}
WARMUP_CLAUDE_WEEKLY_STOP_PERCENT=${c.providers.claude.weeklyStopPercent}
# fixed mode only:
WARMUP_CLAUDE_SCHEDULE=${c.providers.claude.schedule.join(',')}

# ── opencode ──────────────────────────────────────────────────────────
WARMUP_OPENCODE_ENABLED=${c.providers.opencode.enabled}
WARMUP_OPENCODE_BIN=${c.providers.opencode.binary}
WARMUP_OPENCODE_MODEL=${c.providers.opencode.model}
WARMUP_OPENCODE_TMUX_SESSION=${c.providers.opencode.tmuxSession}
WARMUP_OPENCODE_WORK_START=${c.providers.opencode.workStart}
WARMUP_OPENCODE_WORK_END=${c.providers.opencode.workEnd}
WARMUP_OPENCODE_WEEKLY_STOP_PERCENT=${c.providers.opencode.weeklyStopPercent}
WARMUP_OPENCODE_SCHEDULE=${c.providers.opencode.schedule.join(',')}
`;
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    env[key] = value;
  }
  return env;
}
```

- [ ] **Step 4: Run the migration test to verify it passes**

```bash
pnpm test -- test/config-migration.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Update `test/config.test.ts` to match the new shape**

Adjust the assertions to the new `Config` shape (`shared`, `providerIds`, `providers.claude`, etc.). The existing test exercises a `DEFAULT_CONFIG`-like object; rewrite each assertion to access the new fields. For example:

```ts
// test/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, serializeConfig, MODELS, SCHEDULERS, MODES } from '../src/config.js';

test('defaults are exposed', () => {
  const c = parseConfig('');
  assert.equal(c.mode, 'smart');
  assert.equal(c.tickMinutes, 30);
  assert.deepEqual(c.providerIds, ['claude']);
  assert.equal(c.providers.claude.model, 'haiku');
});

test('MODELS / SCHEDULERS / MODES exports', () => {
  assert.ok(MODES.includes('smart'));
  assert.ok(MODES.includes('fixed'));
  assert.ok(MODELS.includes('haiku'));
  assert.ok(SCHEDULERS.length > 0);
});

test('serializeConfig round-trips the new schema', () => {
  const c = parseConfig(
    'WARMUP_PROVIDERS=claude,opencode\nWARMUP_CLAUDE_MODEL=haiku\nWARMUP_OPENCODE_MODEL=mini\n',
  );
  const text = serializeConfig(c);
  assert.match(text, /WARMUP_PROVIDERS=claude,opencode/);
  assert.match(text, /WARMUP_CLAUDE_MODEL=haiku/);
  assert.match(text, /WARMUP_OPENCODE_MODEL=mini/);
});
```

- [ ] **Step 6: Run the full test suite to make sure nothing else broke**

```bash
pnpm test
```

Expected: some failures in `decide.test.ts` (path moved) and `parse-usage.test.ts` (path moved) — both were moved in Phases 2–3. The failures should only be the moved ones; everything else passes.

- [ ] **Step 7: Commit**

```bash
git add -A src/config.ts test/config.test.ts test/config-migration.test.ts
git commit -m "feat(config): multi-provider schema with silent migration + .bak"
```

---

## Phase 5 — Assets + arm scripts

### Task 7: Embed `arm-claude.sh` in `assets.ts`

**Files:**

- Modify: `src/assets.ts`
- Modify: `src/providers/claude.ts` (use the embedded script)
- Modify: `package.json` (no longer need to ship `warmup.sh`)
- Modify: `sea-config.json` (drop `warmup.sh`)

- [ ] **Step 1: Write the embedded `arm-claude.sh` as a string**

```ts
// src/assets.ts (replace the file)
import fs from 'node:fs';
import path from 'node:path';
import { isSea, getAsset } from 'node:sea';
import { WARMUP_HOME } from './paths.js';

export const ARM_CLAUDE_SH = String.raw`#!/usr/bin/env bash
#
# arm-claude.sh — starts Claude Code's usage window by launching a real
# interactive session inside tmux, sending a trivial prompt, and exiting.
# Meant to be spawned by the multi-provider warmup once per arming decision.
# All knobs are env-driven; the provider's tick passes them in.
#
# Uses \`--safe-mode\`: keeps normal auth (Keychain/OAuth arms the window) but
# disables hooks, MCP, CLAUDE.md, plugins → fast, cheap, no integration prompts.

set -euo pipefail

# Robust minimal PATH (launchd/cron start with a bare PATH).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# ---- config (every value is required to be set by the caller) ----
: "${WARMUP_BIN:?must be set}"
: "${WARMUP_TMUX_SESSION:?must be set}"
: "${WARMUP_WORKDIR:?must be set}"
: "${WARMUP_LOG_DIR:?must be set}"
MODEL="${WARMUP_MODEL:-haiku}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
READY_WAIT="${WARMUP_READY_WAIT:-10}"
RESPONSE_WAIT="${WARMUP_RESPONSE_WAIT:-25}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"

mkdir -p "$WARMUP_WORKDIR" "$WARMUP_LOG_DIR"
LOG="$WARMUP_LOG_DIR/warmup.log"
log() { printf '[%s] [claude] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ]   || { log "ERROR: claude not executable at $WARMUP_BIN"; exit 1; }
[ -x "$TMUX_BIN" ]     || { log "ERROR: tmux not executable at $TMUX_BIN"; exit 1; }

"$TMUX_BIN" kill-session -t "$WARMUP_TMUX_SESSION" 2>/dev/null || true
log "START (model=$MODEL workdir=$WARMUP_WORKDIR)"

"$TMUX_BIN" new-session -d -s "$WARMUP_TMUX_SESSION" -x 220 -y 50 -c "$WARMUP_WORKDIR" \
  "$WARMUP_BIN" --safe-mode --model "$MODEL"
sleep "$READY_WAIT"

if "$TMUX_BIN" capture-pane -p -t "$WARMUP_TMUX_SESSION" 2>/dev/null \
     | grep -qiE "trust this folder|project you (created|trust)|do you trust"; then
  log "trust dialog detected -> accepting (1)"
  "$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" "1"
  "$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" Enter
  sleep 4
fi

"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" -l "$PROMPT"
sleep 1
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" Enter

sleep "$RESPONSE_WAIT"

PANE="$WARMUP_LOG_DIR/pane-$(date '+%Y%m%d-%H%M%S').txt"
"$TMUX_BIN" capture-pane -p -t "$WARMUP_TMUX_SESSION" -S -400 > "$PANE" 2>/dev/null || true

if grep -q '⏺' "$PANE" 2>/dev/null; then
  log "OK: reply received -> usage window armed (pane: $PANE)"
  STATUS=0
else
  log "WARN: no reply detected; check $PANE (may need higher READY_WAIT/RESPONSE_WAIT)"
  STATUS=2
fi

"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" -l "/exit" 2>/dev/null || true
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" Enter 2>/dev/null || true
sleep 2
"$TMUX_BIN" kill-session -t "$WARMUP_TMUX_SESSION" 2>/dev/null || true

find "$WARMUP_LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
log "DONE (status=$STATUS)"
exit "$STATUS"
`;

export function ensureArmScript(id: 'claude' | 'opencode'): string {
  const target = path.join(WARMUP_HOME, `arm-${id}.sh`);
  if (!isSea()) {
    // In dev/npm installs the script lives in the repo; copy it to WARMUP_HOME
    // so the scheduler can spawn it (just like the old warmup.sh did).
    const source = path.join(process.cwd(), 'src', 'assets', `arm-${id}.sh`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    return target;
  }
  // SEA build: the script is embedded as an asset.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = id === 'claude' ? getAsset('arm-claude.sh', 'utf8') : getAsset('arm-opencode.sh', 'utf8');
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o755);
  return target;
}
```

- [ ] **Step 2: Drop the on-disk `warmup.sh` and update package.json**

```bash
git rm warmup.sh
```

Edit `package.json`:

```diff
   "files": [
     "dist",
-    "warmup.sh"
+    "src/assets/arm-claude.sh",
+    "src/assets/arm-opencode.sh"
   ],
```

- [ ] **Step 3: Update `sea-config.json`**

```json
{
  "main": "dist/claude-warmup.mjs",
  "output": "dist/claude-warmup",
  "assets": {
    "arm-claude.sh": "src/assets/arm-claude.sh",
    "arm-opencode.sh": "src/assets/arm-opencode.sh"
  }
}
```

- [ ] **Step 4: Update the claude provider to use the embedded script**

```ts
// src/providers/claude.ts (replace the previous `armScript: () => ''` line)
  armScript: () => ARM_CLAUDE_SH,
```

Add at the top of `src/providers/claude.ts`:

```ts
import { ARM_CLAUDE_SH } from '../assets.js';
```

- [ ] **Step 5: Update `runner.ts` to call `ensureArmScript` and pass provider env**

```ts
// src/runner.ts (replace the runNow function)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WARMUP_LOG, LOG_DIR } from './paths.js';
import { loadConfig } from './config.js';
import { ensureArmScript } from './assets.js';
import { getProvider } from './providers/index.js';
import type { ProviderId } from './providers/types.js';

export function runNow(providerId?: ProviderId): number {
  const config = loadConfig();
  const id =
    providerId ??
    config.selectedProvider ??
    config.providerIds.find((p) => config.providers[p].enabled) ??
    'claude';
  const provider = getProvider(id);
  const cfg = config.providers[id];
  ensureArmScript(id);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const r = spawnSync('/bin/bash', [provider.armScriptPath()], {
    stdio: 'inherit',
    env: {
      ...process.env,
      WARMUP_BIN: cfg.binary,
      WARMUP_MODEL: cfg.model,
      WARMUP_TMUX_SESSION: cfg.tmuxSession,
      WARMUP_WORKDIR: `${process.env.HOME}/.claude/warmup/workdir`,
      WARMUP_LOG_DIR: `${process.env.HOME}/.claude/warmup/logs`,
    },
  });
  return r.status ?? 1;
}
```

(Leave `viewLogs` and `lastRunSummary` as they are; they read the log file directly and don't care about providers.)

- [ ] **Step 6: Typecheck + tests**

```bash
pnpm run typecheck
pnpm test
```

Expected: typecheck may surface dependents that still import from `src/usage.ts` / `src/decide.ts`. Continue with Phase 6 to fix them; **do not commit yet**.

---

## Phase 6 — Tick rewrite (multi-provider orchestration)

### Task 8: New `tick.ts` with per-provider iteration

**Files:**

- Rewrite: `src/tick.ts`
- Create: `test/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/tick.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick } from '../src/tick.js';

const NOW = new Date(2026, 5, 13, 13, 0, 0);

test('runTick iterates enabled providers in env order', () => {
  const r = runTick({ dryRun: true, now: NOW });
  // Smoke: the function returns an array; one result per enabled provider.
  assert.ok(Array.isArray(r));
  // When WARMUP_PROVIDERS is empty, only claude is enabled.
  assert.ok(r.length >= 1);
  for (const item of r) {
    assert.ok(['claude', 'opencode'].includes(item.id));
    assert.ok(
      ['warm', 'skip-offhours', 'skip-weekly', 'skip-active'].includes(item.decision.action),
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- test/tick.test.ts
```

Expected: FAIL — the current `runTick` returns an object, not an array.

- [ ] **Step 3: Rewrite `src/tick.ts`**

```ts
// src/tick.ts
// One tick: probe every enabled provider, decide per provider, arm if warranted.
// This is what the scheduler runs every `tickMinutes` in smart mode.
import { loadConfig } from './config.js';
import { getProvider } from './providers/index.js';
import { runNow } from './runner.js';
import { appendLog, pruneLogs } from './logs.js';
import { writeProviderCache, readUsageCache } from './usage-cache.js';
import type { Decision, ProviderId, ProviderUsage } from './providers/types.js';
import type { UsageCache } from './types.js';

export interface TickOptions {
  dryRun?: boolean;
  /** Inject a usage snapshot for one provider (testing). */
  usage?: ProviderUsage | null;
  /** Override the current time (testing). */
  now?: Date;
  /** Run only one provider. */
  onlyProvider?: ProviderId;
}

export interface TickResult {
  id: ProviderId;
  decision: Decision;
  status: number;
  usage: ProviderUsage | null;
}

export function runTick({
  dryRun = false,
  now = new Date(),
  onlyProvider,
}: TickOptions = {}): TickResult[] {
  const top = loadConfig();
  const ids = onlyProvider
    ? [onlyProvider]
    : top.providerIds.filter((id) => top.providers[id]?.enabled);

  const results: TickResult[] = [];
  for (const id of ids) {
    const provider = getProvider(id);
    const cfg = { ...top.providers[id], id };
    let usage = provider.probe(cfg, now);
    let probed = !!usage;
    if (!usage) usage = inferFromCacheFor(id, now);

    const decision = provider.decide(cfg, usage, now);
    let status = 0;
    if (decision.action === 'warm' && !dryRun) {
      status = runNow(id);
    }
    writeProviderCache(id, {
      lastDecision: { ...decision, at: now.toISOString() },
      capturedAt: probed ? usage.capturedAt : undefined,
      session: usage.session,
      week: usage.week,
      ...(usage.weekSonnet ? { weekSonnet: usage.weekSonnet } : {}),
      ...(decision.action === 'warm' ? { lastWarmAt: now.getTime() } : {}),
    });
    appendLog(
      now,
      `TICK [${id}] ${decision.action}${dryRun ? ' (dry-run)' : ''} — ${decision.reason} [via ${probed ? 'probe' : usage.inferred ? 'cache' : 'injected'}]`,
    );
    results.push({ id, decision, status, usage });
  }
  pruneLogs(now);
  return results;
}

function inferFromCacheFor(id: ProviderId, now: Date): ProviderUsage {
  const cache = readUsageCache();
  const perProvider = (cache?.[id] || null) as UsageCache | null;
  const last = perProvider?.lastWarmAt;
  const active = last != null && now.getTime() - last < 5 * 60 * 60 * 1000;
  return {
    inferred: true,
    session: {
      pct: active ? 1 : 0,
      resetsAt: active && last != null ? new Date(last + 5 * 60 * 60 * 1000) : null,
      active: !!active,
    },
    week: null,
  };
}
```

- [ ] **Step 4: Create `src/usage-cache.ts` (per-provider cache)**

```ts
// src/usage-cache.ts
// Per-provider usage cache. The on-disk shape is a map from provider id to
// the per-provider UsageCache. Old (flat) shapes are wrapped as {claude:…}.
import fs from 'node:fs';
import path from 'node:path';
import { USAGE_CACHE } from './paths.js';
import type { UsageCache } from './types.js';
import type { ProviderId } from './providers/types.js';

export type ProviderCacheMap = Partial<Record<ProviderId, UsageCache>>;

export function readUsageCache(): ProviderCacheMap | null {
  try {
    const text = fs.readFileSync(USAGE_CACHE, 'utf8');
    const json = JSON.parse(text);
    // Detect the old flat shape (has 'session' at the top level).
    if (
      json &&
      typeof json === 'object' &&
      'session' in json &&
      !('claude' in json) &&
      !('opencode' in json)
    ) {
      const migrated: ProviderCacheMap = { claude: json as UsageCache };
      fs.writeFileSync(USAGE_CACHE, JSON.stringify(migrated, null, 2) + '\n');
      return migrated;
    }
    return json as ProviderCacheMap;
  } catch {
    return null;
  }
}

export function writeProviderCache(id: ProviderId, patch: Partial<UsageCache>): ProviderCacheMap {
  const cur = readUsageCache() || {};
  const next: ProviderCacheMap = { ...cur, [id]: { ...(cur[id] || {}), ...patch } };
  fs.mkdirSync(path.dirname(USAGE_CACHE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE, JSON.stringify(next, null, 2) + '\n');
  return next;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test -- test/tick.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/tick.ts src/usage-cache.ts src/runner.ts src/assets.ts src/providers test/tick.test.ts package.json sea-config.json
git commit -m "feat(tick): multi-provider tick + per-provider usage cache + embedded arm scripts"
```

---

## Phase 7 — opencode provider (driven by Phase 0 spike)

### Task 9: Implement `opencode.probe` and `opencode.decide`

**Files:**

- Modify: `src/providers/opencode.ts`
- Create: `src/providers/opencode/probe.ts` (parser)
- Create: `src/providers/opencode/probe.test.ts`
- Create: `src/providers/opencode/decide.ts`
- Create: `src/providers/opencode/decide.test.ts`
- Create: `src/assets/arm-opencode.sh` (committed under `src/assets/`)

- [ ] **Step 1: Read the spike note from Phase 0**

Open `docs/superpowers/specs/2026-06-15-opencode-spike.md`. The fields recorded there drive the parser and the arm script.

- [ ] **Step 2: Write the opencode probe parser test**

```ts
// src/providers/opencode/probe.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpencodeUsage } from './probe.js';

const SPIKE_OUTPUT = `
<<< PASTE THE EXACT PANE FROM PHASE 0 HERE >>>
`;

test('parseOpencodeUsage extracts session + week', () => {
  const u = parseOpencodeUsage(SPIKE_OUTPUT, new Date(2026, 5, 13, 13, 0, 0));
  assert.ok(u.session, 'expected a session block');
  assert.ok(u.week, 'expected a week block');
  assert.equal(u.session!.pct, 0); // adjust after pasting real output
});
```

(Paste the actual spike output and adjust the assertion values to match.)

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm test -- src/providers/opencode/probe.test.ts
```

Expected: FAIL — `Cannot find module './probe.js'`.

- [ ] **Step 4: Write the parser**

```ts
// src/providers/opencode/probe.ts
// Opencode /usage pane parser. Driven by the Phase 0 spike output.
import { parseReset } from '../../time.js';
import { isAfter } from 'date-fns';
import type { LimitBlock, UsageSnapshot } from '../../types.js';
import type { ProviderUsage } from '../types.js';

export function parseOpencodeUsage(text: string, now: Date = new Date()): UsageSnapshot {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim());
  // Adjust the block labels to whatever the spike produced.
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
  const session = block('<<< LABEL FROM SPIKE >>>');
  const week = block('<<< LABEL FROM SPIKE >>>');
  if (session) {
    session.active = (session.pct ?? 0) > 0 && !!session.resetsAt && isAfter(session.resetsAt, now);
  }
  return { session, week };
}
```

(Replace the `<<< LABEL FROM SPIKE >>>` placeholders with the actual labels recorded in the spike. Once they are real values, remove the placeholders.)

- [ ] **Step 5: Run the parser test to verify it passes**

```bash
pnpm test -- src/providers/opencode/probe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write the opencode decide test (mirror claude's)**

```ts
// src/providers/opencode/decide.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './decide.js';

const CFG = { workStart: 7, workEnd: 22, weeklyStopPercent: 85 };
const DAY = new Date(2026, 5, 13, 13, 0, 0);
const NIGHT = new Date(2026, 5, 13, 3, 0, 0);

const usage = (over = {}) => ({
  session: { pct: 0, active: false, resetsAt: null },
  week: { pct: 5, resetsAt: null },
  ...over,
});

test('outside working hours → skip-offhours', () => {
  assert.equal(decide(CFG, usage(), NIGHT).action, 'skip-offhours');
});
test('weekly over cutoff → skip-weekly', () => {
  assert.equal(decide(CFG, usage({ week: { pct: 90 } }), DAY).action, 'skip-weekly');
});
test('active window → skip-active', () => {
  const u = usage({ session: { pct: 30, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) } });
  assert.equal(decide(CFG, u, DAY).action, 'skip-active');
});
test('idle window → warm', () => {
  assert.equal(decide(CFG, usage(), DAY).action, 'warm');
});
```

- [ ] **Step 7: Run test to verify it fails**

```bash
pnpm test -- src/providers/opencode/decide.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 8: Write `opencode/decide.ts`**

```ts
// src/providers/opencode/decide.ts
import { formatClock, getHours } from '../../time.js';
import type { Decision, UsageSnapshot } from '../../types.js';

export interface OpencodeSmart {
  workStart: number;
  workEnd: number;
  weeklyStopPercent: number;
}

export function decide(
  cfg: OpencodeSmart,
  usage: UsageSnapshot | null,
  now: Date = new Date(),
): Decision {
  const hour = getHours(now);
  if (hour < cfg.workStart || hour >= cfg.workEnd) {
    return {
      action: 'skip-offhours',
      reason: `outside working hours ${cfg.workStart}-${cfg.workEnd}`,
    };
  }
  const weekPct = usage?.week?.pct;
  if (weekPct != null && Number.isFinite(weekPct) && weekPct >= cfg.weeklyStopPercent) {
    return { action: 'skip-weekly', reason: `weekly ${weekPct}% ≥ ${cfg.weeklyStopPercent}%` };
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
```

- [ ] **Step 9: Wire `opencode.ts` to its probe and decide**

```ts
// src/providers/opencode.ts (replace the stub)
import path from 'node:path';
import { WARMUP_HOME } from '../paths.js';
import { decide } from './opencode/decide.js';
import { parseOpencodeUsage } from './opencode/probe.js';
import { spawnSync } from 'node:child_process';
import { WARMUP_WORKDIR } from '../paths.js';
import { TMUX_BIN } from '../paths.js';
import type { Provider, ProviderConfig, ProviderUsage, SharedConfig } from './types.js';
import type { UsageSnapshot } from '../types.js';

function cfgFromEnv(env: Record<string, string>, shared: SharedConfig): ProviderConfig {
  const num = (v: string | undefined): number | undefined =>
    v == null || v === '' ? undefined : Number(v);
  return {
    id: 'opencode',
    enabled: (env.WARMUP_OPENCODE_ENABLED ?? 'true').toLowerCase() !== 'false',
    binary: env.WARMUP_OPENCODE_BIN || path.join(process.env.HOME || '', '.local', 'bin', 'opencode'),
    model: env.WARMUP_OPENCODE_MODEL || '',
    tmuxSession: env.WARMUP_OPENCODE_TMUX_SESSION || 'opencode-warmup',
    armScriptPath: path.join(WARMUP_HOME, 'arm-opencode.sh'),
    workStart: num(env.WARMUP_OPENCODE_WORK_START) ?? 7,
    workEnd: num(env.WARMUP_OPENCODE_WORK_END) ?? 22,
    weeklyStopPercent: num(env.WARMUP_OPENCODE_WEEKLY_STOP_PERCENT) ?? 85,
    schedule: (env.WARMUP_OPENCODE_SCHEDULE || '').split(',').map(Number).filter(Number.isInteger),
    extra: {},
  };
}

const wait = (sec: number) => spawnSync('sleep', [String(sec)]);
const tmux = (args: string[]) => spawnSync(TMUX_BIN, args, { encoding: 'utf8' });

export const opencode: Provider = {
  id: 'opencode',
  loadConfig: cfgFromEnv,
  probe: (cfg, now) => {
    if (!cfg.binary || !cfg.model) return null;
    const session = `${cfg.tmuxSession}-usage`;
    try {
      tmux(['kill-session', '-t', session]);
      const started = tmux([
        'new-session', '-d', '-s', session, '-x', '220', '-y', '55',
        '-c', WARMUP_WORKDIR, cfg.binary, '--model', cfg.model,
      ]);
      if (started.status !== 0) return null;
      wait(Number(process.env.WARMUP_READY_WAIT || 12));
      // Send the probe command recorded in the spike (slash command, subcommand, or state-file read).
      const probeCmd = '<<< PASTE PROBE COMMAND FROM SPIKE >>>';
      tmux(['send-keys', '-t', session, '-l', probeCmd]);
      tmux(['send-keys', '-t', session, 'Enter']);
      wait(Number(process.env.WARMUP_RESPONSE_WAIT || 6));
      const text = tmux(['capture-pane', '-p', '-t', session, '-S', '-200']).stdout || '';
      const usage = parseOpencodeUsage(text, now);
      if (!usage.session && !usage.week) return null;
      return { ...usage, capturedAt: now.getTime() } as ProviderUsage;
    } finally {
      tmux(['send-keys', '-t', session, 'Escape']);
      tmux(['kill-session', '-t', session]);
    }
  },
  decide: (cfg, usage, now) =>
    decide({ workStart: cfg.workStart, workEnd: cfg.workEnd, weeklyStopPercent: cfg.weeklyStopPercent }, usage as UsageSnapshot | null, now),
  armScript: () => ARM_OPENCODE_SH,
  armScriptPath: () => path.join(WARMUP_HOME, 'arm-opencode.sh'),
};

const ARM_OPENCODE_SH = String.raw`#!/usr/bin/env bash
# arm-opencode.sh — starts an opencode session in tmux, sends a trivial
# prompt, captures the pane, exits. All knobs are env-driven.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
: "${WARMUP_BIN:?must be set}"
: "${WARMUP_TMUX_SESSION:?must be set}"
: "${WARMUP_WORKDIR:?must be set}"
: "${WARMUP_LOG_DIR:?must be set}"
MODEL="${WARMUP_MODEL:-}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
READY_WAIT="${WARMUP_READY_WAIT:-10}"
RESPONSE_WAIT="${WARMUP_RESPONSE_WAIT:-25}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
mkdir -p "$WARMUP_WORKDIR" "$WARMUP_LOG_DIR"
LOG="$WARMUP_LOG_DIR/warmup.log"
log() { printf '[%s] [opencode] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }
"$TMUX_BIN" kill-session -t "$WARMUP_TMUX_SESSION" 2>/dev/null || true
log "START (model=$MODEL workdir=$WARMUP_WORKDIR)"
# Adjust the flags below to what the spike recorded for opencode.
"$TMUX_BIN" new-session -d -s "$WARMUP_TMUX_SESSION" -x 220 -y 50 -c "$WARMUP_WORKDIR" \
  "$WARMUP_BIN" --model "$MODEL"
sleep "$READY_WAIT"
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" -l "$PROMPT"
sleep 1
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" Enter
sleep "$RESPONSE_WAIT"
PANE="$WARMUP_LOG_DIR/pane-$(date '+%Y%m%d-%H%M%S').txt"
"$TMUX_BIN" capture-pane -p -t "$WARMUP_TMUX_SESSION" -S -400 > "$PANE" 2>/dev/null || true
if grep -q '⏺' "$PANE" 2>/dev/null; then
  log "OK: reply received -> usage window armed (pane: $PANE)"
  STATUS=0
else
  log "WARN: no reply detected; check $PANE (may need higher READY_WAIT/RESPONSE_WAIT)"
  STATUS=2
fi
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" -l "/exit" 2>/dev/null || true
"$TMUX_BIN" send-keys -t "$WARMUP_TMUX_SESSION" Enter 2>/dev/null || true
sleep 2
"$TMUX_BIN" kill-session -t "$WARMUP_TMUX_SESSION" 2>/dev/null || true
log "DONE (status=$STATUS)"
exit "$STATUS"
`;
```

(Replace `<<< PASTE PROBE COMMAND FROM SPIKE >>>` and the opencode flags with the spike's actual outputs. Once real, remove the placeholder comments.)

- [ ] **Step 10: Commit**

```bash
git add -A src/providers/opencode.ts src/providers/opencode src/assets/arm-opencode.sh
git commit -m "feat(opencode): provider with spike-driven probe + decide + arm script"
```

---

## Phase 8 — Status, print, TUI

### Task 10: Update `status.ts` for the new shape

**Files:**

- Modify: `src/status.ts`
- Modify: `test/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/status.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStatus } from '../src/status.js';

test('getStatus reports a per-provider view', () => {
  const s = getStatus();
  assert.ok(s.config);
  assert.ok(s.providers);
  assert.ok('claude' in s.providers);
  // opencode is enabled by default; the test passes if the key exists.
  assert.ok('opencode' in s.providers);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- test/status.test.ts
```

Expected: FAIL — `s.providers` doesn't exist yet.

- [ ] **Step 3: Rewrite `status.ts`**

```ts
// src/status.ts
import * as launchd from './launchd.js';
import * as cron from './cron.js';
import { loadConfig } from './config.js';
import { lastRunSummary } from './runner.js';
import { readUsageCache } from './usage-cache.js';
import { getHours } from './time.js';
import { pad2 } from './format.js';
import type { ProviderId, UsageCache } from './providers/types.js';
import type { Status } from './types.js';

export interface ProviderStatus {
  enabled: boolean;
  lastDecision?: UsageCache['lastDecision'];
  lastWarmAt?: number;
  ageMin: number | null;
}

export function nextRunSummary(config = loadConfig(), now: Date = new Date()): string | null {
  if (config.mode === 'smart') {
    return `every ${config.tickMinutes}m · ${pad2(config.providerIds[0] ? config.providers[config.providerIds[0]].workStart : 8)}–${pad2(config.providerIds[0] ? config.providers[config.providerIds[0]].workEnd : 23)}h`;
  }
  return null;
}

export function getStatus(): Status {
  const config = loadConfig();
  const l = launchd.status();
  const c = cron.status();
  const active =
    config.scheduler === 'launchd' ? l.installed && l.loaded && l.enabled : c.installed;
  const cache = readUsageCache() || {};
  const providers: Partial<Record<ProviderId, ProviderStatus>> = {};
  for (const id of config.providerIds) {
    const c = cache[id];
    providers[id] = {
      enabled: config.providers[id].enabled,
      lastDecision: c?.lastDecision,
      lastWarmAt: c?.lastWarmAt,
      ageMin: c?.capturedAt != null ? Math.round((Date.now() - c.capturedAt) / 60000) : null,
    };
  }
  return {
    config,
    launchd: l,
    cron: c,
    active,
    nextRun: active ? nextRunSummary(config) : null,
    lastRun: lastRunSummary(),
    usage: null, // legacy field; the new view is `providers`.
    providers,
  } as Status;
}
```

- [ ] **Step 4: Update `Status` in `src/types.ts`**

```ts
// src/types.ts (modify the Status interface)
export interface Status {
  config: import('./config.js').Config;
  launchd: LaunchdStatus;
  cron: CronStatus;
  active: boolean;
  nextRun: string | null;
  lastRun: string | null;
  usage: UsageCache | null; // legacy; nullable, ignored
  providers: Partial<Record<ProviderId, import('./status.js').ProviderStatus>>;
}
```

(Add `import type { ProviderId } from './providers/types.js';` to the top of `src/types.ts`.)

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test -- test/status.test.ts
```

Expected: PASS.

### Task 11: Update `print-status.ts` for per-provider output

**Files:**

- Modify: `src/print-status.ts`

- [ ] **Step 1: Replace the file**

```ts
// src/print-status.ts
import { getStatus } from './status.js';
import { readUsageCache } from './usage-cache.js';
import { formatUsage } from './providers/claude/probe.js';
import { pad2, ago } from './format.js';

const dot = (on: boolean): string => (on ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m');

export function printStatus(): void {
  const s = getStatus();
  const { config } = s;
  const enabledProviders = config.providerIds.filter((id) => config.providers[id].enabled);
  console.log(
    `${dot(s.active)} claude-warmup  ${s.active ? 'ACTIVE' : 'inactive'}  (${config.mode} · ${config.scheduler} · ${enabledProviders.length} providers)`,
  );
  if (config.mode === 'smart') {
    console.log(`  window     check every ${config.tickMinutes}m`);
  } else {
    console.log(
      `  schedule   ${config.providerIds.map((id) => `${id}:${config.providers[id].schedule.map((h) => pad2(h) + ':00').join(',') || '—'}`).join('  ')}`,
    );
  }
  const cache = readUsageCache();
  for (const id of enabledProviders) {
    const p = config.providers[id];
    const c = cache?.[id] || null;
    console.log(`  ── ${id} ${dot(p.enabled)}`);
    console.log(`    model     ${p.model || '(unset)'}`);
    if (id === 'claude' && c) {
      const v = formatUsage(c as never);
      if (v) {
        console.log(`    session   ${v.session}`);
        console.log(
          `    weekly    ${v.week}${v.ageMin != null ? `   (as of ${ago(v.ageMin)})` : ''}`,
        );
      } else {
        console.log(`    session   (no probe yet)`);
        console.log(`    weekly    (no probe yet)`);
      }
    } else {
      const s = c?.session;
      const w = c?.week;
      console.log(
        `    session   ${s?.pct != null ? `${s.pct}%${s.active ? '' : ' (idle)'}` : '(no probe yet)'}`,
      );
      console.log(`    weekly    ${w?.pct != null ? `${w.pct}%` : '(no probe yet)'}`);
    }
    if (c?.lastDecision) {
      const at = c.lastDecision.at.replace('T', ' ').replace(/\..*$/, '');
      console.log(
        `    last      [${at}] TICK [${id}] ${c.lastDecision.action} — ${c.lastDecision.reason}`,
      );
    }
  }
  if (config.scheduler === 'launchd') {
    console.log(
      `  launchd    installed=${s.launchd.installed} loaded=${s.launchd.loaded} enabled=${s.launchd.enabled}`,
    );
  } else {
    console.log(`  cron       installed=${s.cron.installed}`);
  }
  if (s.lastRun) console.log(`  last run   ${s.lastRun.replace(/^\[|\]$/g, '')}`);
}
```

- [ ] **Step 2: Typecheck + manual smoke**

```bash
pnpm run typecheck
node dist/claude-warmup.mjs status
```

Expected: prints one block per enabled provider.

### Task 12: TUI tab strip + per-provider binding

**Files:**

- Modify: `src/ui/App.tsx`
- Modify: `src/ui/useWarmupUi.ts`
- Modify: `src/ui/components/SettingsSection.tsx`
- Modify: `src/ui/components/UsageSection.tsx`
- Modify: `src/ui/model.ts`
- Modify: `test/ui.test.ts`

- [ ] **Step 1: Update `useWarmupUi.ts` to track the selected provider**

```ts
// src/ui/useWarmupUi.ts (add to the state shape)
import { useState } from 'react';

export interface UseWarmupUiState {
  // …existing fields…
  selectedProvider: 'claude' | 'opencode';
  setSelectedProvider: (id: 'claude' | 'opencode') => void;
}
```

(Adjust the existing `useState` calls to include `selectedProvider`; default to the first enabled provider on mount.)

- [ ] **Step 2: Add a tab strip in `App.tsx`**

```tsx
// src/ui/App.tsx (add to the render tree, above the existing sections)
import { Box, Text } from 'ink';
import type { ProviderId } from '../providers/types.js';

interface AppProps {
  selectedProvider: ProviderId;
  onSelectProvider: (id: ProviderId) => void;
  providers: ProviderId[];
}

function ProviderTabs({
  providers,
  selected,
  onSelect,
}: {
  providers: ProviderId[];
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
}) {
  return (
    <Box>
      {providers.map((id) => (
        <Box key={id} marginRight={1}>
          <Text bold={id === selected} inverse={id === selected}>
            {' '}
            {id}{' '}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
```

(Use `useInput` to switch tabs on `←` / `→`.)

- [ ] **Step 3: Bind sections to the selected provider**

In `SettingsSection.tsx` and `UsageSection.tsx`, accept a `providerId` prop and read/mutate `config.providers[providerId]` instead of the top-level `config.model` etc.

- [ ] **Step 4: Update `model.ts` to expose per-provider views**

Add helper `getProviderView(status, id)` returning the rendered strings for one provider.

- [ ] **Step 5: Update `test/ui.test.ts`**

Adjust assertions to the new tab strip. The existing `ui.test.ts` already mocks Ink; add a test that switches between providers and verifies the rendered text contains the right provider id.

- [ ] **Step 6: Commit**

```bash
git add -A src/ui src/print-status.ts src/status.ts src/types.ts test/status.test.ts test/ui.test.ts
git commit -m "feat(ui): per-provider tab strip + bound settings + status view"
```

---

## Phase 9 — Scheduler + CLI subcommands

### Task 13: Update launchd plist generation

**Files:**

- Modify: `src/launchd.ts`

- [ ] **Step 1: Update `intervalsFor` to use the global `tickMinutes`**

```ts
// src/launchd.ts (replace intervalsFor)
function intervalsFor(config: Config): string[] {
  if (config.mode !== 'smart') {
    return config.providerIds.flatMap((id) =>
      config.providers[id].schedule.map((h) => calendarBlock(h)),
    );
  }
  const { tickMinutes } = config;
  // Use the union of all enabled providers' working bands; cheap because the
  // tick iterates each provider with its own workStart/workEnd.
  const bands = config.providerIds
    .filter((id) => config.providers[id].enabled)
    .map((id) => [config.providers[id].workStart, config.providers[id].workEnd] as const);
  const minStart = Math.min(...bands.map(([s]) => s));
  const maxEnd = Math.max(...bands.map(([, e]) => e));
  const out: string[] = [];
  for (let h = minStart; h < maxEnd; h++) {
    for (let m = 0; m < 60; m += tickMinutes) out.push(calendarBlock(h, m));
  }
  return out;
}
```

- [ ] **Step 2: Update `programArgs` to pass `WARMUP_PROVIDERS` in the plist env**

```ts
// src/launchd.ts (in generatePlist, add the WARMUP_PROVIDERS entry to EnvironmentVariables)
const envEntries = [
  `<key>HOME</key><string>${HOME}</string>`,
  `<key>WARMUP_PROVIDERS</key><string>${config.providerIds.join(',')}</string>`,
  `<key>WARMUP_TICK_MINUTES</key><string>${config.tickMinutes}</string>`,
  `<key>WARMUP_SELECTED_PROVIDER</key><string>${config.selectedProvider}</string>`,
].join('\n        ');
```

- [ ] **Step 3: Typecheck + run `test/scheduler.test.ts`**

```bash
pnpm run typecheck
pnpm test -- test/scheduler.test.ts
```

Expected: existing scheduler tests may need adjusting for the new `Config` shape. Update them to read `config.tickMinutes` and `config.providerIds`.

### Task 14: Update cron block

**Files:**

- Modify: `src/cron.ts`

- [ ] **Step 1: Update `buildBlock`**

```ts
// src/cron.ts (in buildBlock)
export function buildBlock(config: Config): string {
  const providers = config.providerIds.join(',');
  const env = `WARMUP_PROVIDERS=${providers} WARMUP_TICK_MINUTES=${config.tickMinutes} WARMUP_SELECTED_PROVIDER=${config.selectedProvider}`;
  let line: string;
  if (config.mode === 'smart') {
    // Use the union band; matches launchd.ts logic.
    const minStart = Math.min(...config.providerIds.map((id) => config.providers[id].workStart));
    const maxEnd = Math.max(...config.providerIds.map((id) => config.providers[id].workEnd));
    const hours = minStart === maxEnd - 1 ? `${minStart}` : `${minStart}-${maxEnd - 1}`;
    const min = config.tickMinutes >= 60 ? '0' : `*/${config.tickMinutes}`;
    line = `${min} ${hours} * * * ${env} ${SELF_INVOCATION.join(' ')} tick >> ${CRON_LOG} 2>&1`;
  } else {
    const hours = config.providerIds
      .flatMap((id) => config.providers[id].schedule)
      .sort((a, b) => a - b);
    line = `0 ${hours.join(',')} * * * ${env} ${SELF_INVOCATION.join(' ')} tick >> ${CRON_LOG} 2>&1`;
  }
  return `${BEGIN}\n${line}\n${END}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add -A src/launchd.ts src/cron.ts
git commit -m "feat(scheduler): multi-provider plist/cron with union working band"
```

### Task 15: CLI subcommands

**Files:**

- Modify: `src/cli.ts`

- [ ] **Step 1: Add the `provider` subcommand and `--provider` flags**

```ts
// src/cli.ts (add to the switch)
case 'provider': {
  const sub = rest[0];
  if (sub === 'list' || sub === undefined) {
    const c = loadConfig();
    for (const id of c.providerIds) {
      console.log(`${id}  ${c.providers[id].enabled ? 'enabled' : 'disabled'}`);
    }
    return;
  }
  const id = rest[0] as 'claude' | 'opencode';
  if (!['claude', 'opencode'].includes(id)) {
    console.error('provider must be one of: claude, opencode');
    process.exit(1);
  }
  const action = rest[1];
  const c = loadConfig();
  if (action === 'enable') {
    saveConfig({ ...c, providers: { ...c.providers, [id]: { ...c.providers[id], enabled: true } } });
    console.log(`✓ ${id} enabled`);
  } else if (action === 'disable') {
    saveConfig({ ...c, providers: { ...c.providers, [id]: { ...c.providers[id], enabled: false } } });
    console.log(`✓ ${id} disabled`);
  } else if (action === 'model' && rest[2]) {
    saveConfig({ ...c, providers: { ...c.providers, [id]: { ...c.providers[id], model: rest[2] } } });
    console.log(`✓ ${id} model: ${rest[2]}`);
  } else {
    console.error('usage: claude-warmup provider <id> [enable|disable|model <name>]');
    process.exit(1);
  }
  break;
}
```

- [ ] **Step 2: Add `--provider` to `tick` and `usage`**

```ts
// src/cli.ts (modify the tick case)
case 'tick': {
  const providerIdx = rest.indexOf('--provider');
  const onlyProvider = providerIdx >= 0 ? (rest[providerIdx + 1] as 'claude' | 'opencode' | undefined) : undefined;
  const r = runTick({ dryRun: rest.includes('--dry-run') || rest.includes('-n'), onlyProvider });
  for (const item of r) {
    console.log(`[${item.id}] ${item.decision.action} — ${item.decision.reason}`);
  }
  process.exit(r.some((x) => x.decision.action === 'warm' && x.status !== 0) ? 1 : 0);
}

// modify the usage case
case 'usage': {
  const providerIdx = rest.indexOf('--provider');
  const onlyProvider = providerIdx >= 0 ? (rest[providerIdx + 1] as 'claude' | 'opencode' | undefined) : undefined;
  // …call into a per-provider probe…
  break;
}
```

- [ ] **Step 3: Update `mode`, `model`, `schedule`, `scheduler` to mutate the selected provider**

The selected provider is `config.selectedProvider`. The existing `saveField` calls save the whole config; the mutation targets the selected provider's stanza. (Each subcommand's body mutates `c.providers[c.selectedProvider].<field>` instead of the top-level field.)

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A src/cli.ts
git commit -m "feat(cli): provider subcommand + --provider flag for tick/usage"
```

---

## Phase 10 — Docs + examples

### Task 16: Update `.env.example` and `README.md`

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Rewrite `.env.example` to the new schema**

```bash
# claude-warmup — example configuration (multi-provider)
# See docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md

# ── Shared ────────────────────────────────────────────────────────────
WARMUP_MODE=smart
WARMUP_SCHEDULER=launchd
WARMUP_TICK_MINUTES=30
WARMUP_PROVIDERS=claude,opencode
WARMUP_SELECTED_PROVIDER=claude

# ── claude ────────────────────────────────────────────────────────────
WARMUP_CLAUDE_ENABLED=true
WARMUP_CLAUDE_BIN=~/.local/bin/claude
WARMUP_CLAUDE_MODEL=haiku
WARMUP_CLAUDE_TMUX_SESSION=claude-warmup
WARMUP_CLAUDE_WORK_START=8
WARMUP_CLAUDE_WORK_END=23
WARMUP_CLAUDE_WEEKLY_STOP_PERCENT=90
# WARMUP_CLAUDE_SCHEDULE=8,13,18

# ── opencode ──────────────────────────────────────────────────────────
WARMUP_OPENCODE_ENABLED=true
WARMUP_OPENCODE_BIN=~/.local/bin/opencode
# WARMUP_OPENCODE_MODEL=         # required; pick your cheapest model
WARMUP_OPENCODE_TMUX_SESSION=opencode-warmup
WARMUP_OPENCODE_WORK_START=7
WARMUP_OPENCODE_WORK_END=22
WARMUP_OPENCODE_WEEKLY_STOP_PERCENT=85
# WARMUP_OPENCODE_SCHEDULE=9,14,19
```

- [ ] **Step 2: Add a "Multi-provider" section to `README.md`**

After the existing "Smart mode" section, add:

```markdown
## Multi-provider

The warmup can keep more than one CLI's usage window warm from a single
scheduler. Each provider has its own binary, model, working band, weekly
cutoff, schedule, and usage cache. The tick iterates enabled providers in
`WARMUP_PROVIDERS` order; each provider's `decide` runs against its own
config and its own last probe.

To enable opencode alongside claude:

1. `claude-warmup provider opencode enable`
2. `claude-warmup provider opencode model <your-cheapest-model>`
3. `claude-warmup restart`

`claude-warmup status` shows one block per enabled provider.
`claude-warmup tick` runs one decision per enabled provider.
`claude-warmup tick --provider opencode` runs one provider only.
`claude-warmup usage --provider opencode` probes one provider.

The two providers run from a single plist/cron entry; nothing to
schedule twice. To disable a provider, `claude-warmup provider <id> disable`.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: multi-provider schema and quickstart in README"
```

---

## Phase 11 — Final verification

### Task 17: `pnpm check` + smoke test

- [ ] **Step 1: Run the full check**

```bash
pnpm check
```

Expected: typecheck, lint, format, and tests all pass.

- [ ] **Step 2: Smoke test: claude-only flow (regression)**

```bash
# With WARMUP_PROVIDERS absent, the legacy env shape must keep working.
mkdir -p /tmp/warmup-smoke
WARMUP_HOME=/tmp/warmup-smoke node dist/claude-warmup.mjs start
sleep 1
WARMUP_HOME=/tmp/warmup-smoke node dist/claude-warmup.mjs status
WARMUP_HOME=/tmp/warmup-smoke node dist/claude-warmup.mjs tick --dry-run
WARMUP_HOME=/tmp/warmup-smoke node dist/claude-warmup.mjs stop
```

Expected: `start` reports "installed and loaded"; `status` shows a single `claude` block; `tick --dry-run` logs one `TICK [claude] …` line and exits 0; `stop` removes the scheduler.

- [ ] **Step 3: Smoke test: multi-provider flow (new)**

```bash
# With WARMUP_PROVIDERS=claude,opencode (opencode model intentionally unset).
WARMUP_PROVIDERS=claude,opencode WARMUP_OPENCODE_BIN=/nonexistent \
  WARMUP_HOME=/tmp/warmup-smoke \
  node dist/claude-warmup.mjs status
WARMUP_PROVIDERS=claude,opencode WARMUP_OPENCODE_BIN=/nonexistent \
  WARMUP_HOME=/tmp/warmup-smoke \
  node dist/claude-warmup.mjs tick --dry-run
```

Expected: `status` prints a `claude` block and an `opencode` block (with `model (unset)`); `tick --dry-run` logs one `TICK [claude] …` line and one `TICK [opencode] …` line.

- [ ] **Step 4: Confirm the `.bak` is created on first save**

```bash
ls -la /tmp/warmup-smoke/warmup.env /tmp/warmup-smoke/warmup.env.bak 2>/dev/null
```

Expected: if the smoke test wrote at least one config (via `provider opencode enable` or similar), the `.bak` exists with the previous content.

- [ ] **Step 5: Commit any leftover fixes**

```bash
git status
git add -A
git diff --cached --quiet || git commit -m "chore: post-verification tweaks"
```

---

## Self-review

**Spec coverage:**

- Goal (§1) → Phase 1 (types) + Phase 2 (claude move) + Phase 3 (config) + Phase 6 (tick).
- Non-goals → no tasks; explicit in spec.
- Config schema (§1 of spec) → Task 6.
- Provider abstraction (§2) → Tasks 1–2.
- Tick multi-provider (§3) → Task 8.
- Arm scripts (§4) → Tasks 7, 9.
- Scheduler (§5) → Tasks 13, 14.
- Cache per-provider (§6) → Task 8 (creates `usage-cache.ts`).
- TUI/status (§7) → Tasks 10–12.
- Subcommand surface (§8) → Task 15.
- Backward compat (§9) → Task 6 (silent migration) + Task 17 (smoke test).
- Error handling (§10) → covered by `inferFromCacheFor` (Task 8) and arm script exit codes.
- Testing (§11) → moved tests (Tasks 3, 4), new tests (Tasks 6, 8, 10, 15), smoke (Task 17).
- File-by-file change map (§12) → Tasks 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16.

**Placeholders remaining (intentional, in code, not in the plan):**

- `src/providers/opencode.ts` contains `<<< PASTE PROBE COMMAND FROM SPIKE >>>` and `<<< PASTE … FLAGS … >>>` markers. These are the spike's job (Phase 0, Task 0). The plan is complete without them being filled in; the implementer fills them when writing Task 9.
- `src/providers/opencode/probe.ts` contains `<<< LABEL FROM SPIKE >>>` markers. Same deal.

**Type consistency:**

- `Provider` interface → used by all `src/providers/<id>.ts` (Tasks 3, 9).
- `ProviderConfig` → used by `config.ts` (Task 6), `claude.ts` (Task 3), `opencode.ts` (Task 9), `tick.ts` (Task 8), `status.ts` (Task 10).
- `UsageCache` (legacy) → used by `usage-cache.ts` (Task 8) and `status.ts` (Task 10).
- `ProviderId` → `'claude' | 'opencode'`. Used by `index.ts` (Task 2), `claude.ts`, `opencode.ts`, `tick.ts`, `usage-cache.ts`, `cli.ts`, `status.ts`, TUI files.

**Open questions for the implementer (resolved during the plan):**

- A-1 (architecture) → fixed at "unified single binary" by spec.
- A-2 (binary name) → kept `claude-warmup`.
- A-3 (per-provider smart tunables) → addressed by `ProviderConfig.workStart/workEnd/weeklyStopPercent`.
- A-4 (opencode probe shape) → resolved by the Phase 0 spike.
- A-5 (opencode session + weekly) → `decide` has both branches; spike may set one to `null`.
- A-6 (default opencode model) → kept empty; user picks.
