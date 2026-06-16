// Throwaway preview harness: render the TUI to stdout at a given width so we can see
// the actual frame. Usage: node --import tsx scripts/preview-tui.tsx [cols] [mode] [sr]
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import App from '../src/ui/App.jsx';
import type { Config, Status, UsageCache } from '../src/types.js';

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

const cols = Number(process.argv[2] ?? 64);
const mode = (process.argv[3] ?? 'fixed') as Config['mode'];
const sr = process.argv[4] === 'sr';

const usage: UsageCache = {
  session: { pct: 30, active: true, resetsAt: new Date(2026, 5, 13, 15, 30) },
  week: { pct: 42, resetsAt: new Date(2026, 5, 14, 11, 0) },
  capturedAt: Date.now() - 90 * 60 * 1000,
};
const config: Config = {
  mode,
  schedule: [8, 13, 18],
  smart: { workStart: 9, workEnd: 18, tickMinutes: 30, weeklyStopPercent: 80 },
  model: 'sonnet',
  scheduler: 'cron',
  tmuxSession: 'claude-warmup',
};
const status: Status = {
  config,
  launchd: { installed: false, loaded: false, running: false, enabled: false },
  cron: { installed: true },
  active: true,
  nextRun: '13:00',
  lastRun: null,
  usage,
};

const { frames, stdout, stdin } = fakeStreams(cols);
const inst = render(React.createElement(App, { initialConfig: config, initialStatus: status }), {
  stdout,
  stdin,
  isScreenReaderEnabled: sr,
  patchConsole: false,
} as never);
inst.unmount();
const frame = [...frames].sort((a, b) => b.length - a.length)[0] ?? '';
process.stdout.write((sr ? frame : stripAnsi(frame)) + '\n');
