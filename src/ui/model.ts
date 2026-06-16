// Pure layout data for the accessible Ink TUI: the focusable rows, their human
// labels, and the per-row key hint shown while a row is focused. No React, no JSX —
// the controller hook and the section components both read from here.
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

// The movement keys never change; each row appends its own action keys via Row.hint.
// Spelling the keys out per row (instead of one static legend) is the accessibility
// win: the user is always told exactly what the focused control responds to.
export const MOVE_HINT = '↑/↓ move';

// The kind of interaction a focusable row supports.
export type RowType = 'choice' | 'text' | 'schedule' | 'action';

export interface Row {
  key: string;
  type: RowType;
  label: string;
  hint: string; // contextual keys, shown in the status bar while this row is focused
  accel?: string; // single-key accelerator; underlined in its label (action rows only)
}

// Rows are mode-dependent: smart mode exposes its tunables as editable rows; fixed
// mode shows the togglable hour grid instead. Array order = focus order (top→bottom).
export const buildRows = (mode: Mode): Row[] => [
  { key: 'mode', type: 'choice', label: 'Mode', hint: '←/→ switch smart / fixed' },
  { key: 'scheduler', type: 'choice', label: 'Scheduler', hint: '←/→ switch scheduler' },
  { key: 'model', type: 'choice', label: 'Model', hint: '←/→ cycle model' },
  { key: 'tmux', type: 'text', label: 'tmux session', hint: 'enter to rename the session' },
  ...(mode === 'smart'
    ? [
        {
          key: 'workStart',
          type: 'choice' as const,
          label: 'Work start',
          hint: '←/→ adjust start hour',
        },
        { key: 'workEnd', type: 'choice' as const, label: 'Work end', hint: '←/→ adjust end hour' },
        { key: 'tick', type: 'choice' as const, label: 'Tick', hint: '←/→ change probe cadence' },
        {
          key: 'weeklyStop',
          type: 'choice' as const,
          label: 'Weekly stop',
          hint: '←/→ adjust weekly cutoff',
        },
      ]
    : [
        {
          key: 'schedule',
          type: 'schedule' as const,
          label: 'Hours',
          hint: '←/→ move cursor · space toggles the hour',
        },
      ]),
  {
    key: 'save',
    type: 'action',
    label: 'Save & apply',
    accel: 's',
    hint: 'enter or s to save & apply the config',
  },
  {
    key: 'run',
    type: 'action',
    label: 'Run warmup now',
    accel: 'r',
    hint: 'enter or r to run a warmup now',
  },
  {
    key: 'stop',
    type: 'action',
    label: 'Stop (remove schedulers)',
    accel: 't',
    hint: 'enter or t to remove all schedulers',
  },
  {
    key: 'logs',
    type: 'action',
    label: 'View logs',
    accel: 'l',
    hint: 'enter or l to view the logs',
  },
  { key: 'quit', type: 'action', label: 'Quit', accel: 'q', hint: 'enter or q to quit' },
];

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
  { keys: '↑/↓', label: 'Move between rows' },
  { keys: '←/→', label: 'Change the focused setting' },
  { keys: 'space', label: 'Toggle an hour (fixed mode)' },
  { keys: 'enter', label: 'Activate row / rename session' },
  { keys: 's', label: 'Save & apply' },
  { keys: 'r', label: 'Run warmup now' },
  { keys: 't', label: 'Stop (remove schedulers)' },
  { keys: 'l', label: 'View logs' },
  { keys: 'm', label: 'Toggle smart / fixed mode' },
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
