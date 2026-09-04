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
