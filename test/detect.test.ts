import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { detectAll, detectProvider } from '../src/detect.js';
import { ALL_PROVIDER_IDS } from '../src/providers/index.js';

// The scan looks at the provider's default location (under $HOME), then $PATH, then a
// list of well-known prefixes. Pointing both HOME and PATH at a sandbox keeps the
// assertions independent of whatever agents the machine running the tests has.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-detect-'));
const binDir = path.join(sandbox, 'bin');
fs.mkdirSync(binDir, { recursive: true });
process.env.HOME = sandbox;
process.env.PATH = binDir;

function fakeBinary(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}

test('an agent CLI on PATH is found even when nothing is configured', () => {
  const kimi = fakeBinary(binDir, 'kimi');
  const d = detectProvider('kimi', '');
  assert.equal(d.binary, 'kimi');
  assert.equal(d.path, kimi);
  assert.equal(d.configuredOk, false); // the default ~/.kimi-code path does not exist
});

test('a working configured path wins over anything found on PATH', () => {
  fakeBinary(binDir, 'claude');
  const custom = fakeBinary(path.join(sandbox, 'custom'), 'claude');
  const d = detectProvider('claude', custom);
  assert.equal(d.path, custom);
  assert.equal(d.configuredOk, true);
});

test('a stale configured path is reported and the real binary is offered instead', () => {
  const onPath = fakeBinary(binDir, 'codex');
  const d = detectProvider('codex', path.join(sandbox, 'gone', 'codex'));
  assert.equal(d.configuredOk, false);
  assert.equal(d.path, onPath);
});

test('a directory is never mistaken for an executable', () => {
  fs.mkdirSync(path.join(binDir, 'opencode'), { recursive: true });
  const d = detectProvider('opencode', path.join(binDir, 'opencode'));
  assert.equal(d.configuredOk, false);
});

test('detectAll reports every built-in agent exactly once', () => {
  const all = detectAll();
  assert.deepEqual(
    all.map((d) => d.id),
    [...ALL_PROVIDER_IDS],
  );
  for (const d of all) assert.ok(d.name, `${d.id} should carry its display name`);
});
