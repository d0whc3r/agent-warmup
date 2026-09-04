import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// Headless render smoke test for the Ink TUI. Ink needs a TTY, so we render against
// fake stdout/stdin streams and assert on the laid-out frame. It guards two things:
// the UI renders without throwing (catches the JSX significant-whitespace crash that
// type-checking can't see), and the accessibility contract holds -- colour-independent
// markers in the visual frame, and clean linear text in screen-reader mode.
import { test } from 'node:test';

import { render } from 'ink';
import React from 'react';

import type { Config, MultiConfig, Status, UsageCache } from '../src/types.js';
import App from '../src/ui/App.jsx';
import { HelpOverlay } from '../src/ui/components/HelpOverlay.jsx';
import { StatusBar } from '../src/ui/components/StatusBar.jsx';
import { buildRows, SHORTCUTS } from '../src/ui/model.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

function fakeStreams(columns: number) {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows: 50,
    write: (chunk: string) => {
      frames.push(String(chunk));
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
    read: () => null,
  });
  return { frames, stdout, stdin };
}

function renderFrame(element: React.ReactElement, screenReader: boolean, columns: number): string {
  const { frames, stdout, stdin } = fakeStreams(columns);
  const inst = render(element, {
    stdout,
    stdin,
    isScreenReaderEnabled: screenReader,
    patchConsole: false,
  } as never);
  inst.unmount();
  return stripAnsi([...frames].sort((a, b) => b.length - a.length)[0] ?? '');
}

const maxLineLen = (frame: string): number => Math.max(...frame.split('\n').map((l) => l.length));

const baseConfig: MultiConfig = {
  shared: {
    mode: 'fixed',
    scheduler: 'cron',
    tickMinutes: 30,
    providers: ['claude'],
    selectedProvider: 'claude',
  },
  providers: {
    claude: {
      id: 'claude',
      enabled: true,
      binary: '',
      model: 'haiku',
      tmuxSession: 'claude-warmup',
      armScriptPath: '',
      workStart: 9,
      workEnd: 18,
      weeklyStopPercent: 80,
      schedule: [8, 13, 18],
      extra: {},
    },
    opencode: {
      id: 'opencode',
      enabled: false,
      binary: '',
      model: '',
      tmuxSession: '',
      armScriptPath: '',
      workStart: 7,
      workEnd: 22,
      weeklyStopPercent: 85,
      schedule: [],
      extra: {},
    },
  },
};
const baseView: Config = {
  mode: 'fixed',
  schedule: [8, 13, 18],
  smart: { workStart: 9, workEnd: 18, tickMinutes: 30, weeklyStopPercent: 80 },
  model: 'haiku',
  scheduler: 'cron',
  tmuxSession: 'claude-warmup',
};
const baseStatus: Status = {
  config: baseConfig,
  view: baseView,
  launchd: { installed: false, loaded: false, running: false, enabled: false },
  cron: { installed: true },
  active: true,
  nextRun: '13:00',
  lastRun: null,
  usage: null,
};

function frameOf(config: MultiConfig, status: Status, screenReader: boolean, columns = 64): string {
  return renderFrame(
    React.createElement(App, { initialConfig: config, initialStatus: status }),
    screenReader,
    columns,
  );
}

test('visual mode conveys state without relying on colour', () => {
  const f = frameOf(baseConfig, baseStatus, false);
  assert.match(f, /agent-warmup/);
  assert.match(f, /● ACTIVE/);
  assert.match(f, /▶ Mode/);
  assert.match(f, /\[08\]/);
  assert.match(f, /Selected: 08:00, 13:00, 18:00/);
  assert.match(f, /SETTINGS/);
  assert.match(f, /ACTIONS/);
  assert.match(f, /Save & apply/);
  assert.match(f, /↑\/↓ move/);
  assert.match(f, /[╭╮╰╯]/);
});

test('screen-reader mode emits clean linear text and hides glyph art', () => {
  const f = frameOf(baseConfig, baseStatus, true);
  assert.match(f, /status: active/);
  assert.match(f, /\(selected\) Mode: fixed/);
  assert.match(f, /Scheduler: cron/);
  assert.match(f, /Hours\. Selected: 08:00, 13:00, 18:00\. Cursor at 08:00\./);
  assert.match(f, /button: Save & apply/);
  assert.ok(!f.includes('▶'), 'pointer glyph should be hidden from screen readers');
  assert.ok(!f.includes('[08]'), 'hour grid art should be hidden from screen readers');
  assert.ok(!/[╭╮╰╯│─]/.test(f), 'card borders must not reach screen readers');
});

test('smart mode shows the band bar visually and the band hours to screen readers', () => {
  const smart: MultiConfig = { ...baseConfig, shared: { ...baseConfig.shared, mode: 'smart' } };
  const visual = frameOf(smart, { ...baseStatus, config: smart }, false);
  assert.match(visual, /█/);
  assert.match(visual, /Work start/);

  const sr = frameOf(smart, { ...baseStatus, config: smart }, true);
  assert.match(sr, /Work start: 09:00/);
  assert.match(sr, /Weekly stop: 80 percent/);
  assert.ok(!sr.includes('█'), 'band bar art should be hidden from screen readers');
});

test('narrow terminal reflows without overflowing its width', () => {
  const cols = 36;
  const f = frameOf(baseConfig, baseStatus, false, cols);
  assert.match(f, /\[08\]/);
  assert.match(f, /Selected: 08:00, 13:00, 18:00/);
  assert.ok(maxLineLen(f) <= cols, `no line should exceed ${cols} cols`);
});

test('wide terminal spreads into a two-column layout', () => {
  const f = frameOf(baseConfig, baseStatus, false, 120);
  assert.match(f, /SETTINGS/);
  assert.match(f, /ACTIONS/);
  assert.match(f, /Save & apply/);
  assert.ok(maxLineLen(f) > 60, 'wide layout should be wider than the single-column cap');
});

test('help overlay lists shortcuts and reads linearly to screen readers', () => {
  const el = React.createElement(HelpOverlay, { shortcuts: SHORTCUTS });
  const visual = renderFrame(el, false, 64);
  assert.match(visual, /KEYBOARD SHORTCUTS/);
  assert.match(visual, /s\s+Save & apply/);
  assert.match(visual, /\? or esc to close/);

  const sr = renderFrame(el, true, 64);
  assert.match(sr, /s: Save & apply/);
  assert.ok(!/[╭╮╰╯│─]/.test(sr), 'card border must not reach screen readers');
});

test('the usage card surfaces the cached session and weekly limits', () => {
  const usage: UsageCache = {
    providers: {
      claude: {
        session: { pct: 30, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) },
        week: { pct: 4, resetsAt: new Date(2026, 5, 14, 11, 0) },
        capturedAt: Date.now() - 90 * 60 * 1000,
      },
    },
  };
  const f = frameOf(baseConfig, { ...baseStatus, usage }, false);
  assert.match(f, /USAGE/);
  assert.match(f, /Session/);
  assert.match(f, /30%/);
  assert.match(f, /Weekly/);
  assert.match(f, /4%/);
  assert.match(f, /ago/);
});

test('the status bar reflects editing, unsaved and confirmation states', () => {
  const bar = (props: Parameters<typeof StatusBar>[0]) =>
    renderFrame(React.createElement(StatusBar, props), false, 64);

  assert.match(bar({ editing: true, dirty: false, message: '', hint: 'h' }), /Renaming session/);
  assert.match(
    bar({ editing: false, dirty: true, message: 'Model → opus', hint: 'h' }),
    /● unsaved · Model → opus/,
  );
  assert.match(bar({ editing: false, dirty: true, message: '', hint: 'h' }), /● unsaved — choose/);
  assert.match(bar({ editing: false, dirty: false, message: 'Saved', hint: 'h' }), /✓ Saved/);
  const clean = bar({ editing: false, dirty: false, message: '', hint: 'move keys' });
  assert.match(clean, /up to date/);
  assert.match(clean, /move keys/);
});

test('every action accelerator is a letter present in its label', () => {
  for (const row of buildRows('fixed').filter((r) => r.type === 'action')) {
    assert.ok(row.accel, `action "${row.key}" should have an accelerator`);
    assert.equal(row.accel!.length, 1, `accelerator for "${row.key}" should be one char`);
    assert.ok(
      row.label.toLowerCase().includes(row.accel!.toLowerCase()),
      `accelerator "${row.accel}" should appear in label "${row.label}"`,
    );
  }
});
