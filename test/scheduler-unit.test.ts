import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// schedule/launchd/cron pin HOME, WARMUP_HOME and the plist path at import time,
// and every apply/stop spawns the real `crontab`/`launchctl` — so before any module
// loads, HOME moves into a sandbox whose PATH carries shims for both binaries.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-sched-unit-'));
const WARMUP_DIR = path.join(HOME_DIR, 'warmup');
const SHIM_DIR = path.join(HOME_DIR, 'bin');
fs.mkdirSync(WARMUP_DIR, { recursive: true });
fs.mkdirSync(SHIM_DIR, { recursive: true });

const CRONTAB_FILE = path.join(HOME_DIR, 'crontab.txt');
const LAUNCHCTL_LOG = path.join(HOME_DIR, 'launchctl.log');
fs.writeFileSync(
  path.join(SHIM_DIR, 'crontab'),
  [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  -l) [ -f "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;',
    '  -)  cat > "$FAKE_CRONTAB"; printf \'w\\n\' >> "$FAKE_CRONTAB.writes" ;;',
    '  *)  exit 1 ;;',
    'esac',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(SHIM_DIR, 'launchctl'),
  [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >> "$FAKE_LAUNCHCTL_LOG"',
    'case "$1" in',
    '  print)',
    '    [ -n "${FAKE_PRINT_STATE:-}" ] && echo "state = $FAKE_PRINT_STATE"',
    '    exit "${FAKE_PRINT_STATUS:-0}" ;;',
    '  print-disabled)',
    '    [ -n "${FAKE_PRINT_DISABLED:-}" ] && printf \'%s\\n\' "$FAKE_PRINT_DISABLED"',
    '    exit 0 ;;',
    '  *) exit "${FAKE_LAUNCHCTL_STATUS:-0}" ;;',
    'esac',
  ].join('\n'),
);
fs.chmodSync(path.join(SHIM_DIR, 'crontab'), 0o755);
fs.chmodSync(path.join(SHIM_DIR, 'launchctl'), 0o755);

process.env.HOME = HOME_DIR;
process.env.WARMUP_HOME = WARMUP_DIR;
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;
process.env.FAKE_CRONTAB = CRONTAB_FILE;
process.env.FAKE_LAUNCHCTL_LOG = LAUNCHCTL_LOG;

const schedule = await import('../src/schedule.js');
const launchd = await import('../src/launchd.js');
const cron = await import('../src/cron.js');
const { writeCache } = await import('../src/cache.js');
const { loadConfig } = await import('../src/config.js');
const { printStatus } = await import('../src/print-status.js');
const { CRON_LOG, LABEL, LOG_DIR, PLIST_PATH, WARMUP_LOG } = await import('../src/paths.js');

const FOREIGN = '0 0 * * * /usr/bin/backup\n# my own note\n';

const writeConfig = (lines: string[]): void => {
  fs.writeFileSync(path.join(WARMUP_DIR, 'warmup.env'), lines.join('\n') + '\n');
};
const crontabWrites = (): number => {
  try {
    return fs.readFileSync(`${CRONTAB_FILE}.writes`, 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
};
const launchctlArgs = (): string[] =>
  fs.readFileSync(LAUNCHCTL_LOG, 'utf8').trim().split('\n').filter(Boolean);

const CRON_KIMI = [
  'WARMUP_MODE=fixed',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=kimi',
  'WARMUP_SELECTED_PROVIDER=kimi',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
  'WARMUP_KIMI_SCHEDULE=8,13,18',
];
const LAUNCHD_KIMI = [
  'WARMUP_MODE=smart',
  'WARMUP_SCHEDULER=launchd',
  'WARMUP_TICK_MINUTES=30',
  'WARMUP_PROVIDERS=kimi',
  'WARMUP_SELECTED_PROVIDER=kimi',
  'WARMUP_KIMI_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
  'WARMUP_KIMI_WORK_START=8',
  'WARMUP_KIMI_WORK_END=18',
];

test('applySchedule (cron) writes our marked block and never the launchd plist', () => {
  writeConfig(CRON_KIMI);
  fs.writeFileSync(CRONTAB_FILE, FOREIGN);
  fs.rmSync(PLIST_PATH, { force: true });
  assert.equal(schedule.applySchedule(loadConfig()), true);
  const text = fs.readFileSync(CRONTAB_FILE, 'utf8');
  assert.ok(text.includes('0 0 * * * /usr/bin/backup'), 'foreign entries survive');
  assert.match(text, /# >>> claude-warmup >>>\n0 8,13,18 \* \* \* .* tick >> /);
  assert.ok(!fs.existsSync(PLIST_PATH), 'no plist for a cron install');
  assert.ok(
    launchctlArgs().some((args) => args.startsWith('bootout ')),
    'launchd is booted out',
  );
});

test('applySchedule (launchd) writes the plist with the tick calendar and clears cron', () => {
  writeConfig(LAUNCHD_KIMI);
  fs.writeFileSync(CRONTAB_FILE, FOREIGN + cron.buildBlock(loadConfig()) + '\n');
  assert.equal(schedule.applySchedule(loadConfig()), true);
  const plist = fs.readFileSync(PLIST_PATH, 'utf8');
  assert.ok(plist.includes(`<string>${LABEL}</string>`));
  assert.match(plist, /<string>tick<\/string>/);
  // 8..17 hourly band at 30m cadence: the first and last hours are both present.
  assert.ok(plist.includes('<integer>8</integer>'));
  assert.ok(plist.includes('<integer>17</integer>'));
  assert.ok(plist.includes(LOG_DIR), 'the plist logs under the warmup home');
  assert.ok(
    !fs.readFileSync(CRONTAB_FILE, 'utf8').includes('claude-warmup >>>'),
    'the cron block is removed',
  );

  // A failing bootstrap is reported, not swallowed.
  process.env.FAKE_LAUNCHCTL_STATUS = '3';
  try {
    assert.equal(schedule.applySchedule(loadConfig()), false);
  } finally {
    delete process.env.FAKE_LAUNCHCTL_STATUS;
  }
});

test('enable/disable address the gui domain + label, status parses launchctl output', () => {
  assert.equal(launchd.enable(), true);
  assert.equal(launchd.disable(), true);
  const target = `gui/${os.userInfo().uid}/${LABEL}`;
  assert.ok(launchctlArgs().includes(`enable ${target}`));
  assert.ok(launchctlArgs().includes(`disable ${target}`));

  fs.writeFileSync(PLIST_PATH, 'plist');
  process.env.FAKE_PRINT_STATE = 'running';
  process.env.FAKE_PRINT_DISABLED = `"${LABEL}" => false`;
  assert.deepEqual(launchd.status(), {
    installed: true,
    loaded: true,
    running: true,
    enabled: true,
  });
  // launchctl prints `true` when the agent is DISABLED.
  process.env.FAKE_PRINT_DISABLED = `"${LABEL}" => true`;
  assert.equal(launchd.status().enabled, false);
  delete process.env.FAKE_PRINT_DISABLED;
  assert.equal(launchd.status().enabled, true, 'no print-disabled answer reads as enabled');
  process.env.FAKE_PRINT_STATUS = '1';
  assert.deepEqual(launchd.status(), {
    installed: true,
    loaded: false,
    running: false,
    enabled: true,
  });
  delete process.env.FAKE_PRINT_STATUS;
  fs.rmSync(PLIST_PATH, { force: true });
});

test('stale detects a plist still logging to a moved home', () => {
  fs.writeFileSync(PLIST_PATH, `StandardOutPath /tmp/old-home/logs/launchd.out.log`);
  assert.equal(launchd.stale(), true);
  fs.writeFileSync(PLIST_PATH, `StandardOutPath ${path.join(LOG_DIR, 'launchd.out.log')}`);
  assert.equal(launchd.stale(), false);
  fs.rmSync(PLIST_PATH, { force: true });
  assert.equal(launchd.stale(), false, 'not installed is not stale');
});

test('stopSchedule removes both schedulers; a second stop touches nothing', () => {
  writeConfig(CRON_KIMI);
  fs.writeFileSync(CRONTAB_FILE, FOREIGN + cron.buildBlock(loadConfig()) + '\n');
  fs.writeFileSync(PLIST_PATH, 'plist');
  schedule.stopSchedule();
  assert.equal(fs.readFileSync(CRONTAB_FILE, 'utf8').trim(), FOREIGN.trim());
  assert.ok(!fs.existsSync(PLIST_PATH));

  const writes = crontabWrites();
  schedule.stopSchedule();
  assert.equal(crontabWrites(), writes, 'a no-op stop does not rewrite the crontab');
  assert.equal(cron.status().installed, false);
});

test('repairStaleEntry re-applies a block that logs to the old home, leaves healthy ones', () => {
  writeConfig(CRON_KIMI);
  fs.writeFileSync(
    CRONTAB_FILE,
    FOREIGN +
      '# >>> claude-warmup >>>\n' +
      '0 8,13,18 * * * /usr/bin/false tick >> /tmp/old-home/logs/cron.log 2>&1\n' +
      '# <<< claude-warmup <<<\n',
  );
  schedule.repairStaleEntry();
  const text = fs.readFileSync(CRONTAB_FILE, 'utf8');
  assert.ok(!text.includes('/tmp/old-home/logs/cron.log'), 'the stale line was replaced');
  assert.ok(text.includes(CRON_LOG), 'the block now logs to the current home');
  assert.ok(text.includes('0 0 * * * /usr/bin/backup'), 'foreign entries survive');

  const writes = crontabWrites();
  schedule.repairStaleEntry();
  assert.equal(crontabWrites(), writes, 'a healthy block is not rewritten');
});

test('printStatus renders the headless status block for both modes', () => {
  // Fixed + cron, installed, with a last-run line and a weekly figure in the cache.
  writeConfig(CRON_KIMI);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(WARMUP_LOG, '[2026-09-05 10:00:00] OK: kimi armed\n');
  writeCache({ providers: { kimi: { week: { pct: 12 }, capturedAt: Date.now() - 60_000 } } });
  fs.writeFileSync(CRONTAB_FILE, FOREIGN + cron.buildBlock(loadConfig()) + '\n');

  const captureLog = (fn: () => void): string => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return lines.join('\n');
  };

  const out = captureLog(printStatus);
  assert.match(out, /agent-warmup\s+ACTIVE\s+\(fixed · cron · 1 provider\)/);
  assert.match(out, /schedule\s+08:00\s+13:00\s+18:00/);
  assert.match(out, /next run\s+\d\d:00 (today|tomorrow)/);
  assert.match(out, /kimi\s+model=kimi-code\/kimi-for-coding\s+session=kimi-warmup/);
  assert.match(out, /weekly\s+12%\s+\(as of 1m ago\)/);
  assert.match(out, /cron\s+installed=true/);
  assert.match(out, /last run\s+2026-09-05 10:00:00\] OK: kimi armed/);

  // Smart + launchd, nothing installed.
  writeConfig(LAUNCHD_KIMI);
  fs.rmSync(CRONTAB_FILE, { force: true });
  const smart = captureLog(printStatus);
  assert.match(smart, /agent-warmup\s+inactive/);
  assert.match(smart, /window\s+08–18h · check every 30m · stop at 85% weekly/);
  assert.match(smart, /launchd\s+installed=false/);
  assert.ok(!smart.includes('next run'), 'an inactive scheduler has no next run');
});
