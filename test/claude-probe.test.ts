import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProbeContext } from '../src/providers/types.js';
import type { ProviderUsage } from '../src/types.js';

// probe() drives a real tmux session, so the tests point TMUX_BIN at a stub that
// keeps a pane file and answers the four verbs the probe uses. The state machine:
// a pane showing a trust prompt flips to READY on Enter; any other pane flips to
// the /usage capture on Enter (send-keys of the typed '/usage' text changes nothing).
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-claude-probe-home-'));
const TMUX_FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-claude-probe-tmux-'));

const TRUST_CURSOR_PANE = [
  'Do you trust the files in this folder?',
  '  ❯ 1. No, exit',
  '    2. Yes, I trust this folder',
].join('\n');
const TRUST_NUMBERED_PANE = [
  'Do you trust the files in this folder?',
  '  1. Yes, proceed',
  '  2. No, exit',
].join('\n');
const READY_PANE = 'Welcome to Claude Code';
const USAGE_PANE = [
  '  Current session',
  '  ███████████████                                    30% used',
  '  Resets 3:30pm (Europe/Madrid)',
  '',
  '  Current week (all models)',
  '  ██                                                 4% used',
  '  Resets Jun 14 at 11am (Europe/Madrid)',
].join('\n');

const TMUX_STUB = path.join(TMUX_FAKE_DIR, 'tmux');
fs.writeFileSync(
  TMUX_STUB,
  [
    '#!/usr/bin/env bash',
    'PANE="$TMUX_FAKE_DIR/pane"',
    'case "$1" in',
    '  kill-session) rm -f "$PANE"; exit 0 ;;',
    '  new-session) printf \'%s\' "$TMUX_INITIAL_PANE" > "$PANE"; exit "${TMUX_NEW_SESSION_STATUS:-0}" ;;',
    '  capture-pane) [ -f "$PANE" ] && cat "$PANE"; exit 0 ;;',
    '  send-keys)',
    '    shift',
    '    keys=""',
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    '        -t) shift 2 ;;',
    '        -l) shift ;;',
    '        *) keys="$keys$1"; shift ;;',
    '      esac',
    '    done',
    '    if [ "$keys" = "Enter" ]; then',
    '      pane="$(cat "$PANE" 2>/dev/null)"',
    '      case "$pane" in',
    '        *trust*) printf \'%s\' "$TMUX_READY_PANE" > "$PANE" ;;',
    '        *) printf \'%s\' "$TMUX_USAGE_PANE" > "$PANE" ;;',
    '      esac',
    '    fi',
    '    exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'),
);
fs.chmodSync(TMUX_STUB, 0o755);

// The stub binary stands in for the claude CLI (the probe only checks it is
// executable) and everything lands in the sandbox home.
process.env.WARMUP_HOME = HOME_DIR;
process.env.TMUX_BIN = TMUX_STUB;
// The trust flow hard-codes two short waits; the tunable ones shrink to ~0.
process.env.WARMUP_READY_WAIT = '0.01';
process.env.WARMUP_RESPONSE_WAIT = '0.01';
process.env.TMUX_FAKE_DIR = TMUX_FAKE_DIR;
process.env.TMUX_READY_PANE = READY_PANE;
process.env.TMUX_USAGE_PANE = USAGE_PANE;

// Everything the probe reads (TMUX_BIN, WARMUP_HOME) is resolved at import time,
// so the env has to be in place before this import — no static src imports above.
const { DEFAULT_MULTI } = await import('../src/config.js');
const { claudeProvider } = await import('../src/providers/claude.js');
// The probe lives behind the Provider interface (it is module-private in claude.ts).
const probe = claudeProvider.probe;

const ctx = (binary: string): ProbeContext => ({
  cfg: { ...DEFAULT_MULTI.providers.claude!, binary },
  shared: DEFAULT_MULTI.shared,
  now: new Date(2026, 5, 13, 13, 0, 0),
});

const stubBinary = (): string => {
  const file = path.join(TMUX_FAKE_DIR, `claude-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
};

async function probeWith(pane: string, binary = stubBinary()): Promise<ProviderUsage | null> {
  process.env.TMUX_INITIAL_PANE = pane;
  try {
    return await probe(ctx(binary));
  } finally {
    delete process.env.TMUX_INITIAL_PANE;
  }
}

test('the probe drives /usage past a cursor-style trust prompt', async () => {
  const usage = await probeWith(TRUST_CURSOR_PANE);
  // "Yes, I trust this folder" is not under the cursor, so Down moves onto it.
  assert.ok(usage);
  assert.equal(usage.session!.pct, 30);
  assert.equal(usage.week!.pct, 4);
  assert.equal(usage.capturedAt, new Date(2026, 5, 13, 13, 0, 0).getTime());
});

test('the probe answers a numbered trust prompt with the digit', async () => {
  const usage = await probeWith(TRUST_NUMBERED_PANE);
  assert.ok(usage);
  assert.equal(usage.session!.pct, 30);
});

test('a ready session goes straight to /usage', async () => {
  const usage = await probeWith(READY_PANE);
  assert.ok(usage);
  assert.equal(usage.week!.pct, 4);
});

test('a pane without any limit block yields no snapshot', async () => {
  process.env.TMUX_USAGE_PANE = 'nothing to see here';
  try {
    assert.equal(await probeWith(READY_PANE), null);
  } finally {
    process.env.TMUX_USAGE_PANE = USAGE_PANE;
  }
});

test('the probe bails out when the binary or the tmux session is unusable', async () => {
  assert.equal(await probe(ctx(path.join(HOME_DIR, 'missing-claude'))), null);
  process.env.TMUX_NEW_SESSION_STATUS = '1';
  try {
    assert.equal(await probeWith(READY_PANE), null);
  } finally {
    delete process.env.TMUX_NEW_SESSION_STATUS;
  }
});
