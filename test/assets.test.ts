import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// ensureArmScript writes under WARMUP_HOME, which is resolved at import time.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-assets-'));
process.env.WARMUP_HOME = HOME_DIR;

const { ensureArmScript } = await import('../src/assets.js');
const { ARM_SCRIPT, ARM_SCRIPT_SRC } = await import('../src/paths.js');
const { getProvider } = await import('../src/providers/index.js');

test('a provider without a source script gets one materialized under WARMUP_HOME', () => {
  const dest = ensureArmScript('zai');
  assert.equal(dest, ARM_SCRIPT('zai'));
  assert.equal(dest, path.join(HOME_DIR, 'arm-zai.sh'));
  assert.equal(fs.readFileSync(dest, 'utf8'), getProvider('zai').armScript());
  assert.ok(fs.statSync(dest).mode & 0o111, 'the materialized script is executable');
  // Idempotent: an existing script is reused, not rewritten.
  assert.equal(ensureArmScript('zai'), dest);
});

test('providers that ship a source script are used in place', () => {
  const dest = ensureArmScript('claude');
  assert.equal(dest, ARM_SCRIPT_SRC('claude'));
  assert.ok(fs.statSync(dest).mode & 0o111);
});
