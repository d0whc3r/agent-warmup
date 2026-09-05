import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, pad2, tildify } from '../src/format.js';

test('ago reads in minutes under an hour and rounds to hours beyond', () => {
  assert.equal(ago(0), '0m ago');
  assert.equal(ago(45), '45m ago');
  assert.equal(ago(60), '1h ago');
  assert.equal(ago(90), '2h ago'); // rounds to the nearest hour
});

test('pad2 zero-pads to two digits', () => {
  assert.equal(pad2(8), '08');
  assert.equal(pad2(13), '13');
});

test('tildify collapses only a real home-directory prefix', () => {
  const home = '/Users/dev';
  assert.equal(tildify('/Users/dev/tools/claude', home), '~/tools/claude');
  assert.equal(tildify('/usr/local/bin/claude', home), '/usr/local/bin/claude');
  // A bare prefix match is not the home dir ("/Users/dev2" is someone else's).
  assert.equal(tildify('/Users/dev2/tools/claude', home), '/Users/dev2/tools/claude');
});
