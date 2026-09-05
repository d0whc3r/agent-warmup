import { spawn, spawnSync } from 'node:child_process';
// Run a provider's warmup now and read recent log output.
import fs from 'node:fs';
import readline from 'node:readline';

import { ensureArmScript } from './assets.js';
import { updateProviderCache } from './cache.js';
import { loadConfig } from './config.js';
import { appendLog } from './logs.js';
import { WARMUP_LOG, LOG_DIR, WARMUP_HOME, expandHome } from './paths.js';
import { getProvider } from './providers/index.js';
import type { ProviderId } from './types.js';

// An arm that has not finished by then is stuck (tmux never came up, a login prompt
// is waiting for input). Kill it so one hung agent cannot wedge the whole run/tick.
const ARM_TIMEOUT_MS = 5 * 60_000;

// Spawn the arm script for the given provider (or the selected one when omitted)
// and resolve with its exit status. Forwards the right env so the script can read
// provider-specific knobs (binary, model, tmux session, workdir). Output is streamed
// line by line with an `[id]` prefix, so several agents can arm at once and their
// output still reads. Records the outcome (lastWarmAt, or the provider's cooldown
// bookkeeping) in the usage cache so estimated-usage providers know a window is
// active whether the arm came from the scheduler tick or a manual run.
export async function runNow(id?: ProviderId, now: Date = new Date()): Promise<number> {
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
  const status = await spawnArm(selected, script, env);

  updateProviderCache(selected, (entry) => {
    if (adapter.recordArmResult) {
      const recorded = adapter.recordArmResult(ctx, entry, status);
      if (recorded.log) appendLog(now, `TICK [${selected}] ${recorded.log}`);
      return recorded.cache;
    }
    return status === 0 ? { ...entry, lastWarmAt: now.getTime() } : entry;
  });
  return status;
}

function spawnArm(id: ProviderId, script: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ARM_TIMEOUT_MS,
    });
    const prefix = (input: NodeJS.ReadableStream, out: NodeJS.WriteStream) =>
      readline.createInterface({ input }).on('line', (line) => out.write(`[${id}] ${line}\n`));
    prefix(child.stdout, process.stdout);
    prefix(child.stderr, process.stderr);
    child.on('error', () => resolve(1));
    // A timeout kill arrives as a signal with no exit code; report it like timeout(1).
    child.on('close', (code, signal) => resolve(code ?? (signal ? 124 : 1)));
  });
}

// Warm every enabled agent at once. This is what "Run warmup now" means: the same
// set the scheduler would arm, just immediately. Agents are independent, so one
// failing (or slow) agent never delays or cancels another; the per-agent summary at
// the end is where a failure shows up after the interleaved output. Returns the
// first non-zero exit status so a failure anywhere reaches the caller.
export async function runEnabled(): Promise<number> {
  const multi = loadConfig();
  const ids = multi.shared.providers.filter((id) => multi.providers[id]?.enabled);
  if (!ids.length) {
    process.stderr.write('✗ no agents are enabled\n');
    return 1;
  }
  const statuses = await Promise.all(ids.map((id) => runNow(id)));
  for (const [i, id] of ids.entries()) {
    const status = statuses[i]!;
    process.stdout.write(
      `${status === 0 ? '✓' : '✗'} ${id}${status === 0 ? '' : ` failed (status ${status})`}\n`,
    );
  }
  return statuses.find((s) => s !== 0) ?? 0;
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
