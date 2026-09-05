import { useApp, useInput, useStdout } from 'ink';
// The TUI controller: owns all state, the keyboard handlers and useInput, and hands
// the components a flat, read-only view-model. Keeping the logic here lets every
// component stay a pure function of its props.
//
// Multi-provider: the controller tracks the SELECTED provider id (persisted in
// the config). Settings + usage always bind to that provider; pressing 'p'
// cycles to the next enabled provider so the user can flip between them
// without leaving the TUI. The AGENTS row picks any agent (enter selects it,
// enabling it first if needed) and 'd' autodetects the focused agent's binary.
//
// The panel is tabbed (overview / agents / schedule); each tab owns its own row
// list, so focus never wanders across sections the user isn't looking at.
//
// Keys: tab / shift+tab (or 1-3) switch tabs · ↑/↓ move between rows · ←/→ change
// the focused setting · space toggles an hour on the schedule grid · enter triggers
// an action / edits a text field · p cycles providers · q quits. Every value change
// emits a confirmation message, so there is always feedback -- which also gives
// screen-reader users an audible result for each keystroke.
import { useState } from 'react';

import { loadConfig, saveConfig, getView, MODELS, SCHEDULERS, TICK_CHOICES } from '../config.js';
import { detectAll, detectProvider, type Detection } from '../detect.js';
import { pad2, tildify } from '../format.js';
import { formatUsage } from '../providers/claude.js';
import { ALL_PROVIDER_IDS, getProvider } from '../providers/index.js';
import * as schedule from '../schedule.js';
import { getStatus } from '../status.js';
import type { Config, MultiConfig, ProviderId, SmartConfig, Status, UiAction } from '../types.js';
import {
  ACTIONS,
  buildRows,
  hoursPerRow,
  MAX_WIDTH,
  MOVE_HINT,
  TABS,
  WIDE_AT,
  WIDE_MAX,
  type TabKey,
} from './model.js';

// Cycle through a readonly choice list by a direction (-1/+1), wrapping at both ends.
const cycle = <T>(arr: readonly T[], cur: T, dir: number): T =>
  arr[(arr.indexOf(cur) + dir + arr.length) % arr.length]!;

export function useWarmupUi({
  onAction,
  initialConfig,
  initialStatus,
  initialDetections,
  initialTab,
}: {
  onAction?: (a: UiAction, id?: ProviderId) => void;
  initialConfig?: MultiConfig;
  initialStatus?: Status;
  initialDetections?: readonly Detection[];
  initialTab?: TabKey;
} = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [multi, setMulti] = useState<import('../types.js').MultiConfig>(
    () => initialConfig ?? loadConfig(),
  );
  const [view, setView] = useState<Config>(() => getView(multi));
  const [status, setStatus] = useState<Status>(() => initialStatus ?? getStatus());
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'overview');
  const [idx, setIdx] = useState(0);
  const [hourCursor, setHourCursor] = useState(view.schedule[0] ?? 8);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  // Which text row is being edited inline (null = not editing).
  const [editKey, setEditKey] = useState<'tmux' | 'binary' | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  // Binary detection is a filesystem scan, so it is done once at mount and
  // refreshed only when the user presses 'd' or edits a path by hand.
  const [detections, setDetections] = useState<readonly Detection[]>(
    () => initialDetections ?? detectAll(multi),
  );
  const [agentCursor, setAgentCursor] = useState(() =>
    Math.max(0, knownAgents(multi).indexOf(multi.shared.selectedProvider)),
  );

  // columns can be 0 (TTY size not yet reported when the bin is spawned) -- `|| 80`
  // treats that like a missing size. Wide terminals get a two-column layout (capped
  // at WIDE_MAX); everything else is a single column clamped to MAX_WIDTH, which on a
  // narrow terminal is just the terminal width.
  const cols = stdout?.columns || 80;
  const wide = cols >= WIDE_AT;
  const width = Math.min(cols, wide ? WIDE_MAX : MAX_WIDTH);
  const gridCols = hoursPerRow((wide ? Math.floor(width / 2) : width) - 8);
  const ROWS = buildRows(view.mode, tab);
  // Toggling the mode shortens the schedule tab's row list, so the stored index can
  // outlive the row it pointed at; clamping keeps focus on the last row instead of
  // reading past the end.
  const rowIdx = Math.min(idx, ROWS.length - 1);
  const row = ROWS[rowIdx]!;
  const agentIds = knownAgents(multi);
  const selectedId = multi.shared.selectedProvider;
  // The agents tab edits whichever agent the AGENTS cursor is on, NOT the selected
  // one: model and binary are per-agent settings, so walking the list has to bring
  // its settings along or you would have to select (and enable) an agent just to
  // configure it. Elsewhere the selected agent is the subject, as before.
  const agentId = (tab === 'agents' ? agentIds[agentCursor] : undefined) ?? selectedId;
  const agentCfg = multi.providers[agentId];
  const agentBinary = agentCfg?.binary ?? '';
  // The AGENT marker answers "does the configured path work?" (which 'd' fixes);
  // the AGENTS list marker answers "is this agent installed at all?".
  const binaryOk = detections.find((d) => d.id === agentId)?.configuredOk === true;
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
    const cur = String(agentCfg?.model ?? view.model);
    const choices = getProvider(agentId).modelChoices;
    const available = choices.length ? choices : (MODELS as readonly string[]);
    const next = cycle(available.includes(cur) ? available : [cur, ...available], cur, dir);
    const saved = saveConfig(patchProvider(multi, agentId, { model: next }));
    setMulti(saved);
    setView(getView(saved));
    setMessage(`${agentId} model → ${next}`);
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

  // Enable or disable an agent. saveConfig() normalizes (it refuses to leave zero
  // agents enabled and re-picks the selection), so the confirmation is read back
  // from the saved config rather than from what we asked for.
  const setAgentEnabled = (id: ProviderId, enabled: boolean) => {
    const p = multi.providers[id];
    if (!p) return;
    const list = enabled
      ? multi.shared.providers.includes(id)
        ? multi.shared.providers
        : [...multi.shared.providers, id]
      : multi.shared.providers.filter((x) => x !== id);
    const saved = saveConfig({
      ...multi,
      shared: { ...multi.shared, providers: list },
      providers: { ...multi.providers, [id]: { ...p, enabled } },
    });
    setMulti(saved);
    setView(getView(saved));
    setMessage(`${id} ${saved.providers[id]?.enabled ? 'enabled' : 'disabled'}`);
    setDirty(true);
  };

  // Look for the agent's CLI and adopt the absolute path when the configured one
  // does not work. The scheduler runs with a minimal PATH, so an absolute path is
  // what makes the agent actually armable.
  const detectBinary = (id: ProviderId) => {
    const p = multi.providers[id];
    if (!p) return;
    const found = detectProvider(id, p.binary);
    setDetections((ds) => ds.map((d) => (d.id === id ? found : d)));
    if (!found.path) return setMessage(`${id}: no "${found.binary}" found on this machine`);
    if (found.configuredOk) return setMessage(`${id} binary ok — ${tildify(found.path)}`);
    const saved = saveConfig(patchProvider(multi, id, { binary: found.path }));
    setMulti(saved);
    setView(getView(saved));
    setMessage(`${id} binary → ${tildify(found.path)}`);
    setDirty(true);
  };

  const goTab = (next: TabKey) => {
    if (next === tab) return;
    setTab(next);
    setIdx(0);
    setMessage(`Tab → ${TABS.find((t) => t.key === next)?.label ?? next}`);
  };

  const stepTab = (dir: number) => {
    const i = TABS.findIndex((t) => t.key === tab);
    goTab(TABS[(i + dir + TABS.length) % TABS.length]!.key);
  };

  const cycleProvider = () => {
    const ids = multi.shared.providers.filter((id) => multi.providers[id]?.enabled);
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
    setAgentCursor(Math.max(0, knownAgents(saved).indexOf(next)));
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

  const startEdit = (key: 'tmux' | 'binary') => {
    setEditBuffer(key === 'tmux' ? (agentCfg?.tmuxSession ?? view.tmuxSession) : agentBinary);
    setEditKey(key);
  };
  const commitEdit = () => {
    const value = editBuffer.trim();
    if (value && editKey) {
      const patch = editKey === 'tmux' ? { tmuxSession: value } : { binary: value };
      const saved = saveConfig(patchProvider(multi, agentId, patch));
      setMulti(saved);
      setView(getView(saved));
      if (editKey === 'binary') {
        const found = detectProvider(agentId, value);
        setDetections((ds) => ds.map((d) => (d.id === agentId ? found : d)));
      }
      setMessage(
        editKey === 'tmux'
          ? `${agentId} session → ${value}`
          : `${agentId} binary → ${tildify(value)}`,
      );
      setDirty(true);
    }
    setEditKey(null);
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
      onAction?.('run', agentId);
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
    if (editKey) {
      if (key.return) return commitEdit();
      if (key.escape) return setEditKey(null);
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
    // 'd' acts on whichever agent the panel is pointing at: the one under the AGENTS
    // cursor while that tab is open, the selected agent otherwise.
    if (input === 'd') return detectBinary(agentId);

    if (key.tab) return stepTab(key.shift ? -1 : 1);
    const byDigit = TABS.find((t) => t.accel === input);
    if (byDigit) return goTab(byDigit.key);

    // The AGENTS row is a vertical LIST, so ↑/↓ walk the agents themselves and only
    // hand focus to the neighbouring row once the cursor is at an end. Moving off a
    // list with the very keys that should move inside it is what made the picker feel
    // like it "jumps to another panel". ←/→ move within the list too, wrapping.
    if (row.key === 'agents') {
      const at = (i: number) => agentIds[(i + agentIds.length) % agentIds.length]!;
      const moveCursor = (n: number) => {
        setAgentCursor(n);
        setMessage(`Agent cursor → ${at(n)}`);
      };
      if (key.upArrow) {
        if (agentCursor > 0) moveCursor(agentCursor - 1);
        else setIdx(ROWS.length - 1);
        return;
      }
      if (key.downArrow) {
        if (agentCursor < agentIds.length - 1) moveCursor(agentCursor + 1);
        else setIdx((rowIdx + 1) % ROWS.length);
        return;
      }
      if (key.leftArrow) return moveCursor((agentCursor - 1 + agentIds.length) % agentIds.length);
      if (key.rightArrow) return moveCursor((agentCursor + 1) % agentIds.length);
      if (input === ' ') {
        const id = at(agentCursor);
        return setAgentEnabled(id, !multi.providers[id]?.enabled);
      }
      // enter opens the agent's settings. Jumping focus (rather than making the user
      // walk the rest of the list to reach the Model row) is what makes per-agent
      // configuration reachable: the settings below are bound to the cursor, so the
      // agent under it is the one being edited.
      if (key.return) {
        setIdx(Math.min(rowIdx + 1, ROWS.length - 1));
        return setMessage(`Editing ${at(agentCursor)}`);
      }
      return;
    }

    if (key.upArrow) return setIdx(((rowIdx - 1 + ROWS.length) % ROWS.length) as number);
    if (key.downArrow) return setIdx(((rowIdx + 1) % ROWS.length) as number);

    const step = stepRows[row.key];
    if (step) {
      if (key.leftArrow) step(-1);
      else if (key.rightArrow) step(1);
      return;
    }
    if (row.key === 'mode' && (key.leftArrow || key.rightArrow)) toggleMode();
    else if (row.key === 'scheduler' && (key.leftArrow || key.rightArrow)) toggleScheduler();
    else if (row.key === 'tmux' && key.return) startEdit('tmux');
    else if (row.key === 'binary' && key.return) startEdit('binary');
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

  // Usage is read from the cache of the agent the panel is showing.
  const agentCache = status.usage?.providers?.[agentId] ?? null;

  return {
    multi,
    config: view,
    status,
    usage: formatUsage(agentCache),
    agentId,
    agentModel: String(agentCfg?.model ?? view.model),
    agentTmuxSession: agentCfg?.tmuxSession ?? view.tmuxSession,
    focusedKey: row.key,
    tab,
    tabs: TABS,
    actions: ACTIONS,
    hourCursor,
    agentIds,
    agentCursor,
    detections,
    binary: agentBinary,
    binaryOk,
    editing: editKey != null,
    editKey,
    editLabel: editKey === 'binary' ? 'Editing binary path' : 'Renaming session',
    editBuffer,
    showHelp,
    message,
    dirty,
    width,
    wide,
    gridCols,
    hint: `${MOVE_HINT}  ·  ${row.hint}  ·  ? help`,
  };
}

// The agents the config knows about, in registry order. Anything missing from the
// config map (an older file, a test fixture) is skipped, so the AGENTS cursor can
// never land on a row that isn't rendered.
function knownAgents(multi: MultiConfig): ProviderId[] {
  return ALL_PROVIDER_IDS.filter((id) => multi.providers[id]);
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
        ...(patch.binary != null ? { binary: patch.binary } : {}),
        ...(patch.tmuxSession != null ? { tmuxSession: patch.tmuxSession } : {}),
        ...(patch.workStart != null ? { workStart: patch.workStart } : {}),
        ...(patch.workEnd != null ? { workEnd: patch.workEnd } : {}),
        ...(patch.weeklyStopPercent != null ? { weeklyStopPercent: patch.weeklyStopPercent } : {}),
        ...(patch.schedule ? { schedule: patch.schedule } : {}),
      },
    },
  };
}
