// Pure layout data for the accessible Ink TUI: the tabs, the focusable rows of each
// tab, their human labels, and the per-row key hint shown while a row is focused.
// No React, no JSX — the controller hook and the section components both read here.
import type { Mode } from '../types.js';

export const HOURS = Array.from({ length: 24 }, (_, i) => i);

// The panel clamps to the terminal but never grows past this. Wide enough for the
// 12-per-row hour grid (12 × 4 = 48 cols + indent), narrow enough to stay readable.
export const MAX_WIDTH = 60;

// At or above this terminal width we split into two side-by-side columns; below it
// we stay a single clamped column (which itself shrinks to the terminal on narrow
// screens). The cap keeps the two-column layout from stretching to unreadable widths.
export const WIDE_AT = 92;
export const WIDE_MAX = 104;

// Label column width, so every "Label   value" pair aligns its value into one column.
export const LABEL_W = 13;

// The global action keys, pinned to the last status-bar line on every tab so the panel
// is never more than one keystroke away from saving. The controller handles them
// before navigation; the "?" overlay spells each one out in full.
export const LEGEND = 's save · r run · t stop · l logs · ? help · q quit';

// The panel is split into tabs so each concern gets its own screen instead of a
// column of loose cards: what is going on (overview), which agent to warm and how
// to reach it (agents), and when to warm it (schedule).
export type TabKey = 'overview' | 'agents' | 'schedule';

export interface TabDef {
  key: TabKey;
  label: string;
  accel: string; // digit that jumps straight to the tab
}

export const TABS: readonly TabDef[] = [
  { key: 'overview', label: 'Overview', accel: '1' },
  { key: 'agents', label: 'Agents', accel: '2' },
  { key: 'schedule', label: 'Schedule', accel: '3' },
];

// The kind of interaction a focusable row supports.
type RowType = 'choice' | 'text' | 'schedule' | 'agents';

export interface Row {
  key: string;
  type: RowType;
  label: string;
  hint: string; // contextual keys, shown in the status bar while this row is focused
}

// The agents tab: pick the agent, then edit what the warmup needs to reach it.
const AGENT_ROWS: Row[] = [
  {
    key: 'agents',
    type: 'agents',
    label: 'Agent',
    hint: '↑↓ pick · space on/off · enter edit · d detect',
  },
  { key: 'model', type: 'choice', label: 'Model', hint: '←→ cycle model' },
  { key: 'binary', type: 'text', label: 'Binary', hint: 'enter edit path · d autodetect' },
  { key: 'tmux', type: 'text', label: 'tmux session', hint: 'enter rename' },
];

// The schedule tab is mode-dependent: smart mode exposes its tunables as editable
// rows; fixed mode shows the togglable hour grid instead. Mode, scheduler and tick
// are shared by every agent; the hours belong to the default agent (p switches it).
const scheduleRows = (mode: Mode): Row[] => [
  { key: 'mode', type: 'choice', label: 'Mode', hint: '←→ smart / fixed' },
  { key: 'scheduler', type: 'choice', label: 'Scheduler', hint: '←→ switch scheduler' },
  ...(mode === 'smart'
    ? [
        { key: 'tick', type: 'choice' as const, label: 'Tick', hint: '←→ probe cadence' },
        {
          key: 'workStart',
          type: 'choice' as const,
          label: 'Work start',
          hint: '←→ adjust · p switch agent',
        },
        {
          key: 'workEnd',
          type: 'choice' as const,
          label: 'Work end',
          hint: '←→ adjust · p switch agent',
        },
        {
          key: 'weeklyStop',
          type: 'choice' as const,
          label: 'Weekly stop',
          hint: '←→ adjust · p switch agent',
        },
      ]
    : [
        {
          key: 'schedule',
          type: 'schedule' as const,
          label: 'Hours',
          hint: '←→ hour · space toggle · p switch agent',
        },
      ]),
];

// Array order = focus order (top→bottom) within the active tab. The overview is
// read-only, so it has no rows: its actions are the global keys in the legend.
export const buildRows = (mode: Mode, tab: TabKey = 'overview'): Row[] => {
  if (tab === 'agents') return [...AGENT_ROWS];
  if (tab === 'schedule') return scheduleRows(mode);
  return [];
};

// How many hour cells fit per row for a given usable content width. Each cell is 4
// columns ("[08]" or " 08 "). Clamped to [4,12] so the grid never gets unreadably
// dense, and never wider than the 12-per-row default it used to be hardcoded at.
export const hoursPerRow = (contentWidth: number): number =>
  Math.max(4, Math.min(12, Math.floor(contentWidth / 4)));

// Split an array into fixed-size chunks (the hour grid's reflowing rows).
export const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export interface Shortcut {
  keys: string;
  label: string;
}

// The global key map, shown verbatim in the "?" help overlay. The single-letter
// accelerators fire from any row (the controller handles them before navigation);
// the arrow/space/enter entries document the per-row navigation keys.
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'tab', label: 'Next tab (shift+tab back)' },
  { keys: '1-3', label: 'Jump to a tab' },
  { keys: '↑/↓', label: 'Move between rows (or agents)' },
  { keys: '←/→', label: 'Change the focused setting' },
  { keys: 'space', label: 'Toggle an hour / enable an agent' },
  { keys: 'enter', label: 'Open the agent under the cursor / edit text' },
  { keys: 's', label: 'Save & apply' },
  { keys: 'r', label: 'Warm every enabled agent now' },
  { keys: 't', label: 'Stop (remove schedulers)' },
  { keys: 'l', label: 'View logs' },
  { keys: 'm', label: 'Toggle smart / fixed mode' },
  { keys: 'p', label: 'Cycle the default agent (CLI runs, schedule hours)' },
  { keys: 'd', label: 'Detect the agent binary path' },
  { keys: '?', label: 'Toggle this help' },
  { keys: 'q', label: 'Quit' },
];

// Axis labels under the smart-mode band bar: "0     6     12    18  23", each number
// sitting above its hour column (the last is right-aligned into column 23).
export const AXIS = (() => {
  const cells: string[] = Array(24).fill(' ');
  for (const m of [0, 6, 12, 18, 23]) {
    const s = String(m);
    const start = Math.min(m, 24 - s.length);
    for (let i = 0; i < s.length; i++) cells[start + i] = s[i]!;
  }
  return cells.join('');
})();
