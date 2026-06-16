// launchd (LaunchAgent) management: generate the plist, load/unload, query state.
// Multi-provider: a single plist drives the tick for ALL enabled providers.
// The tick iterates them; per-provider workStart/workEnd/week are read from
// warmup.env on disk (so they don't have to live in the plist env).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, LABEL, PLIST_PATH, LOG_DIR, GUI_DOMAIN, SELF_INVOCATION } from './paths.js';
import type { MultiConfig } from './types.js';

function launchctl(args: string[]) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function calendarBlock(hour: number, minute = 0): string {
  return `        <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
}

// Smart mode: fire every `tickMinutes` across the UNION of enabled providers'
// work bands. Fixed mode: fire at the UNION of all providers' schedule hours.
function intervalsFor(multi: MultiConfig): string[] {
  const enabled = multi.shared.providers
    .map((id) => multi.providers[id])
    .filter((p): p is NonNullable<typeof p> => !!p);
  if (multi.shared.mode === 'smart') {
    const { tickMinutes } = multi.shared;
    const workStart = Math.min(...enabled.map((p) => p.workStart));
    const workEnd = Math.max(...enabled.map((p) => p.workEnd));
    const out: string[] = [];
    for (let h = workStart; h < workEnd; h++) {
      for (let m = 0; m < 60; m += tickMinutes) out.push(calendarBlock(h, m));
    }
    return out;
  }
  // Fixed mode: union of schedules.
  const hours = Array.from(new Set(enabled.flatMap((p) => p.schedule))).sort((a, b) => a - b);
  return hours.map((h) => calendarBlock(h));
}

function programArgs(_multi: MultiConfig): string[] {
  // Smart mode runs the tick (probe + decide per provider); fixed mode also
  // runs the tick (the per-provider decide in fixed mode skips if not in the
  // provider's schedule, so firing at the union is safe).
  return [...SELF_INVOCATION, 'tick'];
}

export function generatePlist(multi: MultiConfig): string {
  const intervals = intervalsFor(multi).join('\n');
  const args = programArgs(multi)
    .map((a) => `        <string>${a}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
 ${args}
    </array>
    <key>StartCalendarInterval</key>
    <array>
 ${intervals}
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, 'launchd.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, 'launchd.err.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
`;
}

export function apply(multi: MultiConfig): boolean {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, generatePlist(multi));
  launchctl(['bootout', `${GUI_DOMAIN}/${LABEL}`]); // ignore error if not loaded
  const r = launchctl(['bootstrap', GUI_DOMAIN, PLIST_PATH]);
  launchctl(['enable', `${GUI_DOMAIN}/${LABEL}`]);
  return r.status === 0;
}

export function remove(): void {
  launchctl(['bootout', `${GUI_DOMAIN}/${LABEL}`]);
  try {
    fs.unlinkSync(PLIST_PATH);
  } catch {
    /* already gone */
  }
}

export function enable(): boolean {
  return launchctl(['enable', `${GUI_DOMAIN}/${LABEL}`]).status === 0;
}

export function disable(): boolean {
  return launchctl(['disable', `${GUI_DOMAIN}/${LABEL}`]).status === 0;
}

export function runNow(): boolean {
  return launchctl(['kickstart', '-k', `${GUI_DOMAIN}/${LABEL}`]).status === 0;
}

export function status(): {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled: boolean;
} {
  const installed = fs.existsSync(PLIST_PATH);
  const printed = launchctl(['print', `${GUI_DOMAIN}/${LABEL}`]);
  const loaded = printed.status === 0;
  const running = loaded && /state = running/.test(printed.stdout);
  const disabledList = launchctl(['print-disabled', GUI_DOMAIN]).stdout || '';
  const m = disabledList.match(new RegExp(`"${LABEL}"\\s*=>\\s*(\\w+)`));
  const enabled = m ? m[1] === 'enabled' || m[1] === 'false' : true;
  return { installed, loaded, running, enabled };
}
