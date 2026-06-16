import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, pad2 } from '../src/format.js';

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
