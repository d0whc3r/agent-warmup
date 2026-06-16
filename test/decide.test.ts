import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/providers/claude.js';
import type { ProviderConfig, SharedConfig } from '../src/types.js';

const cfg: ProviderConfig = {
  id: 'claude',
  enabled: true,
  binary: '',
  model: 'haiku',
  tmuxSession: 'claude-warmup',
  armScriptPath: '',
  workStart: 8,
  workEnd: 23,
  weeklyStopPercent: 90,
  schedule: [],
  extra: {},
};
const shared: SharedConfig = {
  mode: 'smart',
  scheduler: 'launchd',
  tickMinutes: 30,
  providers: ['claude'],
  selectedProvider: 'claude',
};
const CTX_OFF = { cfg, shared, now: new Date(2026, 5, 13, 3, 0, 0) };
const CTX_DAY = { cfg, shared, now: new Date(2026, 5, 13, 13, 0, 0) };
const usage = (over = {}) => ({
  session: { pct: 0, active: false, resetsAt: null },
  week: { pct: 5, resetsAt: null },
  ...over,
});

test('outside working hours -> skip-offhours', () => {
  assert.equal(decide(CTX_OFF, usage()).action, 'skip-offhours');
});

test('weekly quota at/above threshold -> skip-weekly', () => {
  assert.equal(decide(CTX_DAY, usage({ week: { pct: 90 } })).action, 'skip-weekly');
  assert.equal(decide(CTX_DAY, usage({ week: { pct: 95 } })).action, 'skip-weekly');
});

test('active window -> skip-active', () => {
  const u = usage({ session: { pct: 30, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) } });
  assert.equal(decide(CTX_DAY, u).action, 'skip-active');
});

test('idle window, quota fine -> warm', () => {
  assert.equal(decide(CTX_DAY, usage()).action, 'warm');
});

test('weekly check is skipped when usage has no weekly data (inferred)', () => {
  const u = { inferred: true, session: { pct: 0, active: false }, week: null };
  assert.equal(decide(CTX_DAY, u).action, 'warm');
});

test('weekly takes precedence over an active window', () => {
  const u = usage({ week: { pct: 99 }, session: { pct: 50, active: true } });
  assert.equal(decide(CTX_DAY, u).action, 'skip-weekly');
});
