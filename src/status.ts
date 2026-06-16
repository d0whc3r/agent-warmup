// Aggregate status across config, launchd, cron, recent logs and the usage cache.
import * as launchd from './launchd.js';
import * as cron from './cron.js';
import { loadConfig, getView } from './config.js';
import { lastRunSummary } from './runner.js';
import { readCache } from './tick.js';
import { getHours } from './time.js';
import { pad2 } from './format.js';
import type { MultiConfig, Status } from './types.js';

export function nextRun(multi: MultiConfig, now: Date = new Date()): string | null {
  if (multi.shared.mode === 'smart') {
    const { tickMinutes } = multi.shared;
    // Band: union of all enabled providers' work windows. With a single
    // provider, this is just that provider's band; with multiple it is the
    // "any provider would consider this hour in-range" window.
    const bands = multi.shared.providers
      .map((id) => multi.providers[id])
      .filter((p) => p?.enabled)
      .map((p) => [p!.workStart, p!.workEnd] as const);
    if (!bands.length) return null;
    const workStart = Math.min(...bands.map(([s]) => s));
    const workEnd = Math.max(...bands.map(([, e]) => e));
    return `every ${tickMinutes}m · ${pad2(workStart)}–${pad2(workEnd)}h`;
  }
  // Fixed mode: union of all enabled providers' schedule hours.
  const hours = multi.shared.providers
    .flatMap((id) => multi.providers[id]?.schedule ?? [])
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .sort((a, b) => a - b);
  if (!hours.length) return null;
  const upcoming = hours.find((h) => h > getHours(now));
  const hh = pad2(upcoming ?? hours[0]!);
  return `${hh}:00 ${upcoming != null ? 'today' : 'tomorrow'}`;
}

export function getStatus(): Status {
  const config = loadConfig();
  const l = launchd.status();
  const c = cron.status();
  const active =
    config.shared.scheduler === 'launchd' ? l.installed && l.loaded && l.enabled : c.installed;
  return {
    config,
    view: getView(config),
    launchd: l,
    cron: c,
    active,
    nextRun: active ? nextRun(config) : null,
    lastRun: lastRunSummary(),
    usage: readCache(),
  };
}
