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

import type { Detection } from '../src/detect.js';
import type { Config, MultiConfig, Status, UsageCache } from '../src/types.js';
import App from '../src/ui/App.jsx';
import { HelpOverlay } from '../src/ui/components/HelpOverlay.jsx';
import { StatusBar } from '../src/ui/components/StatusBar.jsx';
import { buildRows, LEGEND, SHORTCUTS, TABS, type TabKey } from '../src/ui/model.js';

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
      binary: '/opt/agents/claude',
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
// Detection is a filesystem scan, so the TUI takes it as an injected prop and the
// tests pin it: claude installed at its configured path, opencode installed
// somewhere else, so both markers ("configured path works" vs "agent exists") get
// exercised.
const baseDetections: Detection[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    binary: 'claude',
    path: '/opt/agents/claude',
    configured: '/opt/agents/claude',
    configuredOk: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode Go',
    binary: 'opencode',
    path: null,
    configured: '',
    configuredOk: false,
  },
];

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

function frameOf(
  config: MultiConfig,
  status: Status,
  screenReader: boolean,
  columns = 64,
  tab: TabKey = 'overview',
): string {
  return renderFrame(
    React.createElement(App, {
      initialConfig: config,
      initialStatus: status,
      initialDetections: baseDetections,
      initialTab: tab,
    }),
    screenReader,
    columns,
  );
}

const smartConfig: MultiConfig = { ...baseConfig, shared: { ...baseConfig.shared, mode: 'smart' } };
const smartStatus: Status = {
  ...baseStatus,
  config: smartConfig,
  view: { ...baseView, mode: 'smart' },
};

test('the tab bar marks the open tab without relying on colour', () => {
  const overview = frameOf(baseConfig, baseStatus, false);
  assert.match(overview, /\[1 Overview\]/);
  assert.match(overview, / 2 Agents /);
  assert.match(overview, / 3 Schedule/);

  const agents = frameOf(baseConfig, baseStatus, false, 64, 'agents');
  assert.match(agents, /\[2 Agents\]/);
  assert.ok(!agents.includes('[1 Overview]'), 'only the open tab wears brackets');

  const sr = frameOf(baseConfig, baseStatus, true);
  assert.match(sr, /tablist:/);
  assert.match(sr, /tab: \(selected\) Overview/);
  assert.match(sr, /tab: Schedule/);
});

test('the overview tab summarises the scheduler and every agent', () => {
  const f = frameOf(baseConfig, baseStatus, false);
  assert.match(f, /agent-warmup/);
  assert.match(f, /● ACTIVE · next 13:00/, 'the header badge carries the next run');
  assert.match(f, /STATUS/);
  assert.match(f, /Scheduler\s+cron · active/);
  assert.match(f, /Next run\s+13:00/);
  assert.match(f, /Window\s+fixed · 08:00 13:00 18:00/);
  assert.match(f, /● claude\*\s+haiku/);
  assert.match(f, /○ opencode\s+disabled/, 'disabled agents collapse to one line');
  assert.ok(f.includes(LEGEND), 'the action legend is pinned to the status bar');
  assert.match(f, /[╭╮╰╯]/);
  assert.ok(f.split('\n').length <= 24, 'the overview fits an 80×24 terminal');
});

test('screen-reader mode emits clean linear text and hides glyph art', () => {
  const f = frameOf(baseConfig, baseStatus, true);
  assert.match(f, /status: active, next run 13:00/);
  assert.match(f, /Scheduler: cron · active/);
  assert.match(f, /claude: enabled, selected, model haiku/);
  assert.match(f, /opencode: disabled/);
  assert.ok(!f.includes('▶'), 'pointer glyph should be hidden from screen readers');
  assert.ok(!f.includes('●'), 'status dots should be hidden from screen readers');
  assert.ok(!/[╭╮╰╯│─]/.test(f), 'card borders must not reach screen readers');
});

test('the agents tab pairs the picker with the selected agent settings', () => {
  const f = frameOf(baseConfig, baseStatus, false, 64, 'agents');
  assert.match(f, /AGENTS/);
  assert.match(f, /▶ \[x\] claude\*\s+✓ found/);
  assert.match(f, /\[ \] opencode\s+✗ missing/);
  assert.match(f, /SETTINGS · claude/, 'the settings card names the agent it edits');
  // The settings marker answers a different question: does the configured path work?
  assert.match(f, /Binary\s+✓ \/opt\/agents\/claude/);

  const sr = frameOf(baseConfig, baseStatus, true, 64, 'agents');
  assert.match(sr, /\(selected\) claude: enabled, selected, installed/);
  assert.match(sr, /opencode: disabled, not installed/);
  assert.match(sr, /Binary: \/opt\/agents\/claude \(found\)/);
  assert.ok(!sr.includes('[x]'), 'checkbox art should be hidden from screen readers');
});

test('the schedule tab shows the mode rows and the fixed-mode hour grid', () => {
  const f = frameOf(baseConfig, baseStatus, false, 64, 'schedule');
  assert.match(f, /SCHEDULE/);
  assert.match(f, /▶ Mode/);
  assert.match(f, /Scheduler\s+cron/);
  assert.match(f, /HOURS · claude/, 'the hours card names the agent it edits');
  assert.match(f, /\[08\]/);
  assert.match(f, /Selected: 08:00, 13:00, 18:00/);
  assert.match(f, /←→ smart \/ fixed/, 'the focused row hint is short enough not to wrap');

  const sr = frameOf(baseConfig, baseStatus, true, 64, 'schedule');
  assert.match(sr, /\(selected\) Mode: fixed/);
  assert.match(sr, /Hours\. Selected: 08:00, 13:00, 18:00\. Cursor at 08:00\./);
  assert.ok(!sr.includes('[08]'), 'hour grid art should be hidden from screen readers');
});

test('smart mode shows the band bar visually and the band hours to screen readers', () => {
  const visual = frameOf(smartConfig, smartStatus, false, 64, 'schedule');
  assert.match(visual, /█/);
  assert.match(visual, /Tick\s+30m/, 'the shared tick sits with mode and scheduler');
  assert.match(visual, /Work start/);

  const sr = frameOf(smartConfig, smartStatus, true, 64, 'schedule');
  assert.match(sr, /Work start: 09:00/);
  assert.match(sr, /Weekly stop: 80 percent/);
  assert.ok(!sr.includes('█'), 'band bar art should be hidden from screen readers');
});

test('narrow terminal reflows without overflowing its width', () => {
  const cols = 36;
  for (const tab of ['overview', 'agents', 'schedule'] as const) {
    const f = frameOf(baseConfig, baseStatus, false, cols, tab);
    assert.ok(maxLineLen(f) <= cols, `${tab}: no line should exceed ${cols} cols`);
  }
  const schedule = frameOf(baseConfig, baseStatus, false, cols, 'schedule');
  assert.match(schedule, /\[08\]/);
  assert.match(schedule, /Selected: 08:00, 13:00, 18:00/);
});

test('wide terminal spreads into a two-column layout', () => {
  const f = frameOf(baseConfig, baseStatus, false, 120);
  assert.match(f, /STATUS.*AGENTS/, 'status and agents sit side by side');
  assert.ok(maxLineLen(f) > 60, 'wide layout should be wider than the single-column cap');
});

test('help overlay lists shortcuts and reads linearly to screen readers', () => {
  const el = React.createElement(HelpOverlay, { shortcuts: SHORTCUTS });
  const visual = renderFrame(el, false, 64);
  assert.match(visual, /KEYBOARD SHORTCUTS/);
  assert.match(visual, /tab\s+Next tab/);
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
  const agents = frameOf(baseConfig, { ...baseStatus, usage }, false, 64, 'agents');
  assert.match(agents, /USAGE/);
  assert.match(agents, /Session/);
  assert.match(agents, /30%/);
  assert.match(agents, /Weekly/);
  assert.match(agents, /4%/);
  assert.match(agents, /ago/);

  // The overview compresses the same cache into one line per agent.
  const overview = frameOf(baseConfig, { ...baseStatus, usage }, false);
  assert.match(overview, /session 30% · week 4% · 2h ago/);
});

test('the status bar reflects editing, unsaved and confirmation states', () => {
  const bar = (props: Parameters<typeof StatusBar>[0]) =>
    renderFrame(React.createElement(StatusBar, props), false, 64);

  assert.match(bar({ editing: true, dirty: false, message: '', hint: 'h' }), /Renaming session/);
  assert.match(
    bar({ editing: true, editLabel: 'Editing binary path', dirty: false, message: '', hint: 'h' }),
    /Editing binary path/,
  );
  assert.match(
    bar({ editing: false, dirty: true, message: 'Model → opus', hint: 'h' }),
    /● Model → opus · s to apply/,
  );
  assert.match(
    bar({ editing: false, dirty: true, message: '', hint: 'h' }),
    /● changes not applied · s to apply/,
  );
  assert.match(bar({ editing: false, dirty: false, message: 'Saved', hint: 'h' }), /✓ Saved/);
  const clean = bar({ editing: false, dirty: false, message: '', hint: 'move keys' });
  assert.match(clean, /up to date/);
  assert.match(clean, /move keys/);
  assert.ok(clean.includes(LEGEND), 'the legend is always the last line');
  const noHint = bar({ editing: false, dirty: false, message: '', hint: '' });
  assert.equal(noHint.trim().split('\n').length, 2, 'an empty hint drops its line');
});

test('every legend key is documented in the help overlay', () => {
  for (const key of ['s', 'r', 't', 'l', '?', 'q']) {
    assert.ok(
      SHORTCUTS.some((s) => s.keys === key),
      `legend key "${key}" should have a help entry`,
    );
  }
});

test('every tab has a unique jump digit; the editing tabs have focusable rows', () => {
  assert.deepEqual(
    TABS.map((t) => t.accel),
    ['1', '2', '3'],
  );
  assert.equal(buildRows('fixed', 'overview').length, 0, 'the overview is read-only');
  for (const tab of ['agents', 'schedule'] as const) {
    assert.ok(buildRows('smart', tab).length > 0, `${tab} should have rows`);
    assert.ok(buildRows('fixed', tab).length > 0, `${tab} should have rows in fixed mode`);
  }
});
