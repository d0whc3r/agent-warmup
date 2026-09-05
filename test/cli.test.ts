import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.ts');

function runTick(provider?: string) {
  const warmupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-cli-'));
  const hour = new Date().getHours();
  fs.writeFileSync(
    path.join(warmupHome, 'warmup.env'),
    [
      'WARMUP_MODE=fixed',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_PROVIDERS=codex,kimi',
      'WARMUP_SELECTED_PROVIDER=codex',
      'WARMUP_CODEX_ENABLED=true',
      `WARMUP_CODEX_SCHEDULE=${hour}`,
      'WARMUP_KIMI_ENABLED=true',
      `WARMUP_KIMI_SCHEDULE=${hour}`,
    ].join('\n'),
  );
  const args = ['--import', 'tsx', CLI, 'tick', '--dry-run'];
  if (provider) args.push('--provider', provider);
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WARMUP_HOME: warmupHome },
  });
}

test('an unqualified scheduler tick visits every enabled provider', () => {
  const result = runTick();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[codex\] warm/m);
  assert.match(result.stdout, /^\[kimi\] warm/m);
});

test('--provider limits a tick to the requested provider', () => {
  const result = runTick('codex');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[codex\] warm/m);
  assert.doesNotMatch(result.stdout, /^\[kimi\]/m);
});

// A stub arm script, wired in through the WARMUP_<ID>_SCRIPT override, so the run
// path can be exercised end to end without spending anyone's real quota.
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

function runWithStub(
  args: string[],
  envLines: string[],
  script: string,
  extraEnv: Record<string, string> = {},
) {
  const warmupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-run-'));
  const stub = path.join(warmupHome, 'stub.sh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${script}\n`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(warmupHome, 'warmup.env'), envLines.join('\n'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      WARMUP_HOME: warmupHome,
      WARMUP_CODEX_SCRIPT: stub,
      WARMUP_KIMI_SCRIPT: stub,
    },
  });
  return { ...result, warmupHome };
}

const RUN_ENV = [
  'WARMUP_MODE=smart',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=codex,kimi',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
];

function runWarmup(provider?: string, script = ECHO_STUB) {
  const args = ['run'];
  if (provider) args.push('--provider', provider);
  return runWithStub(args, RUN_ENV, script);
}

test('enabled agents arm concurrently, and one failure neither cancels nor hides the rest', () => {
  const result = runWarmup(
    undefined,
    `${CONCURRENT_STUB}\n[ "$WARMUP_PROVIDER" != kimi ] || exit 1`,
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Output is prefixed per agent so the interleaved lines stay attributable.
  assert.match(result.stdout, /^\[codex\] ARMED codex$/m);
  assert.match(result.stdout, /^\[kimi\] ARMED kimi$/m);
  assert.match(result.stdout, /^✓ codex$/m);
  assert.match(result.stdout, /^✗ kimi failed \(status 1\)$/m);
  // The failing agent gets its failure recorded; the healthy one its arm.
  const cache = JSON.parse(
    fs.readFileSync(path.join(result.warmupHome, 'usage-cache.json'), 'utf8'),
  );
  assert.ok(cache.providers.codex.lastWarmAt > 0);
  assert.ok(cache.providers.kimi.lastFailureAt > 0);
  assert.equal(cache.providers.kimi.lastWarmAt, undefined);
});

test('a scheduler tick probes, decides and arms every provider concurrently', () => {
  const hour = new Date().getHours();
  const result = runWithStub(
    ['tick'],
    [
      'WARMUP_MODE=fixed',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_PROVIDERS=codex,kimi',
      'WARMUP_SELECTED_PROVIDER=codex',
      'WARMUP_CODEX_ENABLED=true',
      `WARMUP_CODEX_SCHEDULE=${hour}`,
      'WARMUP_KIMI_ENABLED=true',
      `WARMUP_KIMI_SCHEDULE=${hour}`,
    ],
    CONCURRENT_STUB,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[codex\] ARMED codex$/m);
  assert.match(result.stdout, /^\[kimi\] ARMED kimi$/m);
  const log = fs.readFileSync(path.join(result.warmupHome, 'logs', 'warmup.log'), 'utf8');
  assert.match(log, /TICK \[codex\] warm — scheduled for/);
  assert.match(log, /TICK \[kimi\] warm — scheduled for/);
});

test('a legacy ~/.claude/warmup home is moved to ~/.agent-warmup on startup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-home-'));
  const legacy = path.join(home, '.claude', 'warmup');
  fs.mkdirSync(path.join(legacy, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'warmup.env'), 'WARMUP_MODE=fixed\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.WARMUP_HOME;
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /moved .*\.claude\/warmup → .*\.agent-warmup/);
  const moved = path.join(home, '.agent-warmup', 'warmup.env');
  assert.ok(fs.existsSync(moved));
  assert.ok(!fs.existsSync(legacy));
  assert.ok(result.stdout.includes(moved), 'help should list the new config path');
});

test('an unqualified run warms every enabled agent', () => {
  const result = runWarmup();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARMED codex/);
  assert.match(result.stdout, /ARMED kimi/);
});

test('--provider limits a run to the requested agent', () => {
  const result = runWarmup('kimi');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARMED kimi/);
  assert.doesNotMatch(result.stdout, /ARMED codex/);
});

test('a manual run records lastWarmAt so estimated usage shows the window as active', () => {
  const result = runWarmup('kimi');
  assert.equal(result.status, 0, result.stderr);
  const cache = JSON.parse(
    fs.readFileSync(path.join(result.warmupHome, 'usage-cache.json'), 'utf8'),
  );
  assert.ok(cache.providers.kimi.lastWarmAt > 0);
  assert.equal(cache.providers.codex, undefined);
});
