import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// runTick reads the config and the cache under WARMUP_HOME and spawns the arm
// scripts resolved at import time, so the sandbox comes first — dynamic import.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-tick-unit-'));
const arm = (body: string): string => {
  const file = path.join(HOME_DIR, `arm-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};
process.env.WARMUP_HOME = HOME_DIR;
process.env.WARMUP_KIMI_SCRIPT = arm('echo "ARMED kimi"');
process.env.WARMUP_CODEX_SCRIPT = arm('echo "ARMED codex"');
// The codex probe resolves its session log dir from CODEX_HOME at call time.
process.env.CODEX_HOME = path.join(HOME_DIR, 'codex-home');
const CODEX_SESSION = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', 'rollout.jsonl');

const { runTick } = await import('../src/tick.js');
const { WARMUP_LOG } = await import('../src/paths.js');

const writeConfig = (lines: string[]): void => {
  fs.writeFileSync(path.join(HOME_DIR, 'warmup.env'), lines.join('\n') + '\n');
};
// A fresh cache per test: a lastWarmAt left over from the previous tick would flip
// every decision to skip-active.
const resetCache = (): void => {
  fs.writeFileSync(path.join(HOME_DIR, 'usage-cache.json'), JSON.stringify({ providers: {} }));
};
const readCacheJson = (): { providers: Record<string, Record<string, unknown>> } =>
  JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'usage-cache.json'), 'utf8'));
const readLog = (): string => fs.readFileSync(WARMUP_LOG, 'utf8');

const TWO_AGENTS = [
  'WARMUP_PROVIDERS=codex,kimi',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
  'WARMUP_KIMI_WORK_START=0',
  'WARMUP_KIMI_WORK_END=24',
];

function seedCodexSession(now: Date, resetsInSeconds: number): void {
  fs.mkdirSync(path.dirname(CODEX_SESSION), { recursive: true });
  const resetsAt = Math.floor(now.getTime() / 1000) + resetsInSeconds;
  fs.writeFileSync(
    CODEX_SESSION,
    [
      'not json at all',
      JSON.stringify({
        timestamp: now.toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 74.4, window_minutes: 300, resets_at: resetsAt },
            secondary: { used_percent: 27, window_minutes: 10080, resets_at: resetsAt },
          },
        },
      }),
    ].join('\n'),
  );
}

test('a tick probes live providers, infers cache-only ones and arms what is warm', async () => {
  writeConfig(TWO_AGENTS);
  const now = new Date(2026, 8, 5, 12, 0, 0);
  seedCodexSession(now, -3600);
  resetCache();
  const { results, dryRun } = await runTick({ now });
  assert.equal(dryRun, false);

  const byId = new Map(results.map((r) => [r.id, r]));
  const codex = byId.get('codex')!;
  assert.equal(codex.probed, true, 'codex has a live probe');
  assert.equal(codex.usage?.session?.pct, 74);
  assert.equal(codex.decision.action, 'warm');
  assert.equal(codex.status, 0, 'the arm ran');

  const kimi = byId.get('kimi')!;
  assert.equal(kimi.probed, false, 'kimi has no live probe');
  assert.equal(kimi.usage?.inferred, true);
  assert.equal(kimi.decision.action, 'warm');
  assert.equal(kimi.status, 0);

  // The probe snapshot is persisted for codex; kimi keeps its decision + warm stamp.
  const cache = readCacheJson();
  assert.equal((cache.providers.codex!.session as { pct: number }).pct, 74);
  assert.ok(cache.providers.kimi!.lastWarmAt);
  assert.equal((cache.providers.kimi!.lastDecision as { action: string }).action, 'warm');

  // The log names the decision and where it came from.
  const log = readLog();
  assert.match(log, /TICK \[codex\] warm — no active window \[via probe\]/);
  assert.match(log, /TICK \[kimi\] warm — no recent warmup \(usage estimated\) \[via cache\]/);
});

test('a dry-run decides and logs but never arms', async () => {
  writeConfig(TWO_AGENTS);
  resetCache();
  // No explicit `now`: the tick defaults to the current time.
  const { results } = await runTick({ dryRun: true });
  assert.ok(results.every((r) => r.status === 0));
  assert.ok(readLog().includes('TICK [kimi] warm (dry-run)'));
  assert.equal(readCacheJson().providers.kimi!.lastWarmAt, undefined);
  // The decision is still persisted, so the TUI can show what the tick thought.
  assert.equal((readCacheJson().providers.kimi!.lastDecision as { action: string }).action, 'warm');
});

test('providerId narrows the tick, and disabled providers are never visited', async () => {
  writeConfig(TWO_AGENTS);
  resetCache();
  const one = await runTick({ providerId: 'kimi', now: new Date(2026, 8, 5, 12, 0, 0) });
  assert.deepEqual(
    one.results.map((r) => r.id),
    ['kimi'],
  );

  // claude exists in the config but is disabled, so it produces no result at all.
  const none = await runTick({ providerId: 'claude', now: new Date(2026, 8, 5, 12, 0, 0) });
  assert.deepEqual(none.results, []);
});

test('fixed mode arms only the providers scheduled for the current hour', async () => {
  const hour = new Date().getHours();
  const away = (hour + 3) % 24;
  writeConfig([
    'WARMUP_MODE=fixed',
    'WARMUP_PROVIDERS=codex,kimi',
    'WARMUP_CODEX_ENABLED=true',
    'WARMUP_KIMI_ENABLED=true',
    'WARMUP_CLAUDE_ENABLED=false',
    `WARMUP_KIMI_SCHEDULE=${hour}`,
    `WARMUP_CODEX_SCHEDULE=${away}`,
  ]);
  fs.writeFileSync(path.join(HOME_DIR, 'usage-cache.json'), JSON.stringify({ providers: {} }));
  const { results } = await runTick({ now: new Date() });
  const byId = new Map(results.map((r) => [r.id, r]));
  assert.equal(byId.get('kimi')!.decision.action, 'warm');
  assert.equal(byId.get('kimi')!.status, 0);
  assert.equal(byId.get('codex')!.decision.action, 'skip-schedule');
  assert.equal(readCacheJson().providers.codex!.lastWarmAt, undefined);
});
