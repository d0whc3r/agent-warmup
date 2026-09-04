// The Provider interface. Each provider (claude, opencode, …) wraps the bits
// that differ per backend: how to probe usage, how to decide whether to arm, and
// the shell script that does the arming. Everything else (config file, scheduler,
// logs, TUI) is shared and lives outside this module.
//
// The interface stays declarative so swapping a provider in a test (a fake
// "always-arms" or "never-arms" provider) remains straightforward. The
// `extra` field on ProviderConfig is the seam for provider-specific knobs that
// don't fit the common shape.
import type {
  Decision,
  ProviderCache,
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
  readonly name: string;
  readonly modelChoices: readonly string[];
  readonly probeKind: 'live' | 'estimated';
  // Read the provider's current usage. Returns null on transient failure — the
  // caller falls back to inferFromCache. Pure text in / structured out.
  probe(ctx: ProbeContext): ProviderUsage | null;
  // Produce the provider's best estimate when no live quota endpoint exists or
  // a probe fails. Most subscription plans use the last successful arm time.
  inferFromCache(ctx: ProbeContext, cache: ProviderCache | null): ProviderUsage;
  // Pure decision: given (usage, config, now), decide warm or skip (and why).
  // No I/O. The four behaviors must remain fully unit-testable without tmux/launchd.
  decide(ctx: ProbeContext, usage: ProviderUsage | null): Decision;
  // The shell script that arms a usage window for this provider. Returned as a
  // string; the caller materializes it under WARMUP_HOME and chmods it.
  armScript(): string;
  // Where the script gets materialized for this provider. The provider can read
  // its `binary`, `model`, `tmuxSession` from `cfg` to influence env vars.
  armScriptPath(ctx: ProbeContext): string;
  // Provider-specific variables consumed by the arm script. Credentials remain
  // in each CLI's own auth store; this only selects the binary and display name.
  armEnv(ctx: ProbeContext): NodeJS.ProcessEnv;
  // Optional persistent bookkeeping after an arm attempt (for example a
  // circuit-breaker cooldown). Keeping this here avoids id checks in tick.ts.
  recordArmResult?(
    ctx: ProbeContext,
    cache: ProviderCache,
    status: number,
  ): { cache: ProviderCache; log?: string };
}
