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
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

process.env.WARMUP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-ui-'));

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
const SHIFT_TAB = `${ESC}[Z`;
const RIGHT = `${ESC}[C`;
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
