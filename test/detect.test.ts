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

// zai, minimax and opencode-go all arm through the same `opencode` binary, so its
// presence says nothing about whether a given plan can run: what gates them is the
// credential opencode stores under the plan's id.
function writeOpencodeAuth(keys: string[]): void {
  const dir = path.join(sandbox, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, { type: 'api' }]))),
  );
}

test('an opencode-backed plan is not detected without its credential', () => {
  fakeBinary(binDir, 'opencode');
  writeOpencodeAuth(['opencode-go']);

  const zai = detectProvider('zai', '');
  assert.equal(zai.path, null, 'the opencode binary alone must not light zai up');
  assert.equal(zai.configuredOk, false);
  assert.match(zai.blocked!, /zai-coding-plan/);

  assert.equal(detectProvider('minimax', '').blocked !== null, true);

  // The plan opencode *does* hold a credential for is detected as normal.
  const go = detectProvider('opencode', '');
  assert.equal(go.blocked, null);
  assert.ok(go.path);
});

test('adding the credential is enough to detect the plan', () => {
  fakeBinary(binDir, 'opencode');
  writeOpencodeAuth(['opencode-go', 'zai-coding-plan']);
  const zai = detectProvider('zai', '');
  assert.equal(zai.blocked, null);
  assert.equal(zai.path, path.join(binDir, 'opencode'));
});

test('a missing or unreadable opencode auth file blocks the plans, not the agents', () => {
  fs.rmSync(path.join(sandbox, '.local', 'share', 'opencode', 'auth.json'), { force: true });
  fakeBinary(binDir, 'opencode');
  assert.equal(detectProvider('zai', '').path, null);
  // Agents with a CLI of their own are unaffected by opencode's credential store.
  assert.ok(detectProvider('codex', '').path);
});

test('a directory is never mistaken for an executable', () => {
  writeOpencodeAuth(['opencode-go']); // get past the credential gate to reach the scan
  const asDir = path.join(sandbox, 'as-dir', 'opencode');
  fs.mkdirSync(asDir, { recursive: true });
  const d = detectProvider('opencode', asDir);
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
