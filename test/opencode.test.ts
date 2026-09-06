import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_MULTI } from '../src/config.js';
import { getProvider } from '../src/providers/index.js';
import { parseStatsCost, probe } from '../src/providers/opencode.js';
import type { ProbeContext } from '../src/providers/types.js';
import type { ProviderUsage } from '../src/types.js';

// A realistic `opencode stats --days 7 --models 1` capture. The model column
// is left-padded; the cost column is right-padded; values use the
// $X.YY format that `opencode stats` emits on the current build.
const SAMPLE = `OpenCode Go weekly stats (2026-06-15 → 2026-06-22):
  claude-sonnet-4           42,300 in / 18,200 out   $4.21
  opencode-go/deepseek-v4-flash     1,234 in / 567 out   $0.12
  gpt-4o                    120 in / 90 out   $0.05
`;

test('parseStatsCost reads the $X.YY format (regression: $ must be escaped)', () => {
  // Pre-fix, the first regex was /$\s*([0-9]+...)/ — in JS `$` is the
  // end-of-string anchor, so $0.12 / $1.23 / $4.21 always returned null and
  // the probe silently fell back to "no usage yet" (skipping the weekly cap
  // check entirely). Locking the fix in.
  assert.equal(parseStatsCost(SAMPLE, 'opencode-go/deepseek-v4-flash'), 0.12);
  assert.equal(parseStatsCost(SAMPLE, 'gpt-4o'), 0.05);
  assert.equal(parseStatsCost(SAMPLE, 'claude-sonnet-4'), 4.21);
});

test('parseStatsCost also accepts the USD X.YY format', () => {
  // Future-proofs against opencode changing its format to spell out "USD"
  // (the comment in opencode.ts explicitly says both shapes are expected).
  const usd = '  gpt-4o     120 in / 90 out   USD 4.56\n';
  assert.equal(parseStatsCost(usd, 'gpt-4o'), 4.56);
  // No space between USD and the number should still match.
  const usdTight = '  gpt-4o     120 in / 90 out   USD4.56\n';
  assert.equal(parseStatsCost(usdTight, 'gpt-4o'), 4.56);
});

test('parseStatsCost strips the opencode-go/ prefix before matching', () => {
  // WARMUP_OPENCODE_MODEL is conventionally "opencode-go/<model>"; the parser
  // slices the prefix so a needle of either form finds the row.
  const withPrefix = parseStatsCost(SAMPLE, 'opencode-go/deepseek-v4-flash');
  const bare = parseStatsCost(SAMPLE, 'deepseek-v4-flash');
  assert.equal(withPrefix, bare);
  assert.equal(bare, 0.12);
});

test('parseStatsCost returns null when the model is not in the output', () => {
  assert.equal(parseStatsCost(SAMPLE, 'no-such-model'), null);
});

test('parseStatsCost returns null for empty input', () => {
  assert.equal(parseStatsCost('', 'deepseek-v4-flash'), null);
  // A line with the right model name but no cost also returns null.
  assert.equal(
    parseStatsCost('  deepseek-v4-flash      1,234 in / 567 out\n', 'deepseek-v4-flash'),
    null,
  );
});

test('parseStatsCost handles whole-dollar amounts (no decimals)', () => {
  const out = '  deepseek-v4-flash      1,234 in / 567 out   $1\n';
  assert.equal(parseStatsCost(out, 'deepseek-v4-flash'), 1);
});

// Verbatim from `opencode stats --days 7 --models 1` on v1.18.20. The flat one-row-
// per-model layout the parser was written against is gone: each model now heads a
// block of label/value rows and its spend sits on the "Cost" row several lines down,
// so the same-line match returned null for every model and the weekly cap check
// silently stopped running.
const BOXED = `┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                        $9.99 │
│Avg Cost/Day                                      $1.42 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                      MODEL USAGE                       │
├────────────────────────────────────────────────────────┤
│ opencode-go/deepseek-v4-flash                          │
│  Messages                                            1 │
│  Input Tokens                                        0 │
│  Output Tokens                                       0 │
│  Cache Read                                          0 │
│  Cache Write                                         0 │
│  Cost                                          $7.5000 │
├────────────────────────────────────────────────────────┤
│ opencode-go/glm-5.3-flash                              │
│  Messages                                            4 │
│  Input Tokens                                    1,024 │
│  Output Tokens                                     256 │
│  Cache Read                                          0 │
│  Cache Write                                         0 │
│  Cost                                          $1.2500 │
└────────────────────────────────────────────────────────┘
`;

test('parseStatsCost reads the boxed per-model layout (opencode >= 1.18)', () => {
  assert.equal(parseStatsCost(BOXED, 'opencode-go/deepseek-v4-flash'), 7.5);
  // The second block must report its own Cost row, not the first block's.
  assert.equal(parseStatsCost(BOXED, 'opencode-go/glm-5.3-flash'), 1.25);
  // "Total Cost" belongs to the summary box and must never stand in for a model.
  assert.equal(parseStatsCost(BOXED, 'opencode-go/no-such-model'), null);
});

test('parseStatsCost strips thousands separators', () => {
  const out = '  deepseek-v4-flash      1,234 in / 567 out   $1,234.50\n';
  assert.equal(parseStatsCost(out, 'deepseek-v4-flash'), 1234.5);
});

// The probe itself: `opencode stats` is spawned for real against a stub binary, so
// the mapping from a dollar figure to the weekly percentage stays covered.
function stubOpencode(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-opencode-'));
  const file = path.join(dir, 'opencode');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function ctxFor(binary: string, model = 'opencode-go/deepseek-v4-flash'): ProbeContext {
  return {
    cfg: { ...DEFAULT_MULTI.providers.opencode!, binary, model },
    shared: DEFAULT_MULTI.shared,
    now: new Date('2026-09-05T10:00:00Z'),
  };
}

test('probe maps the model spend onto the weekly $30 cap', () => {
  // $7.50 of a $30 weekly plan is 25%.
  const bin = stubOpencode(
    `[ "$1" = "--version" ] && exit 0\necho '  opencode-go/deepseek-v4-flash  1 in / 2 out   $7.50'`,
  );
  const usage = probe(ctxFor(bin));
  assert.equal(usage?.week?.pct, 25);
  // The five-hour window is not queryable from the CLI, so it stays unknown and
  // the cache-based fallback decides.
  assert.equal(usage?.session, null);
  assert.equal(usage?.capturedAt, Date.parse('2026-09-05T10:00:00Z'));
});

test('probe caps the weekly percentage at 100 rather than reporting over-spend', () => {
  const bin = stubOpencode(
    `[ "$1" = "--version" ] && exit 0\necho '  opencode-go/deepseek-v4-flash  1 in / 2 out   $45.00'`,
  );
  assert.equal(probe(ctxFor(bin))?.week?.pct, 100);
});

test('probe returns an "estimated" snapshot when the model has no recorded spend', () => {
  const bin = stubOpencode('[ "$1" = "--version" ] && exit 0\necho "no usage yet"');
  const usage = probe(ctxFor(bin));
  assert.equal(usage?.inferred, true);
  assert.equal(usage?.week, null);
});

test('probe gives up when the binary is missing or the stats call fails', () => {
  assert.equal(probe(ctxFor('/nonexistent/opencode')), null);
  const failing = stubOpencode('[ "$1" = "--version" ] && exit 0\nexit 3');
  assert.equal(probe(ctxFor(failing)), null);
});

// decide() reads the cache signals the tick injects (lastWarmAt, cooldownUntil);
// these pin the order in which they short-circuit.
const opencode = getProvider('opencode');
const decideCtx = (hour: number): ProbeContext => ({
  cfg: { ...DEFAULT_MULTI.providers.opencode!, workStart: 8, workEnd: 23, weeklyStopPercent: 90 },
  shared: { ...DEFAULT_MULTI.shared, mode: 'smart' },
  now: new Date(2026, 8, 5, hour),
});

test('opencode decide: offhours, weekly cap, cooldown and cache window in order', () => {
  assert.equal(opencode.decide(decideCtx(3), null).action, 'skip-offhours');
  assert.equal(
    opencode.decide(decideCtx(12), { session: null, week: { pct: 95 } }).action,
    'skip-weekly',
  );

  const at = decideCtx(12).now.getTime();
  const enriched = (over: object): ProviderUsage =>
    ({ session: null, week: null, ...over }) as ProviderUsage;

  // An active cooldown wins, reporting the remaining minutes.
  const cooldown = enriched({ cooldownUntil: at + 30 * 60_000 });
  assert.match(opencode.decide(decideCtx(12), cooldown).reason, /cooldown \(30m remaining\)/);

  // An expired cooldown falls through to the cache-derived five-hour window.
  const expired = enriched({ cooldownUntil: at - 1000, lastWarmAt: at - 3_600_000 });
  assert.equal(opencode.decide(decideCtx(12), expired).action, 'skip-active');

  // No signals at all -> warm.
  assert.equal(opencode.decide(decideCtx(12), enriched({})).action, 'warm');
});
