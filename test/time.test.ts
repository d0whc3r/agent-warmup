import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  toDate,
  formatClock,
  formatShortDate,
  formatStamp,
  minutesSince,
  parseReset,
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
  assert.equal(formatShortDate('nope', '?'), '?');
});

test('formatStamp renders a log timestamp', () => {
  assert.equal(formatStamp(new Date(2026, 5, 13, 9, 5, 7)), '2026-06-13 09:05:07');
});

test('parseReset wraps a dated reset into next year once the day is long past', () => {
  const dec15 = new Date(2026, 11, 15, 10, 0, 0);
  const d = parseReset('Jun 14 at 11am', dec15)!;
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 14);
});

test('parseReset rejects phrases it cannot read and reads 12am as midnight', () => {
  const now = new Date(2026, 5, 13, 10, 0, 0);
  assert.equal(parseReset('pretty soon', now), null);
  assert.equal(parseReset('Foo 14 at 11am', now), null); // unknown month
  assert.equal(parseReset('Jun 14 at sometime', now), null); // unreadable clock
  assert.equal(parseReset('12am', now)!.getHours(), 0);
  assert.equal(parseReset('12:30pm', now)!.getMinutes(), 30);
});

test('minutesSince returns whole elapsed minutes, null-safe', () => {
  const now = new Date(2026, 5, 13, 15, 30, 0);
  assert.equal(minutesSince(now.getTime() - 3 * 60_000, now), 3);
  assert.equal(minutesSince(null, now), null);
});
