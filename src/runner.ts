import { spawnSync } from 'node:child_process';
// Run a provider's warmup now and read recent log output.
import fs from 'node:fs';

import { ensureArmScript } from './assets.js';
import { readCache, writeCache } from './cache.js';
import { loadConfig } from './config.js';
import { appendLog } from './logs.js';
import { WARMUP_LOG, LOG_DIR, WARMUP_HOME } from './paths.js';
import { getProvider } from './providers/index.js';
import type { ProviderId } from './types.js';

// Spawn the arm script for the given provider (or the selected one when
// omitted) and return its exit status. Forwards the right env so the script
// can read provider-specific knobs (binary, model, tmux session, workdir).
// Records the outcome (lastWarmAt, or the provider's cooldown bookkeeping) in
// the usage cache so estimated-usage providers know a window is active whether
// the arm came from the scheduler tick or a manual run.
export function runNow(id?: ProviderId, now: Date = new Date()): number {
  const multi = loadConfig();
  const selected = id ?? multi.shared.selectedProvider;
  const provider = multi.providers[selected];
  if (!provider) {
    process.stderr.write(`✗ no such provider: ${selected}\n`);
    return 1;
  }
  if (!provider.enabled) {
    process.stderr.write(
      `✗ provider ${selected} is disabled (enable it with: agent-warmup provider ${selected} enable)\n`,
    );
    return 1;
  }
  const adapter = getProvider(selected);
  const script = ensureArmScript(selected);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ctx = { cfg: provider, shared: multi.shared, now };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WARMUP_BIN: expandHome(provider.binary),
    WARMUP_MODEL: provider.model,
    WARMUP_TMUX_SESSION: provider.tmuxSession,
    WARMUP_HOME,
    ...adapter.armEnv(ctx),
  };
  // Expand provider-supplied binary paths after the adapter has populated them.
  for (const key of ['CLAUDE_BIN', 'CODEX_BIN', 'KIMI_BIN', 'OPENCODE_BIN']) {
    if (env[key]) env[key] = expandHome(env[key]);
  }
  const r = spawnSync('/bin/bash', [script], { stdio: 'inherit', env });
  const status = r.status ?? 1;

  const cache = readCache();
  const entry = cache.providers[selected] ?? {};
  if (adapter.recordArmResult) {
    const recorded = adapter.recordArmResult(ctx, entry, status);
    cache.providers[selected] = recorded.cache;
    if (recorded.log) appendLog(now, `TICK [${selected}] ${recorded.log}`);
  } else if (status === 0) {
    cache.providers[selected] = { ...entry, lastWarmAt: now.getTime() };
  }
  writeCache(cache);
  return status;
}

// Warm every enabled agent, in the order the tick would visit them. This is what
// "Run warmup now" means: the same set the scheduler would arm, just immediately.
// Returns the first non-zero exit status so a failure anywhere reaches the caller.
export function runEnabled(): number {
  const multi = loadConfig();
  const ids = multi.shared.providers.filter((id) => multi.providers[id]?.enabled);
  if (!ids.length) {
    process.stderr.write('✗ no agents are enabled\n');
    return 1;
  }
  let worst = 0;
  for (const id of ids) {
    if (ids.length > 1) process.stdout.write(`\n── ${id} ──\n`);
    const status = runNow(id);
    if (status !== 0 && worst === 0) worst = status;
  }
  return worst;
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
