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
function runWarmup(provider?: string) {
  const warmupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-run-'));
  const stub = path.join(warmupHome, 'stub.sh');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "ARMED ${WARMUP_PROVIDER}"\n');
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(
    path.join(warmupHome, 'warmup.env'),
    [
      'WARMUP_MODE=smart',
      'WARMUP_SCHEDULER=cron',
      'WARMUP_PROVIDERS=codex,kimi',
      'WARMUP_SELECTED_PROVIDER=codex',
      'WARMUP_CODEX_ENABLED=true',
      'WARMUP_KIMI_ENABLED=true',
      'WARMUP_CLAUDE_ENABLED=false',
    ].join('\n'),
  );
  const args = ['--import', 'tsx', CLI, 'run'];
  if (provider) args.push('--provider', provider);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WARMUP_HOME: warmupHome,
      WARMUP_CODEX_SCRIPT: stub,
      WARMUP_KIMI_SCRIPT: stub,
    },
  });
  return { ...result, warmupHome };
}

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
