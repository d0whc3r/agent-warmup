import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// loadConfig/saveConfig pin CONFIG_PATH under WARMUP_HOME at import time.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-config-io-'));
process.env.WARMUP_HOME = HOME_DIR;
const {
  loadConfig,
  saveConfig,
  parseMultiConfig,
  serializeMultiConfig,
  ensureConfigFile,
  DEFAULT_MULTI,
} = await import('../src/config.js');
const { CONFIG_PATH } = await import('../src/paths.js');

test('a missing config file reads as the defaults', () => {
  const multi = loadConfig();
  assert.deepEqual(multi.shared.providers, ['claude']);
  assert.equal(multi.shared.selectedProvider, 'claude');
  assert.equal(multi.providers.codex?.enabled, false, 'other agents stay opt-in');
});

test('saveConfig rewrites a legacy file in the new schema, backing it up once', () => {
  // Legacy shape: flat WARMUP_* keys, no WARMUP_PROVIDERS.
  fs.writeFileSync(CONFIG_PATH, 'WARMUP_MODE=fixed\nWARMUP_SCHEDULE=7,9\n');
  saveConfig(loadConfig());
  assert.match(fs.readFileSync(CONFIG_PATH, 'utf8'), /WARMUP_PROVIDERS=claude/);
  const backup = fs.readFileSync(`${CONFIG_PATH}.bak`, 'utf8');
  assert.match(backup, /WARMUP_MODE=fixed/);
  assert.doesNotMatch(backup, /WARMUP_PROVIDERS/);
  // A second save over the new schema must not replace the backup.
  saveConfig(loadConfig());
  assert.equal(fs.readFileSync(`${CONFIG_PATH}.bak`, 'utf8'), backup);
});

test('normalization clamps hostile values instead of trusting them', () => {
  const multi = parseMultiConfig(
    [
      'WARMUP_PROVIDERS=codex,kimi,codex', // deduped, order kept
      'WARMUP_SELECTED_PROVIDER=minimax', // disabled selection falls back to the first enabled
      'WARMUP_TICK_MINUTES=17', // not an allowed cadence -> default
      'WARMUP_CODEX_ENABLED=yes', // truthy junk -> enabled
      'WARMUP_CODEX_WORK_START=25', // out of range -> default
      'WARMUP_CODEX_WORK_END=3', // below workStart -> workStart+1
      'WARMUP_CODEX_WEEKLY_STOP_PERCENT=150', // clamped to 100
      'WARMUP_KIMI_ENABLED=true',
      'WARMUP_KIMI_TMUX_SESSION=my session:x', // tmux-hostile chars -> dashes
      'WARMUP_KIMI_WEEKLY_STOP_PERCENT=0', // clamped to 1
    ].join('\n'),
  );
  assert.deepEqual(multi.shared.providers, ['codex', 'kimi']);
  assert.equal(multi.shared.selectedProvider, 'codex');
  assert.equal(multi.shared.tickMinutes, 30);
  assert.equal(multi.providers.codex?.enabled, true);
  assert.equal(multi.providers.codex?.workStart, 8);
  assert.equal(multi.providers.codex?.workEnd, 9);
  assert.equal(multi.providers.codex?.weeklyStopPercent, 100);
  assert.equal(multi.providers.kimi?.tmuxSession, 'my-session-x');
  assert.equal(multi.providers.kimi?.weeklyStopPercent, 1);
});

// Keys present in a line, ignoring comments and blanks.
function envKeys(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0] as string),
  );
}

test('ensureConfigFile seeds a full template once and never overwrites it', () => {
  fs.rmSync(CONFIG_PATH, { force: true });

  assert.equal(ensureConfigFile(), true);
  const seeded = fs.readFileSync(CONFIG_PATH, 'utf8');
  // Every provider gets a stanza, so the file can be hand-edited without docs.
  assert.deepEqual(envKeys(seeded), envKeys(serializeMultiConfig(DEFAULT_MULTI)));
  // Defaults only enable claude; the rest stay opt-in.
  assert.match(seeded, /WARMUP_CLAUDE_ENABLED=true/);
  assert.match(seeded, /WARMUP_CODEX_ENABLED=false/);

  fs.writeFileSync(CONFIG_PATH, 'WARMUP_PROVIDERS=kimi\n');
  assert.equal(ensureConfigFile(), false);
  assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), 'WARMUP_PROVIDERS=kimi\n');
});

test('.env.example documents exactly the keys the seeded config writes', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.deepEqual(envKeys(example), envKeys(serializeMultiConfig(DEFAULT_MULTI)));
});
