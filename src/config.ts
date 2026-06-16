// Load and persist the warmup configuration (~/.claude/warmup/warmup.env).
// Two schemas live here:
//
//   * LEGACY (pre-multi-provider): flat WARMUP_* keys, single (claude) provider.
//     The env file had no WARMUP_PROVIDERS key. On read, this is mapped to a
//     MultiConfig with one provider (claude) and shared.mode/scheduler lifted
//     from the top level. On the first saveConfig() call, the file is rewritten
//     in the NEW schema and a warmup.env.bak is dropped next to it.
//
//   * NEW (multi-provider): WARMUP_PROVIDERS lists enabled provider ids, plus
//     WARMUP_<UPPER_ID>_* per-provider stanzas. Shared knobs (mode, scheduler,
//     tickMinutes, selectedProvider) live at the top level. This is what the
//     file looks like after the first save post-upgrade.
//
// loadConfig() always returns a MultiConfig; the legacy Config is exposed via
// getView() for the parts of the CLI/UI that still consume the merged view
// (the headless status command, the Ink TUI, the subcommand setters).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './paths.js';
import type {
  Config,
  ConfigInput,
  Mode,
  Model,
  MultiConfig,
  ProviderConfig,
  ProviderId,
  ProviderInput,
  Scheduler,
  SharedConfig,
  SmartConfig,
} from './types.js';
import { ALL_PROVIDER_IDS } from './providers/index.js';

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus'];
// launchd is macOS-only; elsewhere (Linux) cron is the only scheduler. normalize()
// uses this list, so a launchd value loaded on Linux funnels back to the cron default.
const IS_DARWIN = process.platform === 'darwin';
export const SCHEDULERS: readonly Scheduler[] = IS_DARWIN ? ['launchd', 'cron'] : ['cron'];
export const MODES: readonly Mode[] = ['smart', 'fixed'];
export const TICK_CHOICES: readonly number[] = [5, 10, 15, 20, 30, 60]; // allowed smart-mode tick cadences (minutes)
export const PROVIDER_IDS: readonly ProviderId[] = ALL_PROVIDER_IDS;

export const DEFAULT_SMART: SmartConfig = {
  workStart: 8,
  workEnd: 23,
  tickMinutes: 30,
  weeklyStopPercent: 90,
};

// Per-provider defaults. The values that come from the env override these; the
// values that don't fall back here. The two providers differ in:
//   - binary path (claude defaults to npm-global; opencode to ~/.opencode/bin)
//   - model (claude: haiku; opencode: cheapest Go model, see spec A-6)
//   - tmux session name (claude-warmup vs opencode-warmup)
//   - workStart/workEnd (opencode runs a tighter band)
function defaultProviderConfig(id: ProviderId): ProviderConfig {
  if (id === 'claude') {
    return {
      id: 'claude',
      enabled: true,
      binary: '~/.local/bin/claude',
      model: 'haiku',
      tmuxSession: 'claude-warmup',
      armScriptPath: '', // resolved at runtime
      workStart: DEFAULT_SMART.workStart,
      workEnd: DEFAULT_SMART.workEnd,
      weeklyStopPercent: DEFAULT_SMART.weeklyStopPercent,
      schedule: [8, 13, 18],
      extra: {},
    };
  }
  // opencode: cheapest Go model, tighter work band (verifies the user's
  // working hours, not the 24/7 of a long-running server).
  return {
    id: 'opencode',
    enabled: true,
    binary: '~/.opencode/bin/opencode',
    model: 'opencode-go/deepseek-v4-flash',
    tmuxSession: 'opencode-warmup',
    armScriptPath: '',
    workStart: 7,
    workEnd: 22,
    weeklyStopPercent: 85,
    schedule: [9, 14, 19],
    extra: {},
  };
}

export const DEFAULT_PROVIDERS: Record<ProviderId, ProviderConfig> = {
  claude: defaultProviderConfig('claude'),
  opencode: defaultProviderConfig('opencode'),
};

export const DEFAULT_SHARED: SharedConfig = {
  mode: 'smart',
  scheduler: SCHEDULERS[0],
  tickMinutes: DEFAULT_SMART.tickMinutes,
  providers: ['claude', 'opencode'],
  selectedProvider: 'claude',
};

export const DEFAULT_MULTI: MultiConfig = {
  shared: { ...DEFAULT_SHARED },
  providers: {
    claude: { ...DEFAULT_PROVIDERS.claude },
    opencode: { ...DEFAULT_PROVIDERS.opencode, enabled: true },
  },
};

// Legacy default (kept for backward-compat with existing tests that construct
// `Config` objects directly).
export const DEFAULT_CONFIG: Config = {
  mode: DEFAULT_MULTI.shared.mode,
  schedule: DEFAULT_PROVIDERS.claude.schedule,
  smart: {
    workStart: DEFAULT_PROVIDERS.claude.workStart,
    workEnd: DEFAULT_PROVIDERS.claude.workEnd,
    tickMinutes: DEFAULT_SHARED.tickMinutes,
    weeklyStopPercent: DEFAULT_PROVIDERS.claude.weeklyStopPercent,
  },
  model: DEFAULT_PROVIDERS.claude.model,
  scheduler: DEFAULT_SHARED.scheduler,
  tmuxSession: DEFAULT_PROVIDERS.claude.tmuxSession,
};

// Membership test that narrows an untrusted string to the literal-union element type.
const isOneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T =>
  value != null && (values as readonly string[]).includes(value);

// Public API: load the persisted config. Returns the multi-provider shape;
// callers that need the legacy "merged view of the selected provider" use
// getView() below.
export function loadConfig(): MultiConfig {
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return cloneDefault();
  }
  return parseMultiConfig(text);
}

// Public API: persist a config. Accepts either the legacy `Config`/`ConfigInput`
// shape (decomposed into the new schema, with shared.mode/scheduler lifted
// and the rest going to the selected provider) or a partial MultiConfig.
export function saveConfig(input: ConfigInput | Partial<MultiConfig>): MultiConfig {
  const next = normalizeMultiConfig(input);
  // Migration: on the first save where the existing file is in the LEGACY
  // schema (no WARMUP_PROVIDERS), drop a `.bak` next to it before rewriting.
  try {
    const existing = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (existing && !/(^|\n)WARMUP_PROVIDERS\s*=/.test(existing)) {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    }
  } catch {
    /* no existing file -- nothing to back up */
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, serializeMultiConfig(next));
  return next;
}

// Convert a MultiConfig into the legacy merged view of the SELECTED provider +
// shared. This is the shape the existing UI/CLI expects.
export function getView(multi: MultiConfig): Config {
  const sel = multi.shared.selectedProvider;
  const p = multi.providers[sel] ?? DEFAULT_PROVIDERS.claude;
  return {
    mode: multi.shared.mode,
    schedule: p.schedule,
    smart: {
      workStart: p.workStart,
      workEnd: p.workEnd,
      tickMinutes: multi.shared.tickMinutes,
      weeklyStopPercent: p.weeklyStopPercent,
    },
    model: p.model,
    scheduler: multi.shared.scheduler,
    tmuxSession: p.tmuxSession,
  };
}

// Pure text <-> multi-config helpers (no fs), so the format is unit-testable.
export function parseMultiConfig(text: string): MultiConfig {
  return normalizeMultiConfig({ __rawEnv: parseEnv(text) } as ConfigInput);
}

export function serializeMultiConfig(multi: MultiConfig): string {
  return serialize(multi);
}

// Pure legacy parser, kept for the test suite that constructs Config objects
// directly and round-trips them through the .env format.
export function parseConfig(text: string): Config {
  const multi = parseMultiConfig(text);
  return getView(multi);
}

export function serializeConfig(cfg: Config): string {
  // Round-trip a legacy Config back to a flat .env: shared.mode/scheduler at
  // the top, everything else under WARMUP_CLAUDE_*. (The legacy tests assert
  // these exact keys, so this stays the legacy surface.)
  return serializeLegacy(cfg);
}

// ---- normalization -----------------------------------------------------------

// Internal input shape for normalizeMultiConfig. Holds either a parsed .env
// (`__rawEnv`) or a structured legacy/multi input; the two are kept separate
// to avoid the `providers` field name collision (CSV string in legacy,
// ProviderId[] in the multi shape).
interface RawConfigInput {
  legacy?: ConfigInput;
  multi?: Partial<MultiConfig>;
  __rawEnv?: Record<string, string>;
}

function normalizeMultiConfig(
  input: ConfigInput | Partial<MultiConfig> | RawConfigInput,
): MultiConfig {
  // Normalize to RawConfigInput so the body can read `legacy` and `multi` uniformly.
  if (
    (input as RawConfigInput).__rawEnv ||
    (input as RawConfigInput).legacy ||
    (input as RawConfigInput).multi
  ) {
    return _normalize(input as RawConfigInput);
  }
  // Plain ConfigInput or Partial<MultiConfig> caller: wrap accordingly.
  return _normalize({
    multi: (input as Partial<MultiConfig>).shared ? (input as Partial<MultiConfig>) : undefined,
    legacy: (input as Partial<MultiConfig>).shared ? undefined : (input as ConfigInput),
  });
}
function _normalize(input: RawConfigInput): MultiConfig {
  const raw = (input as RawConfigInput).__rawEnv;
  const env = raw ?? envFromStructured(input.legacy ?? (input as ConfigInput), input.multi);
  // Detect legacy schema (no WARMUP_PROVIDERS in the env) and route to the
  // legacy mapper. This is the one-way migration path described in spec §1.
  if (raw && !env.WARMUP_PROVIDERS) {
    const structured = legacyToStructured(env);
    return normalizeMultiConfig({ legacy: structured.legacy, multi: structured.multi });
  }
  // ---- shared ----
  const shared: SharedConfig = {
    mode: pickMode(env.WARMUP_MODE) ?? DEFAULT_SHARED.mode,
    scheduler: pickScheduler(env.WARMUP_SCHEDULER) ?? DEFAULT_SHARED.scheduler,
    tickMinutes: pickTick(env.WARMUP_TICK_MINUTES) ?? DEFAULT_SHARED.tickMinutes,
    providers: pickProviders(env.WARMUP_PROVIDERS) ?? [...DEFAULT_SHARED.providers],
    selectedProvider:
      pickProviderId(env.WARMUP_SELECTED_PROVIDER) ?? DEFAULT_SHARED.selectedProvider,
  };
  // ---- per-provider ----
  const providers: Record<ProviderId, ProviderConfig> = {
    claude: normalizeProvider('claude', env, input.legacy ?? (input as ConfigInput), input.multi),
    opencode: normalizeProvider(
      'opencode',
      env,
      input.legacy ?? (input as ConfigInput),
      input.multi,
    ),
  };
  // The shared.providers list only includes ids that are actually enabled
  // (legacy users have no opencode enabled by default).
  shared.providers = shared.providers.filter((id) => providers[id]?.enabled);
  if (shared.providers.length === 0) {
    // Safety net: a config with no enabled providers is a footgun. Fall back
    // to enabling claude so `claude-warmup tick` still has something to do.
    providers.claude.enabled = true;
    shared.providers = ['claude'];
  }
  // If the selected provider got disabled, fall back to the first enabled one.
  if (!providers[shared.selectedProvider]?.enabled) {
    shared.selectedProvider = shared.providers[0] ?? 'claude';
  }
  return { shared, providers };
}

function envFromStructured(
  legacy: ConfigInput | undefined,
  multi: Partial<MultiConfig> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Top-level shared keys (legacy ConfigInput).
  const l = legacy;
  if (l?.mode) env.WARMUP_MODE = String(l.mode);
  if (l?.scheduler) env.WARMUP_SCHEDULER = String(l.scheduler);
  if (l?.model) env.WARMUP_MODEL = String(l.model);
  if (l?.tmuxSession) env.WARMUP_TMUX_SESSION = String(l.tmuxSession);
  if (l?.schedule) env.WARMUP_SCHEDULE = (l.schedule as readonly (string | number)[]).join(',');
  if (l?.smart) {
    const smart = l.smart;
    if (smart.workStart != null) env.WARMUP_WORK_START = String(smart.workStart);
    if (smart.workEnd != null) env.WARMUP_WORK_END = String(smart.workEnd);
    if (smart.tickMinutes != null) env.WARMUP_TICK_MINUTES = String(smart.tickMinutes);
    if (smart.weeklyStopPercent != null)
      env.WARMUP_WEEKLY_STOP_PERCENT = String(smart.weeklyStopPercent);
  }
  // Multi-shape keys.
  if (multi?.shared) {
    const s = multi.shared;
    if (s.mode) env.WARMUP_MODE = s.mode;
    if (s.scheduler) env.WARMUP_SCHEDULER = s.scheduler;
    if (s.tickMinutes != null) env.WARMUP_TICK_MINUTES = String(s.tickMinutes);
    if (s.providers) env.WARMUP_PROVIDERS = s.providers.join(',');
    if (s.selectedProvider) env.WARMUP_SELECTED_PROVIDER = s.selectedProvider;
  }
  // Per-provider inputs.
  for (const id of ALL_PROVIDER_IDS) {
    const p = l?.[id] as ProviderInput | undefined;
    if (!p) continue;
    const U = id.toUpperCase();
    if (p.enabled != null) env[`WARMUP_${U}_ENABLED`] = String(p.enabled);
    if (p.binary) env[`WARMUP_${U}_BIN`] = p.binary;
    if (p.model) env[`WARMUP_${U}_MODEL`] = p.model;
    if (p.tmuxSession) env[`WARMUP_${U}_TMUX_SESSION`] = p.tmuxSession;
    if (p.workStart != null) env[`WARMUP_${U}_WORK_START`] = String(p.workStart);
    if (p.workEnd != null) env[`WARMUP_${U}_WORK_END`] = String(p.workEnd);
    if (p.weeklyStopPercent != null)
      env[`WARMUP_${U}_WEEKLY_STOP_PERCENT`] = String(p.weeklyStopPercent);
    if (p.schedule) env[`WARMUP_${U}_SCHEDULE`] = p.schedule.join(',');
  }
  return env;
}

// Map a legacy env (no WARMUP_PROVIDERS) to a structured input that the new
// path can normalize. Top-level keys land on the claude provider; shared.mode
// and shared.scheduler come from the legacy top-level keys.
function legacyToStructured(env: Record<string, string>): {
  legacy: ConfigInput;
  multi: Partial<MultiConfig>;
} {
  const claude: ProviderInput = { enabled: true };
  if (env.WARMUP_MODEL) claude.model = env.WARMUP_MODEL;
  if (env.WARMUP_TMUX_SESSION) claude.tmuxSession = env.WARMUP_TMUX_SESSION;
  if (env.WARMUP_SCHEDULE) {
    claude.schedule = env.WARMUP_SCHEDULE.split(',')
      .map(Number)
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  }
  if (env.WARMUP_WORK_START) claude.workStart = Number(env.WARMUP_WORK_START);
  if (env.WARMUP_WORK_END) claude.workEnd = Number(env.WARMUP_WORK_END);
  if (env.WARMUP_WEEKLY_STOP_PERCENT)
    claude.weeklyStopPercent = Number(env.WARMUP_WEEKLY_STOP_PERCENT);
  // Mirror the legacy fields on the legacy ConfigInput (used by callers that
  // pass the legacy shape through saveConfig()).
  return {
    legacy: {},
    multi: {
      shared: {
        mode: pickMode(env.WARMUP_MODE) ?? DEFAULT_SHARED.mode,
        scheduler: pickScheduler(env.WARMUP_SCHEDULER) ?? DEFAULT_SHARED.scheduler,
        tickMinutes: pickTick(env.WARMUP_TICK_MINUTES) ?? DEFAULT_SHARED.tickMinutes,
        providers: ['claude'],
        selectedProvider: 'claude',
      },
      providers: { claude } as Record<ProviderId, ProviderConfig>,
    },
  };
}

function normalizeProvider(
  id: ProviderId,
  env: Record<string, string>,
  structured: ConfigInput,
  multi: Partial<MultiConfig> = {},
): ProviderConfig {
  const U = id.toUpperCase();
  const defaults = DEFAULT_PROVIDERS[id];
  const fromStructured =
    (structured[id] as ProviderInput | undefined) ??
    (multi.providers?.[id] as ProviderInput | undefined) ??
    {};
  const enabledRaw =
    env[`WARMUP_${U}_ENABLED`] ??
    (fromStructured.enabled != null ? String(fromStructured.enabled) : undefined);
  const enabled =
    enabledRaw == null
      ? id === 'claude'
        ? true
        : false // claude enabled by default; opencode off
      : isOneOf(['true', 'false'], enabledRaw.toLowerCase())
        ? enabledRaw.toLowerCase() === 'true'
        : Boolean(enabledRaw);
  const workStart =
    numFrom(env[`WARMUP_${U}_WORK_START`], fromStructured.workStart) ?? defaults.workStart;
  const workEnd = numFrom(env[`WARMUP_${U}_WORK_END`], fromStructured.workEnd) ?? defaults.workEnd;
  const weeklyStopPercent =
    numFrom(env[`WARMUP_${U}_WEEKLY_STOP_PERCENT`], fromStructured.weeklyStopPercent) ??
    defaults.weeklyStopPercent;
  const scheduleRaw =
    env[`WARMUP_${U}_SCHEDULE`] ??
    (fromStructured.schedule ? fromStructured.schedule.join(',') : undefined);
  const schedule = scheduleRaw
    ? [...new Set(scheduleRaw.split(',').map(Number))]
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
        .sort((a, b) => a - b)
    : [...defaults.schedule];
  // tmux forbids '.'/':' in session names; whitespace breaks cron lines and send-keys.
  const tmuxSession =
    String(env[`WARMUP_${U}_TMUX_SESSION`] ?? fromStructured.tmuxSession ?? defaults.tmuxSession)
      .trim()
      .replace(/[\s.:]+/g, '-') || defaults.tmuxSession;
  return {
    id,
    enabled,
    binary: env[`WARMUP_${U}_BIN`] ?? fromStructured.binary ?? defaults.binary,
    model: env[`WARMUP_${U}_MODEL`] ?? fromStructured.model ?? defaults.model,
    tmuxSession,
    armScriptPath: defaults.armScriptPath, // resolved at runtime
    workStart: clampHour(workStart, defaults.workStart, 0, 23),
    workEnd: Math.max(
      clampHour(workStart, defaults.workStart, 0, 23) + 1,
      clampHour(workEnd, defaults.workEnd, 0, 23),
    ),
    weeklyStopPercent: clampPercent(weeklyStopPercent, defaults.weeklyStopPercent),
    schedule,
    extra: defaults.extra,
  };
}

function numFrom(env: string | undefined, structured: unknown): number | undefined {
  if (env != null && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n)) return n;
  }
  if (typeof structured === 'number' && Number.isFinite(structured)) return structured;
  return undefined;
}

function clampHour(v: number, d: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) return d;
  return v;
}

function clampPercent(v: number, d: number): number {
  if (!Number.isFinite(v)) return d;
  return Math.min(100, Math.max(1, Math.round(v)));
}

function pickMode(v: string | undefined): Mode | undefined {
  return isOneOf(MODES, v) ? v : undefined;
}
function pickScheduler(v: string | undefined): Scheduler | undefined {
  return isOneOf(SCHEDULERS, v) ? v : undefined;
}
function pickTick(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return TICK_CHOICES.includes(n) ? n : undefined;
}
function pickProviderId(v: string | undefined): ProviderId | undefined {
  return isOneOf(PROVIDER_IDS, v) ? v : undefined;
}
function pickProviders(v: string | undefined): ProviderId[] | undefined {
  if (v == null || v === '') return undefined;
  const ids = v
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ProviderId => isOneOf(PROVIDER_IDS, s));
  // Preserve user order; dedupe.
  return [...new Set(ids)];
}

// Minimal dotenv reader: skips blanks/comment lines, splits on the first '=',
// strips surrounding quotes and tolerates a trailing ` # comment` on bare values.
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    env[key] = value;
  }
  return env;
}

// ---- serialization -----------------------------------------------------------

function serialize(multi: MultiConfig): string {
  const lines: string[] = [];
  lines.push('# claude-warmup configuration');
  lines.push('# Edit a value and run `claude-warmup restart` to apply. Keys are the WARMUP_*');
  lines.push('# environment variables the arm scripts read, so you can also `set -a; source`');
  lines.push('# this file to reproduce a run by hand.');
  lines.push('');
  lines.push('# ── Shared (top-level) ───────────────────────────────────────────────');
  lines.push(`WARMUP_MODE=${multi.shared.mode}`);
  lines.push(`WARMUP_SCHEDULER=${multi.shared.scheduler}`);
  lines.push(`WARMUP_TICK_MINUTES=${multi.shared.tickMinutes}`);
  lines.push(`WARMUP_PROVIDERS=${multi.shared.providers.join(',')}`);
  lines.push(`WARMUP_SELECTED_PROVIDER=${multi.shared.selectedProvider}`);
  lines.push('');
  for (const id of ALL_PROVIDER_IDS) {
    const p = multi.providers[id];
    lines.push(`# ── Provider: ${id} ─${'─'.repeat(Math.max(0, 50 - id.length))}`);
    lines.push(`WARMUP_${id.toUpperCase()}_ENABLED=${p.enabled}`);
    lines.push(`WARMUP_${id.toUpperCase()}_BIN=${p.binary}`);
    lines.push(`WARMUP_${id.toUpperCase()}_MODEL=${p.model}`);
    lines.push(`WARMUP_${id.toUpperCase()}_TMUX_SESSION=${p.tmuxSession}`);
    lines.push(`WARMUP_${id.toUpperCase()}_WORK_START=${p.workStart}`);
    lines.push(`WARMUP_${id.toUpperCase()}_WORK_END=${p.workEnd}`);
    lines.push(`WARMUP_${id.toUpperCase()}_WEEKLY_STOP_PERCENT=${p.weeklyStopPercent}`);
    if (p.schedule.length) {
      lines.push(`WARMUP_${id.toUpperCase()}_SCHEDULE=${p.schedule.join(',')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function serializeLegacy(cfg: Config): string {
  return (
    [
      '# claude-warmup configuration (legacy single-provider format)',
      `WARMUP_MODE=${cfg.mode}`,
      `WARMUP_MODEL=${cfg.model}`,
      `WARMUP_SCHEDULER=${cfg.scheduler}`,
      `WARMUP_TMUX_SESSION=${cfg.tmuxSession}`,
      `WARMUP_SCHEDULE=${cfg.schedule.join(',')}`,
      `WARMUP_WORK_START=${cfg.smart.workStart}`,
      `WARMUP_WORK_END=${cfg.smart.workEnd}`,
      `WARMUP_TICK_MINUTES=${cfg.smart.tickMinutes}`,
      `WARMUP_WEEKLY_STOP_PERCENT=${cfg.smart.weeklyStopPercent}`,
    ].join('\n') + '\n'
  );
}

function cloneDefault(): MultiConfig {
  return {
    shared: { ...DEFAULT_SHARED },
    providers: {
      claude: { ...DEFAULT_PROVIDERS.claude },
      opencode: { ...DEFAULT_PROVIDERS.opencode, enabled: true },
    },
  };
}

// Re-export so test/config.test.ts (which imports the legacy parseConfig/serializeConfig)
// and the rest of the codebase share a single canonical ConfigInput type.
export type { ConfigInput, ProviderInput, MultiConfig, ProviderConfig, ProviderId, Config };
