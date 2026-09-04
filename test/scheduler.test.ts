// The scheduler generators turn a Config into the artifacts that actually drive the
// warmup: a launchd plist and a crontab block. A bug here means the wrong schedule
// gets installed, so the generated text is asserted directly (the surrounding
// launchctl/crontab I/O is thin glue and not exercised here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlist } from '../src/launchd.js';
import { buildBlock, stripBlock } from '../src/cron.js';
import type { MultiConfig, SmartConfig } from '../src/types.js';

// Wrap a legacy flat Config into a MultiConfig for the new scheduler signatures.
// The launchd/cron generators now consume MultiConfig; the test still builds the
// data the same way (smart.workStart/workEnd/tickMinutes/weeklyStopPercent) and
// just lifts them into the multi shape.
function toMulti(legacy: MultiConfig & { smart: SmartConfig }): MultiConfig {
  const { smart, ...rest } = legacy as unknown as {
    smart: SmartConfig;
    mode: string;
    schedule: number[];
    model: string;
    scheduler: string;
    tmuxSession: string;
  };
  return {
    shared: {
      mode: rest.mode as 'smart' | 'fixed',
      scheduler: rest.scheduler as 'launchd' | 'cron',
      tickMinutes: smart.tickMinutes,
      providers: ['claude'],
      selectedProvider: 'claude',
    },
    providers: {
      claude: {
        id: 'claude',
        enabled: true,
        binary: '',
        model: rest.model,
        tmuxSession: rest.tmuxSession,
        armScriptPath: '',
        workStart: smart.workStart,
        workEnd: smart.workEnd,
        weeklyStopPercent: smart.weeklyStopPercent,
        schedule: rest.schedule,
        extra: {},
      },
      opencode: {
        id: 'opencode',
        enabled: false,
        binary: '',
        model: '',
        tmuxSession: '',
        armScriptPath: '',
        workStart: 7,
        workEnd: 22,
        weeklyStopPercent: 85,
        schedule: [],
        extra: {},
      },
    },
  };
}

const smart: MultiConfig = toMulti({
  mode: 'smart',
  schedule: [8, 13, 18],
  smart: { workStart: 9, workEnd: 18, tickMinutes: 30, weeklyStopPercent: 80 },
  model: 'haiku',
  scheduler: 'launchd',
  tmuxSession: 'claude-warmup',
} as never);
const fixed: MultiConfig = {
  ...smart,
  shared: { ...smart.shared, mode: 'fixed', scheduler: 'cron' },
};

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test('generatePlist (smart) emits one calendar interval per tick across the band', () => {
  const plist = generatePlist(smart);
  // (workEnd - workStart) hours × (60 / tickMinutes) ticks/hour = 9 × 2 = 18.
  assert.equal(count(plist, '<key>Hour</key>'), 18);
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>30<\/integer>/);
  // Smart mode runs the tick (probe + decide), not warmup.sh.
  assert.match(plist, /<string>tick<\/string>/);
  // Plist no longer carries WARMUP_MODEL/WARMUP_TMUX_SESSION; the tick reads
  // the warmup.env on disk for per-provider env. (Spec §5.)
});

test('generatePlist (fixed) emits one interval per scheduled hour and runs warmup.sh', () => {
  const plist = generatePlist(fixed);
  assert.equal(count(plist, '<key>Hour</key>'), 3);
  for (const h of [8, 13, 18]) {
    assert.ok(plist.includes(`<integer>${h}</integer>`), `missing hour ${h}`);
  }
  // Both modes run the tick (multi-provider: a single entry iterates providers).
  assert.match(plist, /<string>tick<\/string>/);
});

test('buildBlock (smart) renders the working band as a */tick cron expression', () => {
  const block = buildBlock(smart);
  // workEnd is exclusive, so 9..18 → hours 9-17; tick 30 → every half hour.
  assert.match(block, /^# >>> claude-warmup >>>\n\*\/30 9-17 \* \* \* /);
  assert.match(block, /tick >> .*\n# <<< claude-warmup <<<$/);
});

test('buildBlock (smart) collapses to "0" minutes and a single hour at the edges', () => {
  const hourly = buildBlock({ ...smart, shared: { ...smart.shared, tickMinutes: 60 } });
  assert.match(hourly, /\n0 9-17 \* \* \* /); // tick >= 60 fires on the hour
  const oneHour = buildBlock({
    ...smart,
    providers: {
      ...smart.providers,
      claude: { ...smart.providers.claude!, workStart: 8, workEnd: 9 },
    },
  });
  assert.match(oneHour, /\n\*\/30 8 \* \* \* /); // single-hour band has no range
});

test('buildBlock (fixed) lists the scheduled hours and spawns warmup.sh', () => {
  const block = buildBlock(fixed);
  assert.match(block, /\n0 8,13,18 \* \* \* /);
  // Both modes run the tick (multi-provider: single scheduler entry).
  assert.match(block, /tick >> /);
});

test('stripBlock removes our marked block and leaves foreign lines untouched', () => {
  const foreign = '0 0 * * * /usr/bin/backup\n# my own note';
  const withBlock = foreign + '\n' + buildBlock(fixed);
  assert.equal(stripBlock(withBlock), foreign);
  // Idempotent: stripping then re-appending never duplicates the block markers.
  const reapplied = stripBlock(withBlock) + '\n' + buildBlock(fixed);
  assert.equal(count(reapplied, '# >>> claude-warmup >>>'), 1);
});
