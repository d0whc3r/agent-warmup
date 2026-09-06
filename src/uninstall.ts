// Full teardown of everything the tool installed outside its own home: the launchd
// plist, the crontab block, the tmux sessions the arm scripts leave behind, and the
// disposable state under WARMUP_HOME. Config and logs are deliberately kept.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { TMUX_BIN, USAGE_CACHE, WARMUP_HOME, WARMUP_WORKDIR } from './paths.js';
import * as schedule from './schedule.js';

// The sessions an arm run and a usage probe create, for every configured provider.
function tmuxSessions(): string[] {
  const providers = Object.values(loadConfig().providers);
  return providers.flatMap((p) => [p.tmuxSession, `${p.tmuxSession}-usage`]);
}

function removePath(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export function purge(): string[] {
  const removed: string[] = [];

  // Schedulers first: a tick firing mid-teardown would recreate the tmux sessions.
  schedule.stopSchedule();
  removed.push('launchd agent + crontab block');

  for (const session of tmuxSessions()) {
    if (spawnSync(TMUX_BIN, ['kill-session', '-t', session]).status === 0) {
      removed.push(`tmux session ${session}`);
    }
  }

  // Only the copies materialized under WARMUP_HOME; the originals in src/assets
  // belong to the source tree.
  const armScripts = fs.existsSync(WARMUP_HOME)
    ? fs.readdirSync(WARMUP_HOME).filter((f) => /^arm-.+\.sh$/.test(f))
    : [];
  for (const file of armScripts) {
    if (removePath(path.join(WARMUP_HOME, file))) removed.push(path.join(WARMUP_HOME, file));
  }

  if (removePath(WARMUP_WORKDIR)) removed.push(WARMUP_WORKDIR);
  if (removePath(USAGE_CACHE)) removed.push(USAGE_CACHE);

  return removed;
}
