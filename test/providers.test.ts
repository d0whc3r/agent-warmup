import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_MULTI, parseMultiConfig, serializeMultiConfig } from '../src/config.js';
import { decideWindow, recordArmWithCooldown } from '../src/providers/common.js';
import { ALL_PROVIDER_IDS, getProvider, usageView } from '../src/providers/index.js';
import { parseCodexRateLimits } from '../src/providers/subscriptions.js';
import type { ProbeContext } from '../src/providers/types.js';
import { decideForMode } from '../src/tick.js';
import type { ProviderUsage } from '../src/types.js';

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

test('codex reads its five-hour and weekly limits from the newest session log line', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
  const weekResetsAt = resetsAt + 6 * 24 * 3600;
  const text = [
    '{"timestamp":"2026-09-05T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1},"secondary":null}}}',
    '{"timestamp":"2026-09-05T09:30:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":74.4,"window_minutes":300,"resets_at":' +
      resetsAt +
      '},"secondary":{"used_percent":27.0,"window_minutes":10080,"resets_at":' +
      weekResetsAt +
      '}}}}',
    'not json at all',
  ].join('\n');
  const usage = parseCodexRateLimits(text, now);
  assert.ok(usage);
  assert.equal(usage.session?.pct, 74);
  assert.equal(usage.session?.active, true);
  assert.equal(usage.week?.pct, 27);
  assert.equal(usage.capturedAt, Date.parse('2026-09-05T09:30:00.000Z'));
  assert.equal(parseCodexRateLimits('{"payload":{}}\n', now), null);
});

test('a recent arm outranks a stale probe that says the window is idle', () => {
  const now = new Date(2026, 8, 5, 12);
  const ctx: ProbeContext = {
    cfg: DEFAULT_MULTI.providers.codex!,
    shared: { ...DEFAULT_MULTI.shared, mode: 'smart' },
    now,
  };
  const stale: ProviderUsage & { lastWarmAt: number } = {
    session: { pct: 0, active: false },
    week: null,
    lastWarmAt: now.getTime() - 60_000,
  };
  assert.equal(decideWindow(ctx, stale).action, 'skip-active');
  const armedLongAgo: typeof stale = { ...stale, lastWarmAt: 0 };
  assert.equal(decideWindow(ctx, armedLongAgo).action, 'warm');
});

test('usageView estimates a window for providers without a live snapshot', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  const cache = { providers: { kimi: { lastWarmAt: now.getTime() - 60_000 } } };
  assert.match(
    usageView('kimi', cache, DEFAULT_MULTI, now)?.session ?? '',
    /^active \(estimated\)/,
  );
  assert.match(usageView('zai', cache, DEFAULT_MULTI, now)?.session ?? '', /^idle \(estimated\)/);
  assert.equal(
    usageView(
      'claude',
      { providers: { claude: { session: { pct: 40 }, week: null } } },
      DEFAULT_MULTI,
      now,
    )?.session,
    '40% (idle)',
  );
});
