import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('two failures one tick apart still trip the cooldown at every tick cadence', () => {
  // Ticks run every 5..60 minutes; a failure on each of two consecutive ticks must
  // count as a pair, so the failure window has to exceed the slowest cadence.
  const now = new Date('2026-09-04T10:00:00Z');
  const first = recordArmWithCooldown({}, 1, now);
  const second = recordArmWithCooldown(first.cache, 1, new Date(now.getTime() + 61 * 60_000));
  assert.match(second.log ?? '', /cooldown set/);
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

test('each provider maps its own binary env and display name for the arm script', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  for (const id of ALL_PROVIDER_IDS) {
    const provider = getProvider(id);
    const ctx: ProbeContext = {
      cfg: DEFAULT_MULTI.providers[id]!,
      shared: DEFAULT_MULTI.shared,
      now,
    };
    const env = provider.armEnv(ctx);
    assert.equal(env.WARMUP_PROVIDER_NAME, provider.name, `${id} carries its display name`);
    assert.ok(
      Object.values(env).includes(ctx.cfg.binary),
      `${id} exports its configured binary path`,
    );
  }
});

test('a successful arm clears the failure bookkeeping and the cooldown', () => {
  const now = new Date('2026-09-04T10:00:00Z');
  const { cache } = recordArmWithCooldown(
    { lastFailureAt: now.getTime() - 1000, cooldownUntil: now.getTime() + 3_600_000 },
    0,
    now,
  );
  assert.equal(cache.lastWarmAt, now.getTime());
  assert.equal(cache.lastFailureAt, undefined);
  assert.equal(cache.cooldownUntil, undefined);
});

test('decideWindow short-circuits offhours, the weekly cap and then cooldowns', () => {
  const at = (hour: number): ProbeContext => ({
    cfg: { ...DEFAULT_MULTI.providers.kimi!, workStart: 8, workEnd: 23, weeklyStopPercent: 90 },
    shared: { ...DEFAULT_MULTI.shared, mode: 'smart' },
    now: new Date(2026, 8, 5, hour),
  });
  assert.equal(decideWindow(at(3), null).action, 'skip-offhours');
  assert.equal(decideWindow(at(12), { session: null, week: { pct: 90 } }).action, 'skip-weekly');
  const now = at(12).now.getTime();
  const cooldown = { session: null, week: null, cooldownUntil: now + 120_000 } as ProviderUsage;
  assert.match(decideWindow(at(12), cooldown).reason, /cooldown \(2m remaining\)/);
});

test('codex probes read the newest session log, skipping lines it cannot parse', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-codex-'));
  process.env.CODEX_HOME = codexHome;
  const now = new Date('2026-09-05T10:00:00Z');
  const ctx: ProbeContext = {
    cfg: DEFAULT_MULTI.providers.codex!,
    shared: { ...DEFAULT_MULTI.shared, mode: 'smart' },
    now,
  };
  const rateLine = (pct: number, resetsInSec: number): string =>
    JSON.stringify({
      timestamp: now.toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: {
            used_percent: pct,
            window_minutes: 300,
            resets_at: Math.floor(now.getTime() / 1000) + resetsInSec,
          },
          secondary: null,
        },
      },
    });
  try {
    // No sessions dir yet.
    assert.equal(await getProvider('codex').probe(ctx), null);

    const sessions = path.join(codexHome, 'sessions', '2026', '09');
    fs.mkdirSync(sessions, { recursive: true });
    const old = path.join(sessions, 'rollout-old.jsonl');
    fs.writeFileSync(old, rateLine(10, 3600));
    fs.utimesSync(old, now, new Date(now.getTime() - 3_600_000));
    // The newest file wins by mtime even if the other holds newer-looking data,
    // and garbage lines in between are skipped.
    fs.writeFileSync(
      path.join(sessions, 'rollout-new.jsonl'),
      ['garbage', '{"payload":{}}', rateLine(74.4, 3600)].join('\n'),
    );

    const usage = await getProvider('codex').probe(ctx);
    assert.ok(usage);
    assert.equal(usage.session?.pct, 74);
    assert.equal(usage.week, null, 'the secondary limit is null in this capture');

    // An empty sessions dir has no newest file.
    fs.rmSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    assert.equal(await getProvider('codex').probe(ctx), null);
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test('cache-only providers report estimated usage and probe to nothing', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  for (const id of ['zai', 'kimi', 'minimax'] as const) {
    const provider = getProvider(id);
    assert.equal(provider.probeKind, 'estimated');
    const ctx: ProbeContext = {
      cfg: DEFAULT_MULTI.providers[id]!,
      shared: DEFAULT_MULTI.shared,
      now,
    };
    assert.equal(provider.probe?.(ctx) ?? null, null);
  }
});
