import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseUsage, formatUsage, inferFromCache } from '../src/providers/claude.js';
import { parseReset, FIVE_HOURS_MS } from '../src/time.js';

// A trimmed but faithful capture of a real `/usage` pane (active 5h window).
const SAMPLE = `
  Current session
  ███████████████                                    30% used
  Resets 3:30pm (Europe/Madrid)

  Current week (all models)
  ██                                                 4% used
  Resets Jun 14 at 11am (Europe/Madrid)

  Current week (Sonnet only)
                                                     0% used

  d to day · w to week
`;

const NOW = new Date(2026, 5, 13, 13, 0, 0); // Sat Jun 13 2026, 13:00 local

test('parseUsage reads session, weekly and per-model blocks', () => {
  const u = parseUsage(SAMPLE, NOW);
  assert.ok(u.session && u.week && u.weekModel);
  assert.equal(u.session.pct, 30);
  assert.equal(u.session.active, true);
  assert.equal(u.session.resetsAt!.getHours(), 15);
  assert.equal(u.session.resetsAt!.getMinutes(), 30);

  assert.equal(u.week.pct, 4);
  assert.equal(u.week.resetsAt!.getMonth(), 5); // June
  assert.equal(u.week.resetsAt!.getDate(), 14);
  assert.equal(u.week.resetsAt!.getHours(), 11);

  assert.equal(u.weekModel.label, 'Sonnet only');
  assert.equal(u.weekModel.pct, 0);
  assert.equal(u.weekModel.resetsAt, null);
});

// Verbatim from `claude --model haiku` + /usage on 2026-09-06 (v2.1.263). The second
// weekly heading now names the current secondary model, so a parser keyed on the
// literal "Current week (Sonnet only)" silently returned nothing for it.
const SAMPLE_2026_09 = `
   Current session
   ████████████████████████████████████████████▌    93% used
   Resets 8:59am (Europe/Madrid)

   Current week (all models)
   ██████████████████                               36% used
   Resets Sep 6 at 10:59am (Europe/Madrid)
   +50% weekly limits promo through Sep 13 · clau.de/cc-50-promo

   Current week (Fable)
   ███████████████████████▌                         45% used
   Resets Sep 6 at 10:59am (Europe/Madrid)
`;

test('parseUsage keeps up with a renamed per-model weekly heading', () => {
  const now = new Date(2026, 8, 6, 7, 0, 0); // Sun Sep 6 2026, 07:00 local
  const u = parseUsage(SAMPLE_2026_09, now);

  assert.equal(u.session!.pct, 93);
  assert.equal(u.session!.active, true);
  assert.equal(u.session!.resetsAt!.getHours(), 8);
  assert.equal(u.session!.resetsAt!.getMinutes(), 59);

  assert.equal(u.week!.pct, 36);
  assert.equal(u.week!.resetsAt!.getDate(), 6);
  assert.equal(u.week!.resetsAt!.getHours(), 10);

  // The block Claude used to call "Sonnet only" — matched by shape, labelled live.
  assert.equal(u.weekModel!.label, 'Fable');
  assert.equal(u.weekModel!.pct, 45);
  assert.equal(u.weekModel!.resetsAt!.getHours(), 10);
});

test('parseUsage reports no per-model block when Claude renders only the two', () => {
  const twoBlocks = `
  Current session
                                                     0% used

  Current week (all models)
  ██                                                 4% used
  Resets Jun 14 at 11am (Europe/Madrid)
`;
  assert.equal(parseUsage(twoBlocks, NOW).weekModel, null);
});

test('a fresh 0% session is not active', () => {
  const fresh = `
  Current session
                                                     0% used

  Current week (all models)
  ██                                                 4% used
  Resets Jun 14 at 11am (Europe/Madrid)
`;
  const u = parseUsage(fresh, NOW);
  assert.ok(u.session);
  assert.equal(u.session.pct, 0);
  assert.equal(u.session.active, false);
});

test('parseReset: clock-only that already passed today rolls to tomorrow', () => {
  const now = new Date(2026, 5, 13, 22, 0, 0);
  const d = parseReset('1:00am', now);
  assert.equal(d!.getDate(), 14);
  assert.equal(d!.getHours(), 1);
});

test('parseReset: 12h am/pm parsing', () => {
  const now = new Date(2026, 5, 13, 8, 0, 0);
  assert.equal(parseReset('12pm', now)!.getHours(), 12);
  assert.equal(parseReset('11:30am', now)!.getHours(), 11);
  assert.equal(parseReset('11:30am', now)!.getMinutes(), 30);
});

test('formatUsage returns null when there is nothing to show', () => {
  assert.equal(formatUsage(null), null);
  assert.equal(formatUsage({}), null); // cache exists but carries no session/week
});

test('formatUsage renders an active session with its reset clock', () => {
  const v = formatUsage({
    session: { pct: 30, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) },
    week: { pct: 4, resetsAt: new Date(2026, 5, 14, 11, 0) },
    capturedAt: Date.now() - 45 * 60 * 1000,
  })!;
  assert.equal(v.session, '30% · resets 15:30');
  assert.equal(v.week, '4% · resets Jun 14 11:00');
  assert.equal(typeof v.ageMin, 'number');
});

test('formatUsage marks an idle session and copes with a missing percentage', () => {
  assert.equal(formatUsage({ session: { pct: 0, active: false } })!.session, '0% (idle)');
  const noPct = formatUsage({
    session: { pct: null, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) },
  })!;
  assert.equal(noPct.session, '—% · resets 15:30');
  assert.equal(formatUsage({ week: { pct: 7 } })!.ageMin, null); // no capturedAt → unknown age
});

test('inferFromCache treats a warmup within the last 5h as an active window', () => {
  const now = new Date(2026, 5, 13, 13, 0, 0);
  const lastWarmAt = now.getTime() - 60 * 60 * 1000; // one hour ago
  const u = inferFromCache(now, { lastWarmAt });
  assert.equal(u.inferred, true);
  assert.equal(u.session!.active, true);
  assert.equal(u.session!.pct, 1);
  assert.equal(u.session!.resetsAt!.getTime(), lastWarmAt + FIVE_HOURS_MS);
  assert.equal(u.week, null);
});

test('inferFromCache treats a stale or absent warmup as no active window', () => {
  const now = new Date(2026, 5, 13, 13, 0, 0);
  const stale = inferFromCache(now, { lastWarmAt: now.getTime() - 6 * 60 * 60 * 1000 });
  assert.equal(stale.session!.active, false);
  assert.equal(stale.session!.pct, 0);
  assert.equal(stale.session!.resetsAt, null);

  const empty = inferFromCache(now, null);
  assert.equal(empty.session!.active, false);
  assert.equal(empty.inferred, true);
});
