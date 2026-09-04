import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun } from '../src/status.js';
import type { MultiConfig } from '../src/types.js';

const base: MultiConfig = {
  shared: {
    mode: 'fixed',
    scheduler: 'cron',
    tickMinutes: 30,
    providers: ['claude'],
    selectedProvider: 'claude',
  },
  providers: {
    claude: {
      id: 'claude',
      enabled: true,
      binary: '',
      model: 'haiku',
      tmuxSession: 'claude-warmup',
      armScriptPath: '',
      workStart: 9,
      workEnd: 18,
      weeklyStopPercent: 80,
      schedule: [8, 13, 18],
      extra: {},
    },
    opencode: {
      id: 'opencode',
      enabled: false,
      binary: '',
      model: '',
      tmuxSession: '',
      armScriptPath: '',
      workStart: 7,
      workEnd: 22,
      weeklyStopPercent: 85,
      schedule: [],
      extra: {},
    },
  },
};

const at = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);

test('smart mode summarizes the cadence and band, ignoring the clock', () => {
  assert.equal(
    nextRun({ ...base, shared: { ...base.shared, mode: 'smart' } }, at(10)),
    'every 30m · 09–18h',
  );
});

test('fixed mode picks the next hour still ahead today', () => {
  assert.equal(nextRun(base, at(10)), '13:00 today'); // 13 is the first hour > 10
});

test('fixed mode rolls to tomorrow once every scheduled hour has passed', () => {
  assert.equal(nextRun(base, at(20)), '08:00 tomorrow'); // wraps to the first hour
});

test('fixed mode with no scheduled hours has no next run', () => {
  assert.equal(
    nextRun(
      {
        ...base,
        providers: { ...base.providers, claude: { ...base.providers.claude!, schedule: [] } },
      },
      at(10),
    ),
    null,
  );
});
