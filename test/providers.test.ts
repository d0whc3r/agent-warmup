import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MULTI, parseMultiConfig, serializeMultiConfig } from '../src/config.js';
import { ALL_PROVIDER_IDS, getProvider } from '../src/providers/index.js';
import { recordArmWithCooldown } from '../src/providers/common.js';
import { decideForMode } from '../src/tick.js';

import type { ProbeContext } from '../src/providers/types.js';

test('all built-in subscriptions have config, metadata and an arm script', () => {
  assert.deepEqual(ALL_PROVIDER_IDS, ['claude', 'codex', 'zai', 'kimi', 'opencode', 'minimax']);
  for (const id of ALL_PROVIDER_IDS) {
    const config = DEFAULT_MULTI.providers[id];
    const provider = getProvider(id);
    assert.ok(config, `${id} config is missing`);
    assert.equal(provider.id, id);
    assert.ok(provider.name);
    assert.ok(provider.modelChoices.includes(config.model));
    assert.match(provider.armScript(), /^#!\/usr\/bin\/env bash/);
  }
});

test('new providers are opt-in and survive an env round-trip', () => {
  for (const id of ALL_PROVIDER_IDS) {
    assert.equal(DEFAULT_MULTI.providers[id]!.enabled, id === 'claude');
  }
  const parsed = parseMultiConfig(serializeMultiConfig(DEFAULT_MULTI));
  for (const id of ALL_PROVIDER_IDS) {
    assert.deepEqual(parsed.providers[id], DEFAULT_MULTI.providers[id]);
  }
});

test('cache-only providers infer an active five-hour window after a successful arm', () => {
  const provider = getProvider('codex');
  const now = new Date('2026-09-04T10:00:00Z');
  const ctx: ProbeContext = {
    cfg: DEFAULT_MULTI.providers.codex!,
    shared: { ...DEFAULT_MULTI.shared, mode: 'smart' },
    now,
  };
  const usage = provider.inferFromCache(ctx, { lastWarmAt: now.getTime() - 60_000 });
  assert.equal(usage.inferred, true);
  assert.equal(usage.session?.active, true);
});

test('two close arm failures trigger a one-hour cooldown', () => {
  const now = new Date('2026-09-04T10:00:00Z');
  const first = recordArmWithCooldown({}, 1, now);
  assert.equal(first.log, undefined);
  const second = recordArmWithCooldown(first.cache, 1, new Date(now.getTime() + 5 * 60_000));
  assert.match(second.log ?? '', /cooldown set/);
  assert.equal(second.cache.cooldownUntil, now.getTime() + 65 * 60_000);
});

test('fixed mode only warms a provider at its own scheduled hour', () => {
  const provider = getProvider('kimi');
  const cfg = { ...DEFAULT_MULTI.providers.kimi!, schedule: [8, 13, 18] };
  const at = (hour: number): ProbeContext => ({
    cfg,
    shared: { ...DEFAULT_MULTI.shared, mode: 'fixed' },
    now: new Date(2026, 8, 4, hour),
  });
  assert.equal(decideForMode(provider, at(13), null).action, 'warm');
  assert.equal(decideForMode(provider, at(14), null).action, 'skip-schedule');
});
