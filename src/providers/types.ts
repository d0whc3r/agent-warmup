// The Provider interface. Each provider (claude, opencode, …) wraps the bits
// that differ per backend: how to probe usage, how to decide whether to arm, and
// the shell script that does the arming. Everything else (config file, scheduler,
// logs, TUI) is shared and lives outside this module.
//
// The interface is intentionally narrow — five methods — so swapping a provider
// in a test (a fake "always-arms" or "never-arms" provider) is one line. The
// `extra` field on ProviderConfig is the seam for provider-specific knobs that
// don't fit the common shape.
import type {
  Decision,
  ProviderConfig,
  ProviderId,
  ProviderUsage,
  SharedConfig,
} from '../types.js';

export interface ProbeContext {
  // The resolved provider config (one provider's stanza, fully normalized).
  cfg: ProviderConfig;
  // The shared top-level config (mode/scheduler/tickMinutes/providers list).
  shared: SharedConfig;
  // "now" for testability; defaults to new Date().
  now: Date;
}

export interface Provider {
  readonly id: ProviderId;
  // Read the provider's current usage. Returns null on transient failure — the
  // caller falls back to inferFromCache. Pure text in / structured out.
  probe(ctx: ProbeContext): Promise<ProviderUsage | null> | ProviderUsage | null;
  // Pure decision: given (usage, config, now), decide warm or skip (and why).
  // No I/O. The four behaviors must remain fully unit-testable without tmux/launchd.
  decide(ctx: ProbeContext, usage: ProviderUsage | null): Decision;
  // The shell script that arms a usage window for this provider. Returned as a
  // string; the caller materializes it under WARMUP_HOME and chmods it.
  armScript(): string;
  // Where the script gets materialized for this provider. The provider can read
  // its `binary`, `model`, `tmuxSession` from `cfg` to influence env vars.
  armScriptPath(ctx: ProbeContext): string;
  // How this provider's arm failure is reported back to the tick for the
  // circuit-breaker / cooldown logic (see opencode's decide for the canonical
  // impl). Default: no cooldown (legacy behavior).
  onArmFailure?(ctx: ProbeContext, err: unknown): void;
}
