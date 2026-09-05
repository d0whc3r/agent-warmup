import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// appendLog/pruneLogs write under WARMUP_HOME (resolved at import time), so the
// sandbox exists before the module loads. Retention is read from the env once.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-logs-io-'));
process.env.WARMUP_HOME = HOME_DIR;
process.env.WARMUP_LOG_RETENTION_DAYS = '1';

const { appendLog, pruneLogs } = await import('../src/logs.js');
const { CRON_LOG, LOG_DIR, WARMUP_LOG } = await import('../src/paths.js');

test('appendLog stamps the line and creates the log dir on demand', () => {
  appendLog(new Date(2026, 5, 13, 9, 5, 7), 'TICK [kimi] warm');
  assert.equal(fs.readFileSync(WARMUP_LOG, 'utf8'), '[2026-06-13 09:05:07] TICK [kimi] warm\n');
});

test('pruneLogs trims rolling logs by stamp and deletes old pane captures', () => {
  const now = new Date(2026, 5, 13, 12, 0, 0);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(WARMUP_LOG, '[2026-06-01 10:00:00] old\n[2026-06-12 23:00:00] fresh\n');
  fs.writeFileSync(CRON_LOG, '[2026-06-01 10:00:00] old cron\n[2026-06-13 11:00:00] new cron\n');

  const oldPane = path.join(LOG_DIR, 'pane-old.txt');
  const newPane = path.join(LOG_DIR, 'pane-new.txt');
  fs.writeFileSync(oldPane, 'x');
  fs.utimesSync(oldPane, now, new Date(now.getTime() - 3 * 86_400_000));
  fs.writeFileSync(newPane, 'x');
  fs.writeFileSync(path.join(LOG_DIR, 'notes.txt'), 'not a pane capture');

  pruneLogs(now);
  // 1-day retention: the Jun 1 lines are gone, the fresh ones stay.
  assert.equal(fs.readFileSync(WARMUP_LOG, 'utf8'), '[2026-06-12 23:00:00] fresh\n');
  assert.equal(fs.readFileSync(CRON_LOG, 'utf8'), '[2026-06-13 11:00:00] new cron\n');
  assert.ok(!fs.existsSync(oldPane), 'the old pane capture is deleted');
  assert.ok(fs.existsSync(newPane), 'the recent pane capture stays');
  assert.ok(fs.existsSync(path.join(LOG_DIR, 'notes.txt')), 'non-pane files are untouched');
});

test('pruneLogs survives a missing log dir', () => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  assert.doesNotThrow(() => pruneLogs(new Date()));
});
