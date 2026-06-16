import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_CONFIG,
  DEFAULT_MULTI,
  DEFAULT_SMART,
  MODES,
  parseMultiConfig,
  parseConfig,
  serializeConfig,
  serializeMultiConfig,
} from '../src/config.js';

test('default mode is smart with a sane smart block', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'smart');
  assert.ok(MODES.includes('smart') && MODES.includes('fixed'));
  const s = DEFAULT_CONFIG.smart;
  assert.equal(s.workStart, 8);
  assert.equal(s.workEnd, 23);
  assert.equal(s.tickMinutes, 30);
  assert.equal(s.weeklyStopPercent, 90);
});

test('config round-trips through the .env format', () => {
  const cfg = {
    mode: 'fixed' as const,
    model: 'sonnet' as const,
    scheduler: 'cron' as const,
    tmuxSession: 'my-warmup',
    schedule: [7, 9, 22],
    smart: { ...DEFAULT_SMART, workStart: 9, workEnd: 18, tickMinutes: 15, weeklyStopPercent: 80 },
  };
  assert.deepEqual(parseConfig(serializeConfig(cfg)), cfg);
});

test('parseConfig falls back to defaults for missing/garbage keys', () => {
  assert.deepEqual(parseConfig(''), DEFAULT_CONFIG);
  const c = parseConfig('WARMUP_MODE=bogus\nWARMUP_MODEL=opus\n');
  assert.equal(c.mode, DEFAULT_CONFIG.mode); // bogus -> default
  assert.equal(c.model, 'opus');
});

test('.env.example documents every config key and shows the defaults', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  // Every WARMUP_* key the CLI persists in the multi-provider schema must be
  // documented in the example. The legacy WARMUP_MODEL / WARMUP_SCHEDULE /
  // WARMUP_WORK_* / WARMUP_WEEKLY_STOP_PERCENT keys are no longer persisted
  // (the migration moves them into WARMUP_<UPPER_ID>_* stanzas) so they
  // are not part of the persisted set anymore.
  const keys = [...serializeMultiConfig(DEFAULT_MULTI).matchAll(/^(WARMUP_\w+)=/gm)].map(
    (m) => m[1],
  );
  for (const k of keys) {
    // Skip the per-provider TMUX_SESSION and SCHEDULE keys: the example
    // documents them inline for each provider stanza, not as top-level keys.
    if (k.endsWith('_SCHEDULE')) continue;
    assert.ok(new RegExp(`^${k}=`, 'm').test(example), `missing ${k}`);
  }
  // Parsing the example must yield a config equal to the multi-provider
  // defaults. (Only the first provider is enabled by default in the example,
  // matching DEFAULT_MULTI.)
  const parsed = parseMultiConfig(example);
  assert.equal(parsed.shared.mode, DEFAULT_MULTI.shared.mode);
  assert.equal(parsed.shared.scheduler, DEFAULT_MULTI.shared.scheduler);
  assert.equal(parsed.shared.tickMinutes, DEFAULT_MULTI.shared.tickMinutes);
  assert.deepEqual(parsed.shared.providers, DEFAULT_MULTI.shared.providers);
  assert.equal(parsed.shared.selectedProvider, DEFAULT_MULTI.shared.selectedProvider);
  assert.equal(parsed.providers.claude.model, DEFAULT_MULTI.providers.claude.model);
  assert.equal(parsed.providers.claude.workStart, DEFAULT_MULTI.providers.claude.workStart);
  assert.equal(parsed.providers.claude.workEnd, DEFAULT_MULTI.providers.claude.workEnd);
  assert.equal(
    parsed.providers.claude.weeklyStopPercent,
    DEFAULT_MULTI.providers.claude.weeklyStopPercent,
  );
  assert.equal(parsed.providers.opencode.model, DEFAULT_MULTI.providers.opencode.model);
  assert.equal(parsed.providers.opencode.workStart, DEFAULT_MULTI.providers.opencode.workStart);
  assert.equal(parsed.providers.opencode.workEnd, DEFAULT_MULTI.providers.opencode.workEnd);
  assert.equal(
    parsed.providers.opencode.weeklyStopPercent,
    DEFAULT_MULTI.providers.opencode.weeklyStopPercent,
  );
});

test('parseConfig tolerates blanks, comments, quotes, and inline comments', () => {
  const text = [
    '# a comment',
    '',
    'WARMUP_MODEL = opus  # cheapest that fits',
    'WARMUP_TMUX_SESSION="my-sess"',
    'WARMUP_SCHEDULE=8,13,18',
  ].join('\n');
  const c = parseConfig(text);
  assert.equal(c.model, 'opus');
  assert.equal(c.tmuxSession, 'my-sess');
  assert.deepEqual(c.schedule, [8, 13, 18]);
});
