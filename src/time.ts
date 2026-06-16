// Centralized date/time helpers. Every date parse, format and duration in the
// project goes through here, so the date-fns dependency and the bespoke `/usage`
// clock formats live in exactly one place.
import {
  addDays,
  addMilliseconds,
  addYears,
  differenceInMilliseconds,
  differenceInMinutes,
  format,
  getHours,
  hoursToMilliseconds,
  isAfter,
  isValid,
} from 'date-fns';

// Re-exported so the date-fns import stays in this one module (see header): other
// files pull these from './time.js' rather than depending on 'date-fns' directly.
export { addMilliseconds, differenceInMilliseconds, getHours, isAfter };

// Anything that can stand in for an instant. Cache round-trips turn Dates into ISO
// strings and epoch numbers, so callers can't assume a real Date.
type DateLike = Date | string | number;

const MONTHS: Record<string, number | undefined> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const DAY_MS = hoursToMilliseconds(24);
export const FIVE_HOURS_MS = hoursToMilliseconds(5);

// Coerce anything (Date | ISO string | epoch ms) to a valid Date, or null. Cache
// round-trips turn Dates into ISO strings, so callers can't assume a real Date.
export function toDate(value: DateLike | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isValid(d) ? d : null;
}

// "3:30pm" / "11am" / "3pm" / "11:00am" -> { h, m } in 24h, or null.
// Kept as a regex (not date-fns `parse`) because the format is space-less and
// lowercase; pre-normalizing it for date-fns would be more fragile than this.
export function parseClock(s: string): { h: number; m: number } | null {
  const m = String(s)
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return { h, m: m[2] ? Number(m[2]) : 0 };
}

// Turn a "Resets ..." phrase into an absolute Date relative to `now`.
//   "3:30pm"          -> today at 15:30 (or tomorrow if it already passed → window wrapped midnight)
//   "Jun 14 at 11am"  -> that calendar day this year (next year if it already passed)
export function parseReset(when: string, now: Date = new Date()): Date | null {
  const text = String(when).trim();
  const dated = text.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s+at\s+(.+)$/i);
  if (dated) {
    const month = MONTHS[dated[1].slice(0, 3).toLowerCase()];
    const day = Number(dated[2]);
    const t = parseClock(dated[3]);
    if (month == null || !t) return null;
    let d = new Date(now.getFullYear(), month, day, t.h, t.m, 0, 0);
    if (differenceInMilliseconds(now, d) > DAY_MS) d = addYears(d, 1); // year wrap (e.g. Dec → Jan)
    return d;
  }
  const t = parseClock(text);
  if (t) {
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m, 0, 0);
    if (!isAfter(d, now)) d = addDays(d, 1); // wrapped past midnight
    return d;
  }
  return null;
}

// Safe formatters: coerce + validate, fall back to `fallback` on unparseable input.
export function formatClock(value: DateLike | null | undefined, fallback = ''): string {
  const d = toDate(value);
  return d ? format(d, 'HH:mm') : fallback;
}

export function formatShortDate(value: DateLike | null | undefined, fallback = ''): string {
  const d = toDate(value);
  return d ? format(d, 'MMM d HH:mm') : fallback;
}

// Log-line timestamp. Always called with a real Date, so no fallback needed.
export function formatStamp(date: Date): string {
  return format(date, 'yyyy-MM-dd HH:mm:ss');
}

// Inverse of formatStamp: parse a "yyyy-MM-dd HH:mm:ss" prefix back to epoch ms
// (interpreted in local time, matching formatStamp), or null if it doesn't match.
export function parseStampMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, se);
  return isValid(date) ? date.getTime() : null;
}

// Whole minutes elapsed since an epoch-ms instant, relative to `now` (null-safe).
export function minutesSince(ms: number | null | undefined, now: Date = new Date()): number | null {
  return ms == null ? null : differenceInMinutes(now, ms);
}
