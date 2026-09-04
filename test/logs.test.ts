import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retainRecentLines } from '../src/logs.js';
import { parseStampMs } from '../src/time.js';

const cutoff = parseStampMs('2026-06-05 00:00:00')!;

test('drops timestamped lines older than the cutoff, keeps newer ones', () => {
  const text =
    '[2026-06-01 10:00:00] old TICK\n' + //
    '[2026-06-10 09:00:00] fresh TICK\n';
  assert.equal(retainRecentLines(text, cutoff), '[2026-06-10 09:00:00] fresh TICK\n');
});

test('continuation lines ride with the most recent timestamp seen', () => {
  const text =
    '[2026-06-01 10:00:00] old\n' +
    '  stale detail\n' + // belongs to the old (dropped) entry
    '[2026-06-10 09:00:00] new\n' +
    '  fresh detail\n'; // belongs to the kept entry
  assert.equal(retainRecentLines(text, cutoff), '[2026-06-10 09:00:00] new\n  fresh detail\n');
});

test('leading untimestamped lines are dropped (nothing kept yet)', () => {
  const text = 'preamble with no stamp\n[2026-06-10 09:00:00] new\n';
  assert.equal(retainRecentLines(text, cutoff), '[2026-06-10 09:00:00] new\n');
});

test('all-old or empty input collapses to an empty string', () => {
  assert.equal(retainRecentLines('[2026-06-01 10:00:00] old\n', cutoff), '');
  assert.equal(retainRecentLines('', cutoff), '');
});

test('files with no parseable timestamps fall back to the last N lines', () => {
  const text = 'a\nb\nc\nd\ne\n';
  assert.equal(retainRecentLines(text, cutoff, 2), 'd\ne\n');
});
