import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { sandbox } from './helpers/sandbox.js';

// End-to-end cover for the side of the scheduler the pure generators in
// scheduler.test.ts cannot reach: installing, removing and repairing the crontab
// block. The sandbox shims `crontab`/`launchctl`, so nothing here can touch the
// developer's real crontab or LaunchAgents.
const FOREIGN = '0 0 * * * /usr/bin/backup\n# my own note\n';

const withCrontab = (crontabText: string) => sandbox({ crontabText });

test('start appends our marked block and leaves foreign crontab lines alone', () => {
  const s = withCrontab(FOREIGN);
  const result = s.run('start');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ scheduler installed and loaded/);
  const text = s.crontab();
  assert.ok(text.includes('0 0 * * * /usr/bin/backup'), 'foreign entry survived');
  assert.match(text, /# >>> claude-warmup >>>\n0 8,13,18 \* \* \* .* tick >> /);
  assert.ok(text.includes(path.join(s.warmupHome, 'logs', 'cron.log')));
});

test('status reports the installed cron entry and every provider block', () => {
  const s = withCrontab(FOREIGN);
  s.run('start');
  const result = s.run('status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACTIVE {2}\(fixed · cron · 1 provider\)/);
  assert.match(result.stdout, /schedule {3}08:00 {2}13:00 {2}18:00/);
  assert.match(result.stdout, /cron {7}installed=true/);
  assert.match(result.stdout, /codex {5}model=gpt-5\.6-luna {2}session=codex-warmup/);
  assert.match(result.stdout, /session {4}idle \(estimated\)/);
  assert.match(result.stdout, /next run {3}\d\d:00 (today|tomorrow)/);
});

test('stop removes only our block; a second stop leaves the crontab untouched', () => {
  const s = withCrontab(FOREIGN);
  s.run('start');
  const afterStart = s.crontabWrites();
  const result = s.run('stop');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.crontab().trim(), FOREIGN.trim());
  assert.equal(s.crontabWrites(), afterStart + 1);
  // Nothing of ours is installed any more, so remove() must not rewrite the
  // crontab — writing it needlessly is what re-triggers macOS's Full Disk Access
  // prompt on every invocation.
  s.run('stop');
  assert.equal(s.crontabWrites(), afterStart + 1, 'a no-op stop did not write the crontab');
});

test('status repairs a cron block still logging to a moved home', () => {
  // A block installed before the home moved keeps appending to the old path; the
  // status-reading entry points re-apply it so logging follows the config.
  const s = withCrontab(
    FOREIGN +
      '# >>> claude-warmup >>>\n' +
      '0 8,13,18 * * * /usr/bin/false tick >> /tmp/old-home/logs/cron.log 2>&1\n' +
      '# <<< claude-warmup <<<\n',
  );
  const result = s.run('status');
  assert.equal(result.status, 0, result.stderr);
  const text = s.crontab();
  assert.ok(!text.includes('/tmp/old-home/logs/cron.log'), 'the stale line was replaced');
  assert.ok(text.includes(path.join(s.warmupHome, 'logs', 'cron.log')));
  assert.ok(text.includes('0 0 * * * /usr/bin/backup'));
});

test('a healthy cron block is left as-is by the staleness repair', () => {
  const s = withCrontab(FOREIGN);
  s.run('start');
  const installed = s.crontab();
  const before = s.crontabWrites();
  s.run('status');
  assert.equal(s.crontab(), installed);
  assert.equal(s.crontabWrites(), before, 'a fresh block is not rewritten');
});

test('restart reinstalls the block in one pass', () => {
  const s = withCrontab(FOREIGN);
  s.run('start');
  const result = s.run('restart');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ scheduler reloaded/);
  const text = s.crontab();
  assert.equal(text.split('# >>> claude-warmup >>>').length - 1, 1, 'exactly one block');
  assert.ok(text.includes('0 0 * * * /usr/bin/backup'));
});

test('switching the scheduler while installed re-applies it', () => {
  const s = withCrontab(FOREIGN);
  s.run('start');
  const result = s.run('scheduler', 'cron');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ scheduler set: cron \(applied\)/);
  assert.match(s.config(), /WARMUP_SCHEDULER=cron/);
});
