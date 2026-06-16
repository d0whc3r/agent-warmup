// Run a provider's warmup now and read recent log output.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WARMUP_LOG, LOG_DIR, ARM_SCRIPT } from './paths.js';
import { loadConfig } from './config.js';
import { ensureArmScript } from './assets.js';

import type { ProviderId } from './types.js';

// Spawn the arm script for the given provider (or the selected one when
// omitted) and return its exit status. Forwards the right env so the script
// can read provider-specific knobs (binary, model, tmux session, workdir).
export function runNow(id?: ProviderId): number {
  const multi = loadConfig();
  const selected = id ?? multi.shared.selectedProvider;
  const provider = multi.providers[selected];
  if (!provider) {
    process.stderr.write(`✗ no such provider: ${selected}\n`);
    return 1;
  }
  if (!provider.enabled) {
    process.stderr.write(
      `✗ provider ${selected} is disabled (enable it in the TUI or with: claude-warmup provider ${selected} enable)\n`,
    );
    return 1;
  }
  ensureArmScript(selected);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WARMUP_BIN: expandHome(provider.binary),
    WARMUP_MODEL: provider.model,
    WARMUP_TMUX_SESSION: provider.tmuxSession,
  };
  // Surface the right binary hint in the env for the opencode script too
  // (the script's OPENCODE_BIN falls back to WARMUP_BIN, which is what we set).
  if (selected === 'opencode') {
    env.OPENCODE_BIN = expandHome(provider.binary);
  } else {
    env.CLAUDE_BIN = expandHome(provider.binary);
  }
  const script = ARM_SCRIPT(selected);
  const r = spawnSync('/bin/bash', [script], { stdio: 'inherit', env });
  return r.status ?? 1;
}

// Open the warmup log in a navigable view. On an interactive terminal we hand off to
// `less` so the user keeps control: q quits, / searches, & filters, F follows live.
// `follow` starts in live-follow mode (less +F, like `tail -f`); otherwise we open at
// the newest line (+G) and let the user scroll/search back. Falls back to `tail` when
// there is no TTY (pipes/CI) or no `less` on PATH.
export function viewLogs(follow: boolean): number {
  if (!fs.existsSync(WARMUP_LOG)) {
    console.log('No logs yet — run a warmup first.');
    return 0;
  }
  if (process.stdout.isTTY) {
    const hint = 'q quit  /=search  &=filter  F=follow';
    const r = spawnSync('less', ['-R', follow ? '+F' : '+G', `-PM${hint}`, WARMUP_LOG], {
      stdio: 'inherit',
    });
    if (!r.error) return r.status ?? 0; // only fall through if `less` is missing (ENOENT)
  }
  const args = ['-n', '60'];
  if (follow) args.push('-f');
  args.push(WARMUP_LOG);
  return spawnSync('tail', args, { stdio: 'inherit' }).status ?? 0;
}

export function lastRunSummary(): string | null {
  try {
    const lines = fs.readFileSync(WARMUP_LOG, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/OK:|WARN:|ERROR:|TICK /.test(lines[i])) return lines[i];
    }
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

// Tiny `~` expander for binary paths the user wrote in the env ("~/.local/bin/claude").
// Doesn't go through $HOME-aware expansion because the env files are edited by hand
// and we want the literal value the user picked.
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return process.env.HOME + p.slice(1);
  return p;
}
