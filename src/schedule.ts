import { ensureArmScript } from './assets.js';
import { loadConfig } from './config.js';
import * as cron from './cron.js';
// High-level scheduling: apply/stop the active scheduler, keeping the other off.
import * as launchd from './launchd.js';
import type { MultiConfig } from './types.js';

export function applySchedule(multi: MultiConfig): boolean {
  // Materialize every enabled provider's arm script under WARMUP_HOME (SEA build).
  for (const id of multi.shared.providers) {
    if (multi.providers[id]?.enabled) ensureArmScript(id);
  }
  if (multi.shared.scheduler === 'cron') {
    launchd.remove();
    return cron.apply(multi);
  }
  cron.remove();
  return launchd.apply(multi);
}

// After the home dir moved, an installed scheduler entry keeps logging to the old
// path until it is re-applied. Called from the status-reading entry points (TUI,
// `status`) — never from the tick itself, since reloading the launchd job from
// inside the job would kill it.
export function repairStaleEntry(): void {
  if (launchd.stale() || cron.stale()) applySchedule(loadConfig());
}

export function stopSchedule(): void {
  launchd.remove();
  cron.remove();
}
