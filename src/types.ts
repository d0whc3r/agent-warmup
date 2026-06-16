// Shared domain types. The config and usage shapes cross most modules, so they live
// here in one place rather than being re-declared per file.

export type Mode = 'smart' | 'fixed';
export type Model = 'haiku' | 'sonnet' | 'opus';
export type Scheduler = 'launchd' | 'cron';

// Multi-provider identity. The string literal stays in sync with the env key prefix
// (WARMUP_<UPPER_ID>_*); if a third provider is ever added, the registry in
// src/providers/index.ts is the single source of truth.
export type ProviderId = 'claude' | 'opencode';

// A parsed /usage block (session / weekly / sonnet). `resetsAt` is a Date when freshly
// parsed; the cache round-trip turns it into an ISO string, so consumers must coerce.
export interface LimitBlock {
  pct: number | null;
  resetsAt?: Date | null;
  active?: boolean;
}

// Per-provider usage snapshot. Same shape as the legacy UsageSnapshot so the
// existing cache migrates 1:1 into the per-provider cache map.
export interface ProviderUsage {
  session: LimitBlock | null;
  week: LimitBlock | null;
  weekSonnet?: LimitBlock | null;
  capturedAt?: number;
  inferred?: boolean;
}

// Smart-mode tunables PER PROVIDER (workStart/workEnd/weeklyStopPercent); the
// cadence (tickMinutes) is shared, so it lives on SharedConfig.
export interface SmartConfig {
  workStart: number;
  workEnd: number;
  tickMinutes: number;
  weeklyStopPercent: number;
}

// Per-provider config. Lives in the new schema under WARMUP_<UPPER_ID>_* keys.
// `schedule` is only meaningful when shared.mode is 'fixed' (per-provider hours).
// `extra` is the seam for provider-specific knobs that don't fit the common shape.
export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  binary: string;
  model: string;
  tmuxSession: string;
  armScriptPath: string; // resolved at runtime; defaults to ~/.claude/warmup/arm-<id>.sh
  workStart: number;
  workEnd: number;
  weeklyStopPercent: number;
  schedule: number[]; // empty in smart mode
  extra: Record<string, unknown>;
}

// Top-level / shared config. Applies to all enabled providers; the scheduler reads
// `tickMinutes` for its StartCalendarInterval, and `mode` decides which decide path
// runs (smart: probe + decide; fixed: arm unconditionally on the per-provider hours).
export interface SharedConfig {
  mode: Mode;
  scheduler: Scheduler;
  tickMinutes: number;
  providers: ProviderId[]; // ordered; the tick iterates in this order
  selectedProvider: ProviderId; // for headless subcommands without --provider
}

// The new top-level config doc: shared + a map of per-provider configs.
export interface MultiConfig {
  shared: SharedConfig;
  providers: Record<ProviderId, ProviderConfig>;
}

// Per-provider patch input. Used by `saveConfig` and the TUI's patchProvider()
// helper so callers can mutate one provider's fields without rebuilding the
// whole MultiConfig. All fields are optional; absent ones are left untouched.
export interface ProviderInput {
  enabled?: boolean;
  binary?: string;
  model?: string;
  tmuxSession?: string;
  workStart?: number;
  workEnd?: number;
  weeklyStopPercent?: number;
  schedule?: number[];
  extra?: Record<string, unknown>;
}

// Loose, pre-normalization config: values may be missing or carry the raw strings
// the .env parser produced. normalize() coerces this into the right shape.
export interface ConfigInput {
  mode?: string;
  schedule?: ReadonlyArray<string | number>;
  smart?: Partial<SmartConfig>;
  model?: string;
  scheduler?: string;
  tmuxSession?: unknown;
  // New (per-provider) inputs:
  providers?: ReadonlyArray<string>;
  selectedProvider?: string;
  claude?: Partial<ProviderConfig>;
  opencode?: Partial<ProviderConfig>;
}

// The legacy "merged view" config (selected provider + shared, flattened for
// backward-compat with the existing UI/CLI/tests). loadConfig() returns MultiConfig;
// getView() returns this for callers that only need the active provider's config.
export interface Config {
  mode: Mode;
  schedule: number[];
  smart: SmartConfig;
  model: Model | string; // string allows the opencode "provider/model" form
  scheduler: Scheduler;
  tmuxSession: string;
}

export type DecisionAction = 'warm' | 'skip-offhours' | 'skip-weekly' | 'skip-active';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

// The decision as persisted in the usage cache (with the wall-clock instant it ran).
export interface CachedDecision extends Decision {
  at: string;
}

// A per-provider cache entry. `lastWarmAt` + `lastDecision` power the
// `inferFromCache` fallback when a live probe fails.
export interface ProviderCache extends Partial<ProviderUsage> {
  lastDecision?: CachedDecision;
  lastWarmAt?: number;
  // Cooldown state for providers with a hard 5h cap (e.g. opencode-go). Set by
  // decide() when two consecutive arm failures land within 30 min; cleared on
  // the next successful arm. Treated as opaque by other providers.
  cooldownUntil?: number;
}

// The on-disk usage cache: the last probe snapshot per provider plus per-provider
// tick bookkeeping. Migrated from the old flat shape on first read.
export interface UsageCache {
  providers: Partial<Record<ProviderId, ProviderCache>>;
  // Backward-compat: legacy readers may read .session / .week at the top level.
  // New code MUST use .providers[selectedProvider].
  selectedProvider?: ProviderId;
}

// Display strings derived from a cache snapshot for status/TUI output.
export interface UsageView {
  session: string;
  week: string;
  ageMin: number | null;
  lastDecision?: CachedDecision;
}

export interface LaunchdStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled: boolean;
}

export interface CronStatus {
  installed: boolean;
}

// Aggregate status across config, the two schedulers, recent logs and the usage cache.
export interface Status {
  config: MultiConfig;
  view: Config; // the legacy merged view of the selected provider
  launchd: LaunchdStatus;
  cron: CronStatus;
  active: boolean;
  nextRun: string | null;
  lastRun: string | null;
  usage: UsageCache | null;
}

// Deferred TUI actions the CLI runs after Ink unmounts (Ink owns the terminal while
// mounted, so `run`/`logs` can't spawn their own foreground processes until it exits).
export type UiAction = 'run' | 'logs';
