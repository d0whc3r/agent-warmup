import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_ENV_LINES, sandbox } from './helpers/sandbox.js';

// `provider list` and `detect` colour their status dot; match on the plain text.
// (The escape is built rather than written as a literal control character.)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s: string): string => s.replaceAll(ANSI, '');

// The headless subcommands are the scriptable surface of the tool: every one of
// them either writes warmup.env or exits non-zero with a usable message. These
// tests drive the real CLI inside a sandboxed HOME (see helpers/sandbox.ts).

test('help lists the commands and where the files live', () => {
  const s = sandbox();
  const result = s.run('help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-warmup — align coding-agent quota windows/);
  for (const cmd of ['status', 'usage', 'tick', 'run', 'detect', 'provider', 'logs']) {
    assert.ok(result.stdout.includes(`agent-warmup ${cmd}`), `help omits ${cmd}`);
  }
  assert.ok(result.stdout.includes(path.join(s.warmupHome, 'warmup.env')));
  assert.ok(result.stdout.includes(path.join(s.warmupHome, 'usage-cache.json')));
  assert.ok(result.stdout.includes(path.join(s.warmupHome, 'logs', 'warmup.log')));
  // -h / --help are aliases, not unknown commands.
  assert.equal(s.run('-h').status, 0);
  assert.equal(s.run('--help').status, 0);
});

test('an unknown command exits 1 and still shows the help', () => {
  const s = sandbox();
  const result = s.run('frobnicate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: frobnicate/);
  assert.match(result.stdout, /Usage:/);
});

test('mode and scheduler only accept their documented choices', () => {
  const s = sandbox();
  const ok = s.run('mode', 'smart');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✓ mode set: smart/);
  assert.match(s.config(), /WARMUP_MODE=smart/);

  const bad = s.run('mode', 'turbo');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /mode must be one of: smart, fixed/);
  const missing = s.run('mode');
  assert.equal(missing.status, 1);

  const badScheduler = s.run('scheduler', 'systemd');
  assert.equal(badScheduler.status, 1);
  assert.match(badScheduler.stderr, /scheduler must be one of: /);
  // The rejected values never reached the config.
  assert.doesNotMatch(s.config(), /turbo|systemd/);
});

test('schedule stores in-range hours and rejects everything else', () => {
  const s = sandbox();
  const ok = s.run('schedule', '7', '9', '22');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✓ schedule set: 7 9 22/);
  assert.match(s.config(), /WARMUP_CODEX_SCHEDULE=7,9,22/);
  // Out-of-range and non-numeric hours are filtered; nothing left means an error.
  const bad = s.run('schedule', '24', 'noon', '-1');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Provide hours 0-23/);
  assert.match(s.config(), /WARMUP_CODEX_SCHEDULE=7,9,22/, 'the old schedule survived');
});

test('model is free-form per provider but validated for claude', () => {
  const s = sandbox();
  // codex is selected here, so its own model ids are accepted verbatim.
  const ok = s.run('model', 'gpt-5.6-sol');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(s.config(), /WARMUP_CODEX_MODEL=gpt-5\.6-sol/);
  assert.equal(s.run('model').status, 1, 'a missing name is a usage error');

  const claude = sandbox({
    envLines: [...DEFAULT_ENV_LINES, 'WARMUP_CLAUDE_ENABLED=true'].map((l) =>
      l === 'WARMUP_SELECTED_PROVIDER=codex' ? 'WARMUP_SELECTED_PROVIDER=claude' : l,
    ),
  });
  const bad = claude.run('model', 'gpt-5.6-sol');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /model must be one of: haiku, sonnet, opus/);
  assert.equal(claude.run('model', 'sonnet').status, 0);
});

test('provider list shows every built-in agent and marks the selected one', () => {
  const s = sandbox();
  const result = s.run('provider', 'list');
  assert.equal(result.status, 0, result.stderr);
  const listed = plain(result.stdout);
  for (const id of ['claude', 'codex', 'zai', 'kimi', 'opencode', 'minimax']) {
    assert.ok(new RegExp(`^[●○] ${id}\\s`, 'm').test(listed), `${id} is missing`);
  }
  assert.match(listed, /codex.*enabled=true.*usage=live.*\(selected\)/);
  assert.match(listed, /kimi.*enabled=false.*usage=estimated/);
  // A bare `provider` behaves like `provider list`.
  assert.equal(s.run('provider').stdout, result.stdout);
});

test('provider enable adds the agent to the run set, disable takes it back out', () => {
  const s = sandbox();
  const enabled = s.run('provider', 'kimi', 'enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /✓ kimi enabled/);
  assert.match(s.config(), /WARMUP_PROVIDERS=codex,kimi/);
  assert.match(s.config(), /WARMUP_KIMI_ENABLED=true/);

  const disabled = s.run('provider', 'kimi', 'disable');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(s.config(), /WARMUP_PROVIDERS=codex\n/);
  assert.match(s.config(), /WARMUP_KIMI_ENABLED=false/);
});

test('only an enabled provider can be selected', () => {
  const s = sandbox();
  const rejected = s.run('provider', 'kimi', 'select');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /✗ provider kimi is disabled; enable it before selecting it/);
  assert.match(s.config(), /WARMUP_SELECTED_PROVIDER=codex/);

  s.run('provider', 'kimi', 'enable');
  const ok = s.run('provider', 'kimi', 'select');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(s.config(), /WARMUP_SELECTED_PROVIDER=kimi/);
});

test('provider model, binary and schedule write only that provider stanza', () => {
  const s = sandbox();
  assert.equal(s.run('provider', 'kimi', 'model', 'kimi-code/kimi-for-coding-highspeed').status, 0);
  assert.equal(s.run('provider', 'kimi', 'binary', '~/bin/kimi').status, 0);
  assert.equal(s.run('provider', 'kimi', 'schedule', '9', '14').status, 0);
  const config = s.config();
  assert.match(config, /WARMUP_KIMI_MODEL=kimi-code\/kimi-for-coding-highspeed/);
  assert.match(config, /WARMUP_KIMI_BIN=~\/bin\/kimi/);
  assert.match(config, /WARMUP_KIMI_SCHEDULE=9,14/);
  assert.match(config, /WARMUP_CODEX_SCHEDULE=8,13,18/, 'codex was left alone');
});

test('provider rejects a bad id, a missing value and an unknown subcommand', () => {
  const s = sandbox();
  const badId = s.run('provider', 'gemini', 'enable');
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /provider id must be one of: claude, codex/);

  const badAction = s.run('provider', 'kimi', 'levitate');
  assert.equal(badAction.status, 1);
  assert.match(badAction.stderr, /Unknown provider subcommand: levitate/);
  assert.match(badAction.stderr, /Usage: agent-warmup provider \[list \| <id>/);

  assert.equal(s.run('provider', 'kimi', 'model').status, 1);
  assert.equal(s.run('provider', 'kimi', 'binary').status, 1);
  assert.equal(s.run('provider', 'kimi', 'schedule', '99').status, 1);
});

test('detect reports each agent read-only, and --apply saves the paths it found', () => {
  // A stub `codex` on the sandbox PATH, so detection has something deterministic
  // to find that is *not* the configured ~/.local/bin/codex.
  // An empty inherited PATH keeps the scan off whatever the host has installed.
  const s = sandbox({ bins: { codex: '#!/usr/bin/env bash\nexit 0\n' }, env: { PATH: '' } });
  const found = path.join(s.home, 'bin', 'codex');

  const dry = s.run('detect');
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(found));
  assert.match(dry.stdout, /\(config points at ~\/\.local\/bin\/codex\)/);
  assert.match(dry.stdout, /Run `agent-warmup detect --apply` to save the detected paths\./);
  assert.doesNotMatch(s.config(), /WARMUP_CODEX_BIN=.*\/bin\/codex\n/);

  const applied = s.run('detect', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(plain(applied.stdout), /✓ saved paths for: codex$/m);
  assert.ok(s.config().includes(`WARMUP_CODEX_BIN=${found}`));
  // Second run: every configured path now works, so there is nothing to write.
  const again = s.run('detect', '--apply');
  assert.match(again.stdout, /✓ nothing to change — every configured binary path is valid/);
});

test('provider <id> detect saves one path and fails loudly when there is none', () => {
  const s = sandbox({ bins: { codex: '#!/usr/bin/env bash\nexit 0\n' }, env: { PATH: '' } });
  const ok = s.run('provider', 'codex', 'detect');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(s.config().includes(`WARMUP_CODEX_BIN=${path.join(s.home, 'bin', 'codex')}`));

  // `kimi` lives at ~/.kimi-code/bin/kimi, which the sandbox home does not have.
  const missing = s.run('provider', 'kimi', 'detect');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /✗ kimi: no "kimi" executable found on this machine/);
});

test('enable and disable toggle the installed launchd agent', () => {
  const s = sandbox();
  assert.match(s.run('enable').stdout, /✓ enabled/);
  assert.match(s.run('disable').stdout, /✓ disabled/);
});

test('run refuses an unknown agent and a disabled one', () => {
  const s = sandbox();
  const unknown = s.run('run', '--provider', 'gemini');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--provider must be one of: claude, codex/);

  const disabled = s.run('run', '--provider', 'kimi');
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /✗ provider kimi is disabled \(enable it with: /);
});

test('a config with every agent disabled falls back to claude rather than doing nothing', () => {
  // parseMultiConfig's safety net: an empty run set is a footgun, so claude is
  // re-enabled. `run` therefore always has something to arm.
  const stub = path.join(os.tmpdir(), `agent-warmup-claude-stub-${process.pid}.sh`);
  fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "ARMED claude"\n');
  fs.chmodSync(stub, 0o755);
  const s = sandbox({
    envLines: DEFAULT_ENV_LINES.map((l) =>
      l === 'WARMUP_CODEX_ENABLED=true' ? 'WARMUP_CODEX_ENABLED=false' : l,
    ),
    env: { WARMUP_CLAUDE_SCRIPT: stub },
  });
  const result = s.run('run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[claude\] ARMED claude$/m);
  assert.match(result.stdout, /^✓ claude$/m);
});

test('logs says so when nothing has been written yet', () => {
  const s = sandbox();
  const result = s.run('logs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No logs yet — run a warmup first\./);
});

test('logs tails the warmup log when there is one', () => {
  const s = sandbox();
  const logDir = path.join(s.warmupHome, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'warmup.log'), '[2026-09-05 10:00:00] TICK [codex] warm\n');
  const result = s.run('logs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TICK \[codex\] warm/);
});

test('usage falls back to the local estimate for an agent with no live probe', () => {
  const s = sandbox();
  s.run('provider', 'kimi', 'enable');
  const result = s.run('usage', '--provider', 'kimi');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /probing kimi \(kimi-code\/kimi-for-coding\)…/);
  assert.match(result.stdout, /source {3}estimated from local warmup history \(Kimi Code\)/);
  const cache = JSON.parse(fs.readFileSync(path.join(s.warmupHome, 'usage-cache.json'), 'utf8'));
  assert.ok(cache.providers.kimi, 'the probe result was cached');
});

test('the no-TTY fallback prints the status instead of opening the TUI', () => {
  const s = sandbox();
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\(no TTY — showing status; run in a terminal for the interactive UI\)/,
  );
  assert.match(result.stdout, /agent-warmup {2}inactive/);
});
