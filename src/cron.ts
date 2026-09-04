// Real crontab management. We own a marked block so we never touch the user's
// other cron entries. Multi-provider: a single cron line drives the tick for
// all enabled providers.
import { spawnSync } from 'node:child_process';

import { CRON_LOG, SELF_INVOCATION } from './paths.js';
import type { MultiConfig } from './types.js';

const BEGIN = '# >>> claude-warmup >>>';
const END = '# <<< claude-warmup <<<';

function readCrontab(): string {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout || '' : ''; // non-zero == no crontab yet
}

function writeCrontab(text: string): boolean {
  return spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' }).status === 0;
}

// Exported for unit testing: the crontab edit (drop our marked block) and the line
// generator are pure, so they're verified directly rather than through the real
// `crontab` binary that apply()/remove() drive.
export function stripBlock(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line.trim() === BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '');
}

export function buildBlock(multi: MultiConfig): string {
  let line: string;
  if (multi.shared.mode === 'smart') {
    const { tickMinutes } = multi.shared;
    const enabled = multi.shared.providers
      .map((id) => multi.providers[id])
      .filter((p): p is NonNullable<typeof p> => !!p);
    const workStart = Math.min(...enabled.map((p) => p.workStart));
    const workEnd = Math.max(...enabled.map((p) => p.workEnd));
    // workEnd is exclusive -> hours workStart..workEnd-1
    const hours = workEnd - workStart === 1 ? `${workStart}` : `${workStart}-${workEnd - 1}`;
    const min = tickMinutes >= 60 ? '0' : `*/${tickMinutes}`;
    line = `${min} ${hours} * * * ${SELF_INVOCATION.join(' ')} tick >> ${CRON_LOG} 2>&1`;
  } else {
    // Fixed mode: union of all enabled providers' schedules.
    const hours = Array.from(
      new Set(multi.shared.providers.flatMap((id) => multi.providers[id]?.schedule ?? [])),
    ).sort((a, b) => a - b);
    line = `0 ${hours.join(',')} * * * ${SELF_INVOCATION.join(' ')} tick >> ${CRON_LOG} 2>&1`;
  }
  return `${BEGIN}\n${line}\n${END}`;
}

export function apply(multi: MultiConfig): boolean {
  const base = stripBlock(readCrontab());
  return writeCrontab((base ? base + '\n' : '') + buildBlock(multi) + '\n');
}

export function remove(): boolean {
  const base = stripBlock(readCrontab());
  return writeCrontab(base ? base + '\n' : '');
}

export function status(): { installed: boolean } {
  return { installed: readCrontab().includes(BEGIN) };
}
