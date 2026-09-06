// Centralized paths and identifiers used across the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

import type { ProviderId } from './types.js';

// In a single-executable build there is no source file on disk — import.meta.url is
// a data: URL — so anchor on the executable instead of the source location.
const IN_SEA = isSea();
const SRC_DIR = IN_SEA
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));

export const HOME = os.homedir();
const UID = os.userInfo().uid;

// Repo root (package dir), so paths work wherever the project lives.
const REPO_ROOT = path.resolve(SRC_DIR, '..');

// Single home for everything the warmup owns — logs, config, cache and the tmux
// workdir all live here, so the footprint is one self-contained, age-managed dir.
// Provider-neutral on purpose: the tool warms several agents, so nothing of its own
// lives under any one agent's dot-dir. WARMUP_HOME always wins when explicitly set.
const GENERIC_HOME = path.join(HOME, '.agent-warmup');
export const LEGACY_HOME = path.join(HOME, '.claude', 'warmup');
export const WARMUP_HOME = process.env.WARMUP_HOME || GENERIC_HOME;

// One-shot move of a pre-rename install (~/.claude/warmup) into the neutral home.
// Runs at CLI startup; a no-op once the new home exists or WARMUP_HOME is set.
export function migrateLegacyHome(): boolean {
  if (process.env.WARMUP_HOME || fs.existsSync(GENERIC_HOME) || !fs.existsSync(LEGACY_HOME)) {
    return false;
  }
  fs.renameSync(LEGACY_HOME, GENERIC_HOME);
  return true;
}

// The CLI entry node is currently executing: the bundled bin (dist/agent-warmup.mjs)
// when installed, or src/cli.js under tsx / the global shim in dev. Resolved to an
// absolute path so the scheduler can re-invoke `… tick` regardless of launchd/cron's
// working directory. (argv[1] is the real entry whatever its filename; the fallback
// only matters in the degenerate case of no script entry.)
const CLI_ENTRY = path.resolve(process.argv[1] ?? path.join(SRC_DIR, 'cli.js'));
// The node binary running this process — embedded in the smart-mode plist/cron so
// the scheduler can invoke the tick without relying on a login PATH.
const NODE_BIN = process.execPath;
// How a scheduler entry re-invokes this CLI headlessly: the executable itself when
// packaged (it is its own entry point), `node <entry>` for the npm bundle, and
// `node --import <tsx loader> <entry>` when running from source under tsx — plain
// node cannot load a .ts entry, so a plist made from `pnpm dev` would fail silently.
const DEV_TS = !IN_SEA && /\.tsx?$/.test(CLI_ENTRY);
export const SELF_INVOCATION = IN_SEA
  ? [process.execPath]
  : DEV_TS
    ? [NODE_BIN, '--import', fileURLToPath(import.meta.resolve('tsx')), CLI_ENTRY]
    : [NODE_BIN, CLI_ENTRY];

// Tiny `~` expander for paths the user wrote in the env ("~/.local/bin/claude").
// Doesn't go through $HOME-aware expansion because the env files are edited by hand
// and we want the literal value the user picked. Used by the probes + the runner
// so per-provider binary paths honor the same shorthand everywhere.
export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return os.homedir() + p.slice(1);
  return p;
}

// tmux lives in different prefixes per platform (Homebrew on macOS, /usr/bin on most
// Linux). Pick the first that exists so the probe's accessSync() guard gets an absolute
// path; fall back to a bare name (resolved via PATH when spawned) if none are found.
function firstExecutable(candidates: string[], fallback: string): string {
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return fallback;
}
export const TMUX_BIN =
  process.env.TMUX_BIN ||
  firstExecutable(
    ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux'],
    'tmux',
  );
export const WARMUP_WORKDIR = process.env.WARMUP_WORKDIR || path.join(WARMUP_HOME, 'workdir');

// Per-provider arm scripts (one per provider; the registry decides which get
// materialized). Source path is where the script ships in the source tree;
// runtime path is where it lands under WARMUP_HOME for SEA / npm installs.
const ASSETS_DIR = path.join(REPO_ROOT, 'src', 'assets');
export const ARM_SCRIPT_SRC = (id: ProviderId): string => path.join(ASSETS_DIR, `arm-${id}.sh`);
export const ARM_SCRIPT = (id: ProviderId): string => {
  const override = process.env[`WARMUP_${id.toUpperCase()}_SCRIPT`];
  if (override) return override;
  const source = ARM_SCRIPT_SRC(id);
  return !IN_SEA && fs.existsSync(source) ? source : path.join(WARMUP_HOME, `arm-${id}.sh`);
};

// launchd
export const LABEL = 'com.d0whc3r.claude-warmup';
export const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const GUI_DOMAIN = `gui/${UID}`;

// logs + config (all under WARMUP_HOME)
export const LOG_DIR = path.join(WARMUP_HOME, 'logs');
export const WARMUP_LOG = path.join(LOG_DIR, 'warmup.log');
export const CRON_LOG = path.join(LOG_DIR, 'cron.log');
export const CONFIG_PATH = path.join(WARMUP_HOME, 'warmup.env');

// Per-provider usage cache ({ providers: { <id>: snapshot } }); the pre-multi-provider
// flat shape is migrated on read.
export const USAGE_CACHE = path.join(WARMUP_HOME, 'usage-cache.json');
