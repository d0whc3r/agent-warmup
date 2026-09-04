// Headless status output for the CLI (the `status` command and the post-action
// summaries). The interactive equivalent lives in the Ink TUI; both read
// getStatus() and share the same display formatting helpers.
import { getStatus } from './status.js';
import { formatUsage } from './providers/claude.js';
import { pad2, ago } from './format.js';

const dot = (on: boolean): string => (on ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m');

export function printStatus(): void {
  const s = getStatus();
  const { config, view } = s;
  const providerIds = config.shared.providers;
  console.log(
    `${dot(s.active)} agent-warmup  ${s.active ? 'ACTIVE' : 'inactive'}  (${view.mode} · ${view.scheduler} · ${providerIds.length} provider${providerIds.length === 1 ? '' : 's'})`,
  );
  if (view.mode === 'smart') {
    const sm = view.smart;
    console.log(
      `  window     ${pad2(sm.workStart)}–${pad2(sm.workEnd)}h · check every ${sm.tickMinutes}m · stop at ${sm.weeklyStopPercent}% weekly`,
    );
  } else {
    // Per-provider schedules, comma-joined; collisions are deduped.
    const hours = Array.from(
      new Set(providerIds.flatMap((id) => config.providers[id]?.schedule ?? [])),
    ).sort((a, b) => a - b);
    if (hours.length) {
      console.log(`  schedule   ${hours.map((h) => pad2(h) + ':00').join('  ')}`);
    }
  }
  if (s.nextRun) console.log(`  next run   ${s.nextRun}`);
  // Per-provider blocks.
  for (const id of providerIds) {
    const p = config.providers[id];
    if (!p) continue;
    const cache = s.usage?.providers?.[id];
    const sel = id === config.shared.selectedProvider;
    const marker = sel ? '\x1b[36m▸\x1b[0m' : ' ';
    console.log(`  ${marker} ${id.padEnd(9)} model=${p.model}  session=${p.tmuxSession}`);
    const u = formatUsage(cache ?? null);
    if (u) {
      console.log(`              session    ${u.session}`);
      console.log(
        `              weekly     ${u.week}${u.ageMin != null ? `   (as of ${ago(u.ageMin)})` : ''}`,
      );
    }
  }
  if (view.scheduler === 'launchd') {
    console.log(
      `  launchd    installed=${s.launchd.installed} loaded=${s.launchd.loaded} enabled=${s.launchd.enabled}`,
    );
  } else {
    console.log(`  cron       installed=${s.cron.installed}`);
  }
  if (s.lastRun) console.log(`  last run   ${s.lastRun.replace(/^\[|\]$/g, '')}`);
}
