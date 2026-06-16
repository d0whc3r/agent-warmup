// High-level scheduling: apply/stop the active scheduler, keeping the other off.
import * as launchd from './launchd.js';
import * as cron from './cron.js';
import { ensureArmScript } from './assets.js';
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

export function stopSchedule(): void {
  launchd.remove();
  cron.remove();
}
