import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Keyboard-driven tests for the TUI. The static render tests cover what each tab
// LOOKS like; these cover what the keys DO -- tab switching, the digit jumps and the
// agent picker, which are the parts a screenshot can never verify.
//
// The controller persists on every change, so WARMUP_HOME is pointed at a sandbox
// BEFORE the modules that resolve CONFIG_PATH are loaded (hence the dynamic imports).
// The action keys (s/t) and the mount-time status read reach the scheduler through
// `crontab`/`launchctl`, so both become shims and HOME moves into the sandbox too —
// no keypress may ever touch the developer's crontab or LaunchAgents.
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-ui-'));
process.env.WARMUP_HOME = SANDBOX;
process.env.HOME = SANDBOX;
const SHIM_DIR = path.join(SANDBOX, 'bin');
fs.mkdirSync(SHIM_DIR, { recursive: true });
const CRONTAB_SHIM = [
  '#!/usr/bin/env bash',
  'case "$1" in',
  '  -l) [ -f "$FAKE_CRONTAB" ] || exit 1; cat "$FAKE_CRONTAB" ;;',
  '  -)  cat > "$FAKE_CRONTAB"; printf \'w\\n\' >> "$FAKE_CRONTAB.writes" ;;',
  '  *)  exit 1 ;;',
  'esac',
].join('\n');
fs.writeFileSync(path.join(SHIM_DIR, 'crontab'), CRONTAB_SHIM);
fs.writeFileSync(path.join(SHIM_DIR, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
fs.chmodSync(path.join(SHIM_DIR, 'crontab'), 0o755);
fs.chmodSync(path.join(SHIM_DIR, 'launchctl'), 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;
process.env.FAKE_CRONTAB = path.join(SANDBOX, 'crontab.txt');
fs.writeFileSync(process.env.FAKE_CRONTAB, '');

// Rewrite the sandbox config per test: every harness re-reads it on mount.
const writeEnv = (lines: string[]): void => {
  fs.writeFileSync(path.join(SANDBOX, 'warmup.env'), lines.join('\n') + '\n');
};

const { render } = await import('ink');
const React = (await import('react')).default;
const { default: App } = await import('../src/ui/App.jsx');
const { loadConfig } = await import('../src/config.js');
const { CONFIG_PATH } = await import('../src/paths.js');

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
// Terminal input the tests send. Written as escape codes rather than raw control
// characters so the source stays greppable and copy-pasteable.
const ESC = String.fromCharCode(27);
const TAB = String.fromCharCode(9);
const ENTER = String.fromCharCode(13);
const BACKSPACE = String.fromCharCode(127);
const SHIFT_TAB = `${ESC}[Z`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

// The agent rows as rendered, plus where the "▶" cursor sits among them. Reading them
// back out of the frame keeps these tests independent of whichever agent the sandbox
// config happens to have selected.
function agentRows(frame: string): { ids: string[]; cursor: number } {
  const ids: string[] = [];
  let cursor = -1;
  for (const line of frame.split('\n')) {
    const m = /(▶)?\s*\[[x ]\] (\w+)/.exec(line);
    if (!m) continue;
    if (m[1]) cursor = ids.length;
    ids.push(m[2]!);
  }
  return { ids, cursor };
}

// A stdin double that speaks Ink's protocol: Ink listens for 'readable' and pulls
// with read(), so a queue plus an event is all a keypress needs.
function harness(columns = 64) {
  const frames: string[] = [];
  const queue: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows: 50,
    write: (chunk: string) => {
      frames.push(String(chunk).replace(ANSI, ''));
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read: () => queue.shift() ?? null,
    unshift: (chunk: string) => queue.unshift(chunk),
  });
  const instance = render(React.createElement(App, {}), {
    stdout,
    stdin,
    // Ink only writes a frame per render when it thinks the environment is
    // interactive; under CI it holds everything back until unmount, so the
    // frames these tests read never arrive. The fake stdout IS the terminal here.
    interactive: true,
    patchConsole: false,
  } as never);
  // Ink batches renders, so a keypress has to yield before the assertion reads the
  // frame. Wait for the frame count to stop growing rather than sleeping a fixed
  // 60ms: it settles in ~4ms instead, and it cannot lose the race on a loaded
  // machine the way a fixed sleep can.
  const press = async (input: string) => {
    const before = frames.length;
    queue.push(input);
    stdin.emit('readable');
    // First wait for the keypress to render at all. Ink skips the write when a frame
    // is byte-identical, so a press that changes nothing visible never arrives; the
    // ceiling is the 60ms this used to sleep unconditionally.
    for (let i = 0; i < 30 && frames.length === before; i++) await delay(2);
    // ...then for the batch to stop growing, so the assertion reads the settled frame.
    for (let previous = -1; previous !== frames.length;) {
      previous = frames.length;
      await delay(2);
    }
  };
  const frame = () => frames.filter((f) => f.includes('agent-warmup')).at(-1) ?? '';
  return { press, frame, instance };
}

test('tab, shift+tab and the digit keys move between tabs', async () => {
  const ui = harness();
  try {
    assert.match(ui.frame(), /\[1 Overview\]/);

    await ui.press(TAB);
    assert.match(ui.frame(), /\[2 Agents\]/, 'tab moves forward');

    await ui.press(TAB);
    assert.match(ui.frame(), /\[3 Schedule\]/);

    await ui.press(TAB);
    assert.match(ui.frame(), /\[1 Overview\]/, 'tab wraps around');

    await ui.press(SHIFT_TAB);
    assert.match(ui.frame(), /\[3 Schedule\]/, 'shift+tab moves back');

    await ui.press('2');
    assert.match(ui.frame(), /\[2 Agents\]/, 'the digit jumps straight to a tab');
    assert.match(ui.frame(), /SETTINGS · /);
  } finally {
    ui.instance.unmount();
  }
});

test('space enables the agent under the cursor and enter opens its settings', async () => {
  const ui = harness();
  try {
    await ui.press('2');
    // The cursor starts on the first agent; move it to the next one.
    await ui.press(RIGHT);
    await ui.press(' '); // enable it
    const config = loadConfig();
    assert.equal(config.providers.codex?.enabled, true, 'space enables the agent under the cursor');
    assert.ok(config.shared.providers.includes('codex'), 'and adds it to the tick list');
    assert.match(ui.frame(), /SETTINGS · codex/, 'the settings follow the cursor');

    await ui.press(ENTER); // enter jumps into that agent's settings
    assert.match(ui.frame(), /▶ Model/, 'enter reaches the settings without walking the list');
    assert.match(ui.frame(), /SETTINGS · codex/, 'still the agent under the cursor');

    assert.ok(CONFIG_PATH.startsWith(process.env.WARMUP_HOME!), 'writes stay in the sandbox');
  } finally {
    ui.instance.unmount();
  }
});

test('up and down walk the agent list and only leave it at the ends', async () => {
  const ui = harness();
  try {
    await ui.press('2');
    const start = agentRows(ui.frame());
    assert.ok(start.cursor >= 0, 'the agents row starts focused');
    assert.ok(start.ids.length > 2, 'there are several agents to walk');

    await ui.press(DOWN);
    const moved = agentRows(ui.frame());
    assert.equal(moved.cursor, start.cursor + 1, 'down moves inside the list');

    await ui.press(UP);
    assert.equal(agentRows(ui.frame()).cursor, start.cursor, 'up moves back inside the list');

    // Walk to the last agent: the list still owns the focus the whole way down.
    for (let i = start.cursor; i < start.ids.length - 1; i++) await ui.press(DOWN);
    assert.equal(agentRows(ui.frame()).cursor, start.ids.length - 1);

    // Only now does down hand focus to the next row.
    await ui.press(DOWN);
    assert.equal(agentRows(ui.frame()).cursor, -1, 'the list releases focus at its end');
    assert.match(ui.frame(), /▶ Model/);
  } finally {
    ui.instance.unmount();
  }
});

test('the settings rows follow the agent cursor, so each agent keeps its own model', async () => {
  const ui = harness();
  try {
    await ui.press('2');
    const first = agentRows(ui.frame());
    const firstId = first.ids[first.cursor]!;
    assert.match(ui.frame(), new RegExp(`SETTINGS · ${firstId}`));

    // Move to another agent WITHOUT selecting or enabling it: its settings follow.
    await ui.press(DOWN);
    const nextId = agentRows(ui.frame()).ids[first.cursor + 1]!;
    assert.match(ui.frame(), new RegExp(`SETTINGS · ${nextId}`));

    const before = loadConfig();
    // enter drops straight into that agent's settings, whatever its position.
    await ui.press(ENTER);
    assert.match(ui.frame(), /▶ Model/);
    await ui.press(RIGHT);

    const after = loadConfig();
    assert.notEqual(
      after.providers[nextId as keyof typeof after.providers]?.model,
      before.providers[nextId as keyof typeof before.providers]?.model,
      'the cursor agent got the new model',
    );
    assert.equal(
      after.providers[firstId as keyof typeof after.providers]?.model,
      before.providers[firstId as keyof typeof before.providers]?.model,
      'the other agent is untouched',
    );
    assert.equal(after.shared.selectedProvider, before.shared.selectedProvider);
    assert.equal(
      after.providers[nextId as keyof typeof after.providers]?.enabled,
      before.providers[nextId as keyof typeof before.providers]?.enabled,
      'editing an agent never enables it behind your back',
    );
  } finally {
    ui.instance.unmount();
  }
});

const CLAUDE_ONLY = [
  'WARMUP_MODE=smart',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=claude',
  'WARMUP_SELECTED_PROVIDER=claude',
  'WARMUP_CLAUDE_ENABLED=true',
];
const CODEX_SELECTED = [
  'WARMUP_MODE=smart',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=claude,codex',
  'WARMUP_SELECTED_PROVIDER=claude',
  'WARMUP_CLAUDE_ENABLED=true',
  'WARMUP_CODEX_ENABLED=true',
];
// claude fully out of the picture: the selected agent is codex.
const CODEX_ONLY = [
  'WARMUP_MODE=smart',
  'WARMUP_SCHEDULER=cron',
  'WARMUP_PROVIDERS=codex',
  'WARMUP_SELECTED_PROVIDER=codex',
  'WARMUP_CODEX_ENABLED=true',
  'WARMUP_CLAUDE_ENABLED=false',
];

test('? toggles the help overlay', async () => {
  writeEnv(CLAUDE_ONLY);
  const ui = harness();
  try {
    await ui.press('?');
    assert.match(ui.frame(), /KEYBOARD SHORTCUTS/);
    await ui.press('?'); // the same key closes it again
    assert.doesNotMatch(ui.frame(), /KEYBOARD SHORTCUTS/);
  } finally {
    ui.instance.unmount();
  }
});

test('m toggles the mode and p cycles the selected provider', async () => {
  writeEnv(CODEX_SELECTED);
  const ui = harness();
  try {
    await ui.press('m');
    assert.match(ui.frame(), /Mode → fixed/);
    assert.equal(loadConfig().shared.mode, 'fixed');
    await ui.press('m');
    assert.equal(loadConfig().shared.mode, 'smart');

    await ui.press('p');
    assert.match(ui.frame(), /Provider → codex/);
    assert.equal(loadConfig().shared.selectedProvider, 'codex');
  } finally {
    ui.instance.unmount();
  }
});

test('p with a single enabled agent explains instead of cycling', async () => {
  writeEnv(CLAUDE_ONLY);
  const ui = harness();
  try {
    await ui.press('p');
    assert.match(ui.frame(), /Only one provider enabled/);
    assert.equal(loadConfig().shared.selectedProvider, 'claude');
  } finally {
    ui.instance.unmount();
  }
});

test('d reports a working configured binary and, on a bare PATH, a missing one', async () => {
  const stub = path.join(SANDBOX, 'stub-codex');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  writeEnv([...CODEX_ONLY, `WARMUP_CODEX_BIN=${stub}`]);
  const ui = harness();
  try {
    await ui.press('d');
    // The configured path works, so detection keeps it (tildified against the sandbox HOME).
    assert.match(ui.frame(), /codex binary ok — ~\/stub-codex/);
  } finally {
    ui.instance.unmount();
  }

  const realPath = process.env.PATH;
  process.env.PATH = SHIM_DIR; // nothing agent-like anywhere to find
  try {
    writeEnv([
      'WARMUP_PROVIDERS=kimi',
      'WARMUP_SELECTED_PROVIDER=kimi',
      'WARMUP_KIMI_ENABLED=true',
      'WARMUP_CLAUDE_ENABLED=false',
    ]);
    const ui2 = harness();
    try {
      await ui2.press('d');
      assert.match(ui2.frame(), /kimi: no "kimi" found on this machine/);
    } finally {
      ui2.instance.unmount();
    }
  } finally {
    process.env.PATH = realPath;
  }
});

test('enter edits the tmux session; typing commits it, escape abandons it', async () => {
  writeEnv(CODEX_ONLY);
  const ui = harness();
  try {
    await ui.press('2');
    // The AGENT cursor starts on the selected agent (codex); enter jumps into its
    // settings on the Model row, ↓↓ reaches the tmux session row.
    await ui.press(ENTER);
    assert.match(ui.frame(), /SETTINGS · codex/);
    await ui.press(DOWN);
    await ui.press(DOWN);
    await ui.press(ENTER);
    assert.match(ui.frame(), /Renaming session/);

    await ui.press('x');
    await ui.press(ENTER);
    assert.match(ui.frame(), /codex session → codex-warmupx/);
    assert.equal(loadConfig().providers.codex?.tmuxSession, 'codex-warmupx');

    // Still on the tmux row: edit again, then abandon with escape.
    await ui.press(ENTER);
    await ui.press('z');
    await ui.press(ESC);
    assert.doesNotMatch(ui.frame(), /Renaming session/);
    assert.equal(loadConfig().providers.codex?.tmuxSession, 'codex-warmupx');

    // An emptied buffer never commits.
    await ui.press(ENTER);
    for (let i = 0; i < 'codex-warmupx'.length; i++) await ui.press(BACKSPACE);
    await ui.press(ENTER);
    assert.equal(loadConfig().providers.codex?.tmuxSession, 'codex-warmupx');
  } finally {
    ui.instance.unmount();
  }
});

test('enter edits the binary path and re-detects it on commit', async () => {
  const stub = path.join(SANDBOX, 'stub-codex-2');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  writeEnv([...CODEX_ONLY, 'WARMUP_CODEX_BIN=/x']);
  const ui = harness();
  try {
    await ui.press('2');
    await ui.press(ENTER); // into the cursor agent's settings (Model row)
    await ui.press(DOWN); // the binary row
    await ui.press(ENTER);
    assert.match(ui.frame(), /Editing binary path/);
    await ui.press(BACKSPACE);
    await ui.press(BACKSPACE); // clear '/x'
    for (const ch of stub) await ui.press(ch);
    await ui.press(ENTER);
    // The confirmation tildifies the saved path; the config keeps it absolute.
    assert.match(ui.frame(), /codex binary → ~\/stub-codex-2/);
    assert.equal(loadConfig().providers.codex?.binary, stub);
  } finally {
    ui.instance.unmount();
  }
});

test('the hour grid moves its cursor and toggles hours in and out', async () => {
  writeEnv([
    'WARMUP_MODE=fixed',
    'WARMUP_SCHEDULER=cron',
    'WARMUP_PROVIDERS=claude',
    'WARMUP_SELECTED_PROVIDER=claude',
    'WARMUP_CLAUDE_ENABLED=true',
    'WARMUP_CLAUDE_SCHEDULE=8,13,18',
  ]);
  const ui = harness();
  try {
    await ui.press('3');
    await ui.press(DOWN);
    await ui.press(DOWN); // mode → scheduler → hours
    await ui.press(RIGHT);
    assert.match(ui.frame(), /Cursor 09:00/);
    await ui.press(' ');
    assert.match(ui.frame(), /09:00 added/);
    assert.deepEqual(loadConfig().providers.claude?.schedule, [8, 9, 13, 18]);
    await ui.press(' ');
    assert.match(ui.frame(), /09:00 removed/);
    assert.deepEqual(loadConfig().providers.claude?.schedule, [8, 13, 18]);
    // Walk the cursor back to midnight, toggle it in, then wrap off the edge to 23.
    for (let i = 0; i < 9; i++) await ui.press(LEFT);
    assert.match(ui.frame(), /Cursor 00:00/);
    await ui.press(' ');
    assert.match(ui.frame(), /00:00 added/);
    await ui.press(LEFT);
    assert.match(ui.frame(), /Cursor 23:00/);
  } finally {
    ui.instance.unmount();
  }
});

test('s applies the scheduler and t removes it, inside the sandbox only', async () => {
  writeEnv([
    'WARMUP_MODE=fixed',
    'WARMUP_SCHEDULER=cron',
    'WARMUP_PROVIDERS=claude',
    'WARMUP_SELECTED_PROVIDER=claude',
    'WARMUP_CLAUDE_ENABLED=true',
    'WARMUP_CLAUDE_SCHEDULE=8,13,18',
  ]);
  const ui = harness();
  try {
    assert.equal(fs.readFileSync(process.env.FAKE_CRONTAB!, 'utf8'), '');
    await ui.press('s');
    assert.match(ui.frame(), /Saved & applied \(cron\)/);
    assert.match(fs.readFileSync(process.env.FAKE_CRONTAB!, 'utf8'), /# >>> claude-warmup >>>/);

    await ui.press('t');
    assert.match(ui.frame(), /Stopped — schedulers removed/);
    assert.ok(
      !fs.readFileSync(process.env.FAKE_CRONTAB!, 'utf8').includes('claude-warmup >>>'),
      'stop strips the block again',
    );
    assert.ok(process.env.FAKE_CRONTAB!.startsWith(SANDBOX), 'writes stay in the sandbox');
  } finally {
    ui.instance.unmount();
  }
});
