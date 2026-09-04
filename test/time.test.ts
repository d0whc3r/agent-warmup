import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  toDate,
  formatClock,
  formatShortDate,
  formatStamp,
  minutesSince,
  FIVE_HOURS_MS,
} from '../src/time.js';

test('toDate coerces Date | ISO string | epoch ms, rejects garbage', () => {
  const d = new Date(2026, 5, 13, 15, 30, 0);
  assert.equal(toDate(d), d); // Date passes through
  assert.equal(toDate(d.toISOString())!.getTime(), d.getTime());
  assert.equal(toDate(d.getTime())!.getTime(), d.getTime());
  assert.equal(toDate(null), null);
  assert.equal(toDate('not a date'), null);
});

test('formatClock / formatShortDate format valid input and fall back otherwise', () => {
  const d = new Date(2026, 5, 13, 15, 30, 0);
  assert.equal(formatClock(d), '15:30');
  assert.equal(formatShortDate(d), 'Jun 13 15:30');
  assert.equal(formatClock(null), ''); // default fallback
  assert.equal(formatClock('nope', '?'), '?'); // custom fallback
});

test('formatStamp renders a log timestamp', () => {
  assert.equal(formatStamp(new Date(2026, 5, 13, 9, 5, 7)), '2026-06-13 09:05:07');
});

test('minutesSince returns whole elapsed minutes, null-safe', () => {
  const now = new Date(2026, 5, 13, 15, 30, 0);
  assert.equal(minutesSince(now.getTime() - 3 * 60_000, now), 3);
  assert.equal(minutesSince(null, now), null);
});

test('FIVE_HOURS_MS is five hours in milliseconds', () => {
  assert.equal(FIVE_HOURS_MS, 5 * 60 * 60 * 1000);
});
