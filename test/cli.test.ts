import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { armScript, CLI_ARGV, sandbox, type Sandbox } from './helpers/sandbox.js';

// The multi-provider entry points end to end: `tick` and `run` over two enabled
// agents. What a single agent decides is tick.test.ts's job; this file covers what
// only shows up with more than one — concurrency, per-agent output prefixes and
// failure isolation.

// A stub arm script, wired in through WARMUP_<ID>_SCRIPT, so the run path can be
// exercised without spending anyone's real quota.
const ECHO_STUB = 'echo "ARMED ${WARMUP_PROVIDER}"';

// A stub that only succeeds if BOTH agents are running at the same time: each waits
// (up to 5s) for the other's start marker. A sequential runner would let the first
// agent time out (exit 3), so a pass proves the arms overlapped.
const CONCURRENT_STUB = [
  'touch "$WARMUP_HOME/started-$WARMUP_PROVIDER"',
  'for _ in $(seq 1 50); do',
  '  [ -e "$WARMUP_HOME/started-codex" ] && [ -e "$WARMUP_HOME/started-kimi" ] && break',
  '  sleep 0.1',
  'done',
  '[ -e "$WARMUP_HOME/started-codex" ] && [ -e "$WARMUP_HOME/started-kimi" ] || exit 3',
  ECHO_STUB,
].join('\n');

const BOTH_ENABLED = [
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=codex,kimi',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
];

/** A sandbox with codex+kimi enabled, both armed by the same stub script. */
function twoAgents(mode: 'smart' | 'fixed', script: string, extra: string[] = []): Sandbox {
  const stub = armScript(`#!/usr/bin/env bash\n${script}\n`);
  return sandbox({
    envLines: [`WARMUP_MODE=${mode}`, ...BOTH_ENABLED, ...extra],
    env: { WARMUP_CODEX_SCRIPT: stub, WARMUP_KIMI_SCRIPT: stub },
  });
}

/** Fixed-mode scheduling that puts both agents' next slot at the current hour. */
const scheduledNow = (): string[] => {
  const hour = new Date().getHours();
  return [`WARMUP_CODEX_SCHEDULE=${hour}`, `WARMUP_KIMI_SCHEDULE=${hour}`];
};

const readCache = (s: Sandbox) =>
  JSON.parse(fs.readFileSync(path.join(s.warmupHome, 'usage-cache.json'), 'utf8'));

test('a tick visits every enabled provider, and --provider narrows it to one', () => {
  const s = twoAgents('fixed', ECHO_STUB, scheduledNow());

  const all = s.run('tick', '--dry-run');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /^\[codex\] warm/m);
  assert.match(all.stdout, /^\[kimi\] warm/m);

  const one = s.run('tick', '--dry-run', '--provider', 'codex');
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^\[codex\] warm/m);
  assert.doesNotMatch(one.stdout, /^\[kimi\]/m);
});

test('enabled agents arm concurrently, and one failure neither cancels nor hides the rest', () => {
  const s = twoAgents('smart', `${CONCURRENT_STUB}\n[ "$WARMUP_PROVIDER" != kimi ] || exit 1`);
  const result = s.run('run');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Output is prefixed per agent so the interleaved lines stay attributable.
  assert.match(result.stdout, /^\[codex\] ARMED codex$/m);
  assert.match(result.stdout, /^\[kimi\] ARMED kimi$/m);
  assert.match(result.stdout, /^✓ codex$/m);
  assert.match(result.stdout, /^✗ kimi failed \(status 1\)$/m);
  // The failing agent gets its failure recorded; the healthy one its arm.
  const cache = readCache(s);
  assert.ok(cache.providers.codex.lastWarmAt > 0);
  assert.ok(cache.providers.kimi.lastFailureAt > 0);
  assert.equal(cache.providers.kimi.lastWarmAt, undefined);
});

test('a scheduler tick probes, decides and arms every provider concurrently', () => {
  const s = twoAgents('fixed', CONCURRENT_STUB, scheduledNow());
  const result = s.run('tick');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[codex\] ARMED codex$/m);
  assert.match(result.stdout, /^\[kimi\] ARMED kimi$/m);
  const log = fs.readFileSync(path.join(s.warmupHome, 'logs', 'warmup.log'), 'utf8');
  assert.match(log, /TICK \[codex\] warm — scheduled for/);
  assert.match(log, /TICK \[kimi\] warm — scheduled for/);
});

test('an unqualified run warms every enabled agent and exits clean', () => {
  const s = twoAgents('smart', ECHO_STUB);
  const result = s.run('run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARMED codex/);
  assert.match(result.stdout, /ARMED kimi/);
});

test('--provider limits a run to one agent and only records that agent’s arm', () => {
  const s = twoAgents('smart', ECHO_STUB);
  const result = s.run('run', '--provider', 'kimi');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARMED kimi/);
  assert.doesNotMatch(result.stdout, /ARMED codex/);
  // A manual run records lastWarmAt, so estimated usage shows the window as active.
  const cache = readCache(s);
  assert.ok(cache.providers.kimi.lastWarmAt > 0);
  assert.equal(cache.providers.codex, undefined);
});

// migrateLegacyHome() moves a real directory, so it needs a fake HOME and no
// WARMUP_HOME — which is exactly what the sandbox always sets. Hence a raw spawn.
// (paths.test.ts covers the two cases where it must decline to move anything.)
test('a legacy ~/.claude/warmup home is moved to ~/.agent-warmup on startup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-home-'));
  const legacy = path.join(home, '.claude', 'warmup');
  fs.mkdirSync(path.join(legacy, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'warmup.env'), 'WARMUP_MODE=fixed\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.WARMUP_HOME;
  const result = spawnSync(process.execPath, [...CLI_ARGV, 'help'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /moved .*\.claude\/warmup → .*\.agent-warmup/);
  const moved = path.join(home, '.agent-warmup', 'warmup.env');
  assert.ok(fs.existsSync(moved));
  assert.ok(!fs.existsSync(legacy));
  assert.ok(result.stdout.includes(moved), 'help should list the new config path');
});

// A fresh install has no WARMUP_HOME at all: the first CLI run must leave an
// editable warmup.env behind, or the path printed by `help` points at nothing.
test('the first run seeds an editable warmup.env under a fresh home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-seed-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.WARMUP_HOME;
  const cfg = path.join(home, '.agent-warmup', 'warmup.env');

  const first = spawnSync(process.execPath, [...CLI_ARGV, 'help'], { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(
    first.stderr,
    new RegExp(`created ${cfg.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`),
  );
  assert.match(fs.readFileSync(cfg, 'utf8'), /WARMUP_PROVIDERS=claude/);

  // Second run keeps the user's edits.
  fs.appendFileSync(cfg, '\nWARMUP_CLAUDE_MODEL=opus\n');
  const second = spawnSync(process.execPath, [...CLI_ARGV, 'help'], { encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /created/);
  assert.match(fs.readFileSync(cfg, 'utf8'), /WARMUP_CLAUDE_MODEL=opus/);
});
