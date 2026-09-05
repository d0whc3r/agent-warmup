import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { sandbox, type Sandbox } from './helpers/sandbox.js';

// Smart-mode ticks end to end: what the tick decides, what it writes to the cache
// and the log, and whether it actually arms. `kimi` is the subject throughout —
// it has no live probe, so every decision comes from the cache and the clock,
// which makes the outcomes deterministic.
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ARM_STUB = armScript('#!/usr/bin/env bash\necho "ARMED $WARMUP_PROVIDER"\n');

// Arm scripts are wired in through WARMUP_<ID>_SCRIPT, so a tick can be driven end
// to end without spending anyone's real quota.
function armScript(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-arm-')), 'arm.sh');
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function smartSandbox(overrides: readonly string[] = []): Sandbox {
  return sandbox({
    envLines: [
      'WARMUP_MODE=smart',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_TICK_MINUTES=30',
      'WARMUP_PROVIDERS=kimi',
      'WARMUP_SELECTED_PROVIDER=kimi',
      'WARMUP_CLAUDE_ENABLED=false',
      'WARMUP_KIMI_ENABLED=true',
      // A band that always contains "now", unless a test narrows it.
      'WARMUP_KIMI_WORK_START=0',
      'WARMUP_KIMI_WORK_END=24',
      'WARMUP_KIMI_WEEKLY_STOP_PERCENT=90',
      ...overrides,
    ],
    env: { WARMUP_KIMI_SCRIPT: ARM_STUB },
  });
}

const cacheFile = (s: Sandbox) => path.join(s.warmupHome, 'usage-cache.json');
const readCache = (s: Sandbox) => JSON.parse(fs.readFileSync(cacheFile(s), 'utf8'));
const readLog = (s: Sandbox) =>
  fs.readFileSync(path.join(s.warmupHome, 'logs', 'warmup.log'), 'utf8');

function seedCache(s: Sandbox, entry: Record<string, unknown>): void {
  fs.mkdirSync(s.warmupHome, { recursive: true });
  fs.writeFileSync(cacheFile(s), JSON.stringify({ providers: { kimi: entry } }));
}

test('an idle window warms the agent and records the arm', () => {
  const s = smartSandbox();
  const result = s.run('tick');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[kimi\] warm — no recent warmup \(usage estimated\)$/m);
  assert.match(result.stdout, /^\[kimi\] ARMED kimi$/m);
  assert.ok(readCache(s).providers.kimi.lastWarmAt > 0);
  // The decision is logged before the arm, with the source it came from.
  assert.match(readLog(s), /TICK \[kimi\] warm — no recent warmup .* \[via cache\]/);
});

test('--dry-run decides and logs but never arms', () => {
  const s = smartSandbox();
  const result = s.run('tick', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[kimi\] warm —/m);
  assert.doesNotMatch(result.stdout, /ARMED/);
  assert.match(readLog(s), /TICK \[kimi\] warm \(dry-run\) —/);
  assert.equal(readCache(s).providers.kimi.lastWarmAt, undefined);
  // The decision is still persisted, so the TUI can show what the last tick thought.
  assert.equal(readCache(s).providers.kimi.lastDecision.action, 'warm');
  // -n is the short form.
  assert.doesNotMatch(s.run('tick', '-n').stdout, /ARMED/);
});

test('a recent arm keeps the tick from re-arming inside the same window', () => {
  const s = smartSandbox();
  seedCache(s, { lastWarmAt: Date.now() - 60_000 });
  const result = s.run('tick');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[kimi\] skip-active — window likely active \(cache-derived\)$/m);
  assert.doesNotMatch(result.stdout, /ARMED/);
});

test('an arm older than the five-hour window warms again', () => {
  const s = smartSandbox();
  seedCache(s, { lastWarmAt: Date.now() - FIVE_HOURS_MS - 60_000 });
  assert.match(s.run('tick').stdout, /^\[kimi\] warm —/m);
});

test('the weekly stop percentage halts warming before the quota runs out', () => {
  const s = smartSandbox();
  seedCache(s, { week: { pct: 95 } });
  const result = s.run('tick');
  assert.match(result.stdout, /^\[kimi\] skip-weekly — weekly 95% >= 90%$/m);
  assert.doesNotMatch(result.stdout, /ARMED/);
});

test('outside the work band the tick skips without touching the agent', () => {
  const hour = new Date().getHours();
  // A one-hour band that cannot contain "now".
  const away = (hour + 3) % 24;
  const s = smartSandbox([
    `WARMUP_KIMI_WORK_START=${away}`,
    `WARMUP_KIMI_WORK_END=${(away + 1) % 24 || 24}`,
  ]);
  const result = s.run('tick');
  assert.match(result.stdout, /^\[kimi\] skip-offhours — outside working hours /m);
  assert.doesNotMatch(result.stdout, /ARMED/);
});

test('a failing arm surfaces its status as the tick exit code', () => {
  const failing = armScript('#!/usr/bin/env bash\nexit 2\n');
  const s = sandbox({
    envLines: [
      'WARMUP_MODE=smart',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_PROVIDERS=kimi',
      'WARMUP_SELECTED_PROVIDER=kimi',
      'WARMUP_CLAUDE_ENABLED=false',
      'WARMUP_KIMI_ENABLED=true',
      'WARMUP_KIMI_WORK_START=0',
      'WARMUP_KIMI_WORK_END=24',
    ],
    env: { WARMUP_KIMI_SCRIPT: failing },
  });
  const result = s.run('tick');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  // The failure is remembered so a second one trips the circuit breaker.
  const entry = readCache(s).providers.kimi;
  assert.ok(entry.lastFailureAt > 0);
  assert.equal(entry.lastWarmAt, undefined);
});

test('a missing arm script fails the run instead of reporting success', () => {
  const s = sandbox({
    envLines: [
      'WARMUP_MODE=smart',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_PROVIDERS=kimi',
      'WARMUP_SELECTED_PROVIDER=kimi',
      'WARMUP_CLAUDE_ENABLED=false',
      'WARMUP_KIMI_ENABLED=true',
    ],
    env: { WARMUP_KIMI_SCRIPT: '/nonexistent/arm.sh' },
  });
  const result = s.run('run', '--provider', 'kimi');
  assert.notEqual(result.status, 0);
});
