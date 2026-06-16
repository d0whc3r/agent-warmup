// The TUI controller: owns all state, the keyboard handlers and useInput, and hands
// the components a flat, read-only view-model. Keeping the logic here lets every
// component stay a pure function of its props.
//
// Multi-provider: the controller tracks the SELECTED provider id (persisted in
// the config). Settings + usage always bind to that provider; pressing 'p'
// cycles to the next enabled provider so the user can flip between them
// without leaving the TUI.
//
// Keys: ↑/↓ move between rows · ←/→ change the focused setting · space toggles an
// hour on the schedule grid · enter triggers an action / edits the tmux name ·
// p cycles providers · q quits. Every value change emits a confirmation message,
// so there is always feedback -- which also gives screen-reader users an audible
// result for each keystroke.
import { useState } from 'react';
import { useApp, useInput, useStdout } from 'ink';
import { loadConfig, saveConfig, getView, MODELS, SCHEDULERS, TICK_CHOICES } from '../config.js';
import { getStatus } from '../status.js';
import { formatUsage } from '../providers/claude.js';
import { pad2 } from '../format.js';
import * as schedule from '../schedule.js';
import { buildRows, hoursPerRow, MAX_WIDTH, MOVE_HINT, WIDE_AT, WIDE_MAX } from './model.js';
import type { Config, SmartConfig, Status, UiAction } from '../types.js';

// Cycle through a readonly choice list by a direction (-1/+1), wrapping at both ends.
const cycle = <T>(arr: readonly T[], cur: T, dir: number): T =>
  arr[(arr.indexOf(cur) + dir + arr.length) % arr.length]!;

export function useWarmupUi({
  onAction,
  initialConfig,
  initialStatus,
}: {
  onAction?: (a: UiAction) => void;
  initialConfig?: import('../types.js').MultiConfig;
  initialStatus?: Status;
} = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [multi, setMulti] = useState<import('../types.js').MultiConfig>(
    () => initialConfig ?? loadConfig(),
  );
  const [view, setView] = useState<Config>(() => getView(multi));
  const [status, setStatus] = useState<Status>(() => initialStatus ?? getStatus());
  const [idx, setIdx] = useState(0);
  const [hourCursor, setHourCursor] = useState(view.schedule[0] ?? 8);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  // columns can be 0 (TTY size not yet reported when the bin is spawned) -- `|| 80`
  // treats that like a missing size. Wide terminals get a two-column layout (capped
  // at WIDE_MAX); everything else is a single column clamped to MAX_WIDTH, which on a
  // narrow terminal is just the terminal width.
  const cols = stdout?.columns || 80;
  const wide = cols >= WIDE_AT;
  const width = Math.min(cols, wide ? WIDE_MAX : MAX_WIDTH);
  const gridCols = hoursPerRow((wide ? Math.floor(width / 2) : width) - 8);
  const ROWS = buildRows(view.mode);
  const refresh = () => {
    const m = loadConfig();
    setMulti(m);
    setView(getView(m));
    setStatus(getStatus());
  };

  const toggleHour = (h: number) => {
    const removing = view.schedule.includes(h);
    const next = view.schedule.includes(h)
      ? view.schedule.filter((x) => x !== h)
      : [...view.schedule, h].sort((a, b) => a - b);
    const nextMulti = patchProvider(multi, multi.shared.selectedProvider, { schedule: next });
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`${pad2(h)}:00 ${removing ? 'removed' : 'added'}`);
    setDirty(true);
  };

  const cycleModel = (dir: number) => {
    const cur = String(view.model);
    const next = cycle(MODELS as readonly string[], cur, dir);
    const nextMulti = patchProvider(multi, multi.shared.selectedProvider, { model: next });
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`Model → ${next}`);
    setDirty(true);
  };

  const toggleScheduler = () => {
    const next: import('../types.js').Scheduler = cycle(SCHEDULERS, view.scheduler, 1);
    const nextMulti: import('../types.js').MultiConfig = {
      ...multi,
      shared: { ...multi.shared, scheduler: next },
    };
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`Scheduler → ${next}`);
    setDirty(true);
  };

  const toggleMode = () => {
    const next: import('../types.js').Mode = view.mode === 'smart' ? 'fixed' : 'smart';
    const nextMulti: import('../types.js').MultiConfig = {
      ...multi,
      shared: { ...multi.shared, mode: next },
    };
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`Mode → ${next}`);
    setDirty(true);
  };

  const cycleProvider = () => {
    const ids = multi.shared.providers;
    if (ids.length < 2) {
      setMessage('Only one provider enabled');
      return;
    }
    const i = ids.indexOf(multi.shared.selectedProvider);
    const next: import('../types.js').ProviderId = ids[(i + 1 + ids.length) % ids.length]!;
    const nextMulti: import('../types.js').MultiConfig = {
      ...multi,
      shared: { ...multi.shared, selectedProvider: next },
    };
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`Provider → ${next}`);
    setDirty(true);
  };

  const editSmart = (fn: (s: SmartConfig) => SmartConfig) => {
    const next = fn(view.smart);
    const nextMulti = patchProvider(multi, multi.shared.selectedProvider, {
      workStart: next.workStart,
      workEnd: next.workEnd,
      weeklyStopPercent: next.weeklyStopPercent,
    });
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setDirty(true);
  };
  const adjustWorkStart = (d: number) => {
    const v = Math.max(0, Math.min(view.smart.workEnd - 1, view.smart.workStart + d));
    editSmart((s) => ({ ...s, workStart: Math.max(0, Math.min(s.workEnd - 1, s.workStart + d)) }));
    setMessage(`Work start → ${pad2(v)}:00`);
  };
  const adjustWorkEnd = (d: number) => {
    const v = Math.max(view.smart.workStart + 1, Math.min(23, view.smart.workEnd + d));
    editSmart((s) => ({ ...s, workEnd: Math.max(s.workStart + 1, Math.min(23, s.workEnd + d)) }));
    setMessage(`Work end → ${pad2(v)}:00`);
  };
  const cycleTick = (d: number) => {
    const v = cycle(TICK_CHOICES, view.smart.tickMinutes, d);
    const nextMulti: import('../types.js').MultiConfig = {
      ...multi,
      shared: { ...multi.shared, tickMinutes: v },
    };
    const saved = saveConfig(nextMulti);
    setMulti(saved);
    setView(getView(saved));
    setMessage(`Tick → ${v}m`);
    setDirty(true);
  };
  const adjustWeekly = (d: number) => {
    const v = Math.max(5, Math.min(100, view.smart.weeklyStopPercent + d * 5));
    editSmart((s) => ({
      ...s,
      weeklyStopPercent: Math.max(5, Math.min(100, s.weeklyStopPercent + d * 5)),
    }));
    setMessage(`Weekly stop → ${v}%`);
  };

  const startEditTmux = () => {
    setEditBuffer(view.tmuxSession);
    setEditing(true);
  };
  const commitTmux = () => {
    const name = editBuffer.trim();
    if (name) {
      const nextMulti = patchProvider(multi, multi.shared.selectedProvider, { tmuxSession: name });
      const saved = saveConfig(nextMulti);
      setMulti(saved);
      setView(getView(saved));
      setMessage(`Session → ${name}`);
      setDirty(true);
    }
    setEditing(false);
  };

  const doAction = (key: string) => {
    if (key === 'save') {
      schedule.applySchedule(multi);
      setDirty(false);
      setMessage(`Saved & applied (${multi.shared.scheduler})`);
      refresh();
    } else if (key === 'stop') {
      schedule.stopSchedule();
      setMessage('Stopped — schedulers removed');
      refresh();
    } else if (key === 'run') {
      onAction?.('run');
      exit();
    } else if (key === 'logs') {
      onAction?.('logs');
      exit();
    } else if (key === 'quit') {
      exit();
    }
  };

  const stepRows: Record<string, (dir: number) => void> = {
    model: cycleModel,
    workStart: adjustWorkStart,
    workEnd: adjustWorkEnd,
    tick: cycleTick,
    weeklyStop: adjustWeekly,
  };

  useInput((input, key) => {
    if (editing) {
      if (key.return) return commitTmux();
      if (key.escape) return setEditing(false);
      if (key.backspace || key.delete) return setEditBuffer((b) => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setEditBuffer((b) => b + input);
      return;
    }

    if (showHelp) {
      if (key.escape || input === '?') setShowHelp(false);
      return;
    }
    if (input === '?') return setShowHelp(true);

    if (input === 'q') return doAction('quit');
    if (input === 's') return doAction('save');
    if (input === 'r') return doAction('run');
    if (input === 't') return doAction('stop');
    if (input === 'l') return doAction('logs');
    if (input === 'm') return toggleMode();
    if (input === 'p') return cycleProvider();

    if (key.upArrow) return setIdx((i) => (i - 1 + ROWS.length) % ROWS.length);
    if (key.downArrow) return setIdx((i) => (i + 1) % ROWS.length);

    const row = ROWS[idx]!;
    const step = stepRows[row.key];
    if (step) {
      if (key.leftArrow) step(-1);
      else if (key.rightArrow) step(1);
      return;
    }
    if (row.key === 'mode' && (key.leftArrow || key.rightArrow)) toggleMode();
    else if (row.key === 'scheduler' && (key.leftArrow || key.rightArrow)) toggleScheduler();
    else if (row.key === 'tmux' && key.return) startEditTmux();
    else if (row.key === 'schedule') {
      if (key.leftArrow) {
        const n = (hourCursor - 1 + 24) % 24;
        setHourCursor(n);
        setMessage(`Cursor ${pad2(n)}:00`);
      } else if (key.rightArrow) {
        const n = (hourCursor + 1) % 24;
        setHourCursor(n);
        setMessage(`Cursor ${pad2(n)}:00`);
      } else if (input === ' ') {
        toggleHour(hourCursor);
      }
    } else if (row.type === 'action' && key.return) doAction(row.key);
  });

  // Usage is read from the selected provider's cache.
  const selectedCache = status.usage?.providers?.[multi.shared.selectedProvider] ?? null;

  return {
    multi,
    config: view,
    status,
    usage: formatUsage(selectedCache),
    focusedKey: ROWS[idx]!.key,
    actions: ROWS.filter((r) => r.type === 'action'),
    hourCursor,
    editing,
    editBuffer,
    showHelp,
    message,
    dirty,
    width,
    wide,
    gridCols,
    hint: `${MOVE_HINT}  ·  ${ROWS[idx]!.hint}  ·  ? help`,
  };
}

// Apply a partial patch to a specific provider's config in a MultiConfig.
function patchProvider(
  multi: import('../types.js').MultiConfig,
  id: import('../types.js').ProviderId,
  patch: import('../types.js').ProviderInput,
): import('../types.js').MultiConfig {
  const p = multi.providers[id];
  if (!p) return multi;
  return {
    ...multi,
    providers: {
      ...multi.providers,
      [id]: {
        ...p,
        ...(patch.model != null ? { model: patch.model } : {}),
        ...(patch.tmuxSession != null ? { tmuxSession: patch.tmuxSession } : {}),
        ...(patch.workStart != null ? { workStart: patch.workStart } : {}),
        ...(patch.workEnd != null ? { workEnd: patch.workEnd } : {}),
        ...(patch.weeklyStopPercent != null ? { weeklyStopPercent: patch.weeklyStopPercent } : {}),
        ...(patch.schedule ? { schedule: patch.schedule } : {}),
      },
    },
  };
}
