import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProviderId } from '../src/types.js';

// runner.ts pins WARMUP_HOME, the arm-script overrides and the log path at import
// time, so the sandbox has to exist before the module graph loads — hence the
// dynamic import below.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-runner-'));
const arm = (name: string, body: string): string => {
  const file = path.join(HOME_DIR, `${name}.sh`);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};
const OK_STUB = arm('ok', 'echo "ARMED $WARMUP_PROVIDER session=$WARMUP_TMUX_SESSION"');
const FAIL_STUB = arm('fail', 'echo boom >&2\nexit 7');
const CLAUDE_STUB = arm('claude', 'echo "ARMED claude"');
process.env.WARMUP_HOME = HOME_DIR;
process.env.WARMUP_CODEX_SCRIPT = OK_STUB;
process.env.WARMUP_KIMI_SCRIPT = FAIL_STUB;
process.env.WARMUP_CLAUDE_SCRIPT = CLAUDE_STUB;

const { runNow, runEnabled, viewLogs, lastRunSummary } = await import('../src/runner.js');
const { readCache, writeCache } = await import('../src/cache.js');
const { WARMUP_LOG } = await import('../src/paths.js');

function writeConfig(lines: string[]): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, 'warmup.env'), lines.join('\n') + '\n');
}

// runNow streams the arm output through process.stdout/stderr; swap both for
// collectors so the tests stay quiet. Under `node --test` the runner's own event
// stream shares those fds and interleaves into the collector, so assertions use
// `includes` (the arm lines are written whole, never split) instead of anchors.
async function captureIO(
  fn: () => number | Promise<number>,
): Promise<{ status: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const grab =
    (buf: string[]) =>
    (chunk: unknown): boolean => {
      buf.push(String(chunk));
      return true;
    };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = grab(out) as typeof process.stdout.write;
  process.stderr.write = grab(err) as typeof process.stderr.write;
  try {
    const status = await fn();
    return { status, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const TWO_AGENTS = [
  'WARMUP_PROVIDERS=codex,kimi',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
];

test('runNow arms the script with the provider env and records the warm', async () => {
  writeConfig(TWO_AGENTS);
  writeCache({ providers: {} });
  const { status, out } = await captureIO(() => runNow('codex', new Date('2026-09-05T10:00:00Z')));
  assert.equal(status, 0);
  // Output carries the `[id]` prefix and the env the arm script needs arrived.
  assert.ok(out.includes('[codex] ARMED codex session=codex-warmup'));
  assert.ok(readCache().providers.codex!.lastWarmAt, 'the warm is recorded in the cache');
});

test('runNow refuses an unknown and a disabled provider', async () => {
  const unknownId = 'gemini' as string as ProviderId;
  const unknown = await captureIO(() => runNow(unknownId));
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /✗ no such provider: gemini/);

  // claude is in every config's provider map, but TWO_AGENTS leaves it disabled.
  const disabled = await captureIO(() => runNow('claude'));
  assert.equal(disabled.status, 1);
  assert.match(disabled.err, /✗ provider claude is disabled/);
});

test('runEnabled warms every enabled agent; one failure fails the run, not the rest', async () => {
  writeConfig(TWO_AGENTS);
  writeCache({ providers: {} });
  const { status, out, err } = await captureIO(() => runEnabled());
  assert.equal(status, 7, 'the first failing status is returned');
  assert.ok(out.includes('[codex] ARMED codex'), 'the healthy agent still armed');
  assert.ok(err.includes('[kimi] boom'), 'the failure is streamed under its own prefix');
  // The per-agent summary is where a failure survives the interleaved output.
  assert.ok(out.includes('✓ codex'));
  assert.ok(out.includes('✗ kimi failed (status 7)'));
  const cache = readCache();
  assert.ok(cache.providers.codex!.lastWarmAt);
  assert.ok(cache.providers.kimi!.lastFailureAt, 'the failure is recorded for the breaker');
  assert.equal(cache.providers.kimi!.lastWarmAt, undefined);
});

test('a provider without arm-result bookkeeping still gets its warm recorded', async () => {
  // claude records arms the plain way (no cooldown bookkeeping): enabled + stub.
  writeConfig([
    'WARMUP_PROVIDERS=claude',
    'WARMUP_SELECTED_PROVIDER=claude',
    'WARMUP_CLAUDE_ENABLED=true',
  ]);
  writeCache({ providers: {} });
  const { status, out } = await captureIO(() => runNow('claude'));
  assert.equal(status, 0);
  assert.ok(out.includes('[claude] ARMED claude'));
  assert.ok(readCache().providers.claude!.lastWarmAt);
});

test('lastRunSummary reads the newest status line, tolerating missing and empty logs', () => {
  fs.rmSync(WARMUP_LOG, { force: true });
  assert.equal(lastRunSummary(), null);

  fs.mkdirSync(path.dirname(WARMUP_LOG), { recursive: true });
  fs.writeFileSync(
    WARMUP_LOG,
    ['[2026-09-05 09:00:00] OK: codex armed', '[2026-09-05 09:30:00] plain noise'].join('\n'),
  );
  assert.equal(lastRunSummary(), '[2026-09-05 09:00:00] OK: codex armed');

  fs.writeFileSync(WARMUP_LOG, 'only an unmarked line');
  assert.equal(lastRunSummary(), 'only an unmarked line');

  fs.writeFileSync(WARMUP_LOG, '');
  assert.equal(lastRunSummary(), null);
});

test('viewLogs reports an empty history and tails an existing log', async () => {
  fs.rmSync(WARMUP_LOG, { force: true });
  const empty = await captureIO(() => viewLogs(false));
  assert.equal(empty.status, 0);
  assert.match(empty.out, /No logs yet — run a warmup first\./);

  fs.mkdirSync(path.dirname(WARMUP_LOG), { recursive: true });
  fs.writeFileSync(WARMUP_LOG, '[2026-09-05 10:00:00] TICK [codex] warm\n');
  // No TTY in a test process, so this is the `tail` fallback (never `tail -f`).
  assert.equal(await captureIO(() => viewLogs(false)).then((r) => r.status), 0);
});
