import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A disposable machine for the CLI: its own HOME, its own WARMUP_HOME, and shims
// for `crontab`/`launchctl` on PATH. Any command that reaches the scheduler (status
// reads it, every setter re-applies it when active) would otherwise edit the
// developer's real crontab and LaunchAgents.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.ts');

const CRONTAB_SHIM = `#!/usr/bin/env bash
case "$1" in
  -l) [ -f "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;
  -)  cat > "$FAKE_CRONTAB"; printf 'w\\n' >> "$FAKE_CRONTAB.writes" ;;
  *)  exit 1 ;;
esac
`;
const LAUNCHCTL_SHIM = '#!/usr/bin/env bash\nexit 0\n';

export const DEFAULT_ENV_LINES = [
  'WARMUP_MODE=fixed',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=codex',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_CODEX_SCHEDULE=8,13,18',
  'WARMUP_CLAUDE_ENABLED=false',
];

export interface SandboxOptions {
  crontabText?: string;
  envLines?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Extra executables to drop on the sandbox PATH, e.g. a stub agent CLI. */
  bins?: Record<string, string>;
}

export interface Sandbox {
  home: string;
  warmupHome: string;
  run: (...args: string[]) => SpawnSyncReturns<string>;
  config: () => string;
  crontab: () => string;
  crontabWrites: () => number;
}

export function sandbox(options: SandboxOptions = {}): Sandbox {
  const { crontabText = '', envLines = DEFAULT_ENV_LINES, env = {}, bins = {} } = options;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-sandbox-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ['crontab', CRONTAB_SHIM],
    ['launchctl', LAUNCHCTL_SHIM],
    ...Object.entries(bins),
  ]) {
    fs.writeFileSync(path.join(bin, name!), body!);
    fs.chmodSync(path.join(bin, name!), 0o755);
  }
  const warmupHome = path.join(home, 'warmup');
  fs.mkdirSync(warmupHome, { recursive: true });
  const configPath = path.join(warmupHome, 'warmup.env');
  fs.writeFileSync(configPath, envLines.join('\n') + '\n');
  const crontabFile = path.join(home, 'crontab.txt');
  fs.writeFileSync(crontabFile, crontabText);
  return {
    home,
    warmupHome,
    run: (...args) =>
      spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          PATH: `${bin}:${env.PATH ?? process.env.PATH}`,
          HOME: home,
          WARMUP_HOME: warmupHome,
          FAKE_CRONTAB: crontabFile,
        },
      }),
    config: () => fs.readFileSync(configPath, 'utf8'),
    crontab: () => fs.readFileSync(crontabFile, 'utf8'),
    crontabWrites: () => {
      try {
        return fs.readFileSync(`${crontabFile}.writes`, 'utf8').trim().split('\n').length;
      } catch {
        return 0;
      }
    },
  };
}
