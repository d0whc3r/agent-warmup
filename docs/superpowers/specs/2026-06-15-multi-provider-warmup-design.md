# Multi-provider warmup: claude + opencode

**Status:** Superseded by `2026-09-04-agent-warmup-scope.md`.
**Date:** 2026-06-15
**Repo:** `claude-warmup` (existing)

## Goal

Extend `claude-warmup` so it can keep **two** independent usage windows warm — one for Claude Code, one for opencode — from a single CLI, a single config, a single scheduler entry, a single status/TUI, and a single set of logs. Each provider keeps its own decision cadence (working band, weekly stop, schedule) and its own usage cache, because their subscription reset times are independent.

The default `claude` provider must remain 100% behavior-compatible with the current single-provider build (no breaking changes for users who don't add opencode).

## Non-goals

- A pluggable provider system. Only `claude` and `opencode` ship built-in.
- Per-provider metrics, dashboards, JSON/CSV export, or telemetry beyond what `status` and `logs` already expose.
- Renaming the binary. It stays `claude-warmup`.
- Auto-discovery of the opencode binary. Default path is `~/.local/bin/opencode`, overridable via `WARMUP_OPENCODE_BIN`.
- Per-provider schedulers (separate plist/cron entries per provider). One scheduler entry ticks all providers.
- Web UI, notifications, or external integrations.
- Backporting the design to a separate "opencode-warmup" repo. This design is for this repo.

## Background

`claude-warmup` currently:

- Persists a single `Config` (`mode`, `schedule`, `smart`, `model`, `scheduler`, `tmuxSession`) to `~/.claude/warmup/warmup.env`.
- Reads Claude Code's `/usage` via a throwaway tmux session and parses three blocks: `session`, `week`, `weekSonnet` (see `src/usage.ts`).
- Decides via `decide()` in `src/decide.ts`: offhours / weekly-stop / active-window → skip, else `warm`.
- Runs a single `warmup.sh` that spawns `claude --safe-mode --model <model>` in tmux, sends a trivial prompt, captures the pane, exits.
- Schedules with launchd (one plist) or cron (one marked block), with `StartCalendarInterval` derived from `tickMinutes` × working band.
- Caches the last probe in `~/.claude/warmup/usage-cache.json` (flat shape, single provider).

Everything that's "different per provider" lives in:

- the binary path and the model (`binary`, `model`),
- the tmux session name (`tmuxSession`),
- how usage is read (Claude = parse `/usage` pane),
- how a warmup is armed (Claude = `warmup.sh` with `--safe-mode`),
- what counts as "active window" / "weekly stop" (currently hardcoded to 5h session and weekly quota in `decide.ts`).

The plan below extracts that per-provider variation into a `Provider` interface while keeping the shared plumbing (config file, scheduler, log dir, retention, TUI shell) untouched.

## Assumptions

These are the assumptions made in the user's absence during brainstorming. Each is marked with how it will be verified.

- **A-1 (architecture = unified single binary).** Verified by user silence + persistent continuation directives. Reversible: split into two CLIs is a much larger refactor.
- **A-2 (binary name stays `claude-warmup`).** Verified by the same. Reversible: rename is a one-line change in `package.json#bin` and a redirect shim.
- **A-3 (per-provider smart tunables, single shared tick cadence).** The scheduler ticks every `tickMinutes` (top-level, smallest of all enabled providers). At each tick, every provider runs its own `probe → decide → maybe arm`. Each provider's `decide` uses its own working band. _Verification:_ the user's exact wording — "para el 'smart' se tendrá que hacer independientemente en distintas horas para cada uno" — maps directly to per-provider working bands. If the user meant per-provider schedulers, that's A-3's negation: revert by adding `intervalsForPerProvider()` in `launchd.ts` / `cron.ts`.
- **A-4 (opencode exposes only PARTIAL usage data natively).** Real probe surface on `opencode` v1.17.7 (the binary this repo drives):
  - **weekly aggregate** (USD spent vs $30 weekly cap): `opencode stats --days 7` is built-in, parseable. Feeds `decide` with `week.pct` exactly like Claude's probe.
  - **session active** (5h $12 cap): **NOT queryable from the CLI today**. opencode issue [#19190](https://github.com/anomalyco/opencode/issues/19190) is in flight for `opencode quota`; until it ships, `decide.opencode` uses the cache-based `inferFromCacheFor` (lastWarmAt + 5h) as the active-window check. The `Provider` interface already absorbs this — `probe() => null` falls back gracefully (no per-tick reconfigure needed).
  - **community alternative**: `@slkiser/opencode-quota` plugin adds `/quota` slash command; **out of scope** for this design (third-party dep).
    _Verification:_ the opencode probe writes the parsed `opencode stats` output to `usage-cache.json` under the `opencode` key; the cache round-trip is the contract.
- **A-5 (opencode has both a session window and a weekly/monthly quota, similar to Claude).** _Verification:_ same spike. If opencode has only one of the two, the unused `decide` branch is left in place as a no-op (provider returns `null` for that block and `decide` skips that check).
- **A-6 (default opencode model = `opencode-go/deepseek-v4-flash`, the cheapest on Go).** Verified against the official Go model table: DeepSeek V4 Flash is the cheapest at **31,650 req / 5h** (~$0.0004 / request at the $12/5h cap). The next-cheapest is `mimo-v2.5` at 30,100 req / 5h; that's the fallback if V4 Flash is missing on the user's snapshot of opencode. Rationale: warmup is intentionally cheap (analogous to Claude's `haiku`); the user's _working_ model stays whatever they configure in opencode itself — `WARMUP_OPENCODE_MODEL` is for the arming model only. The user can override via the `model` TUI row (which now mutates the selected provider).

## Design

### 1. Config schema

**New schema** (one provider stanza per enabled provider; top-level keys become defaults for `claude`):

```bash
# Shared
WARMUP_MODE=smart
WARMUP_SCHEDULER=launchd
WARMUP_TICK_MINUTES=30
WARMUP_PROVIDERS=claude,opencode

# Provider: claude
WARMUP_CLAUDE_ENABLED=true
WARMUP_CLAUDE_BIN=~/.local/bin/claude
WARMUP_CLAUDE_MODEL=haiku
WARMUP_CLAUDE_TMUX_SESSION=claude-warmup
WARMUP_CLAUDE_WORK_START=8
WARMUP_CLAUDE_WORK_END=23
WARMUP_CLAUDE_WEEKLY_STOP_PERCENT=90
# fixed mode only:
# WARMUP_CLAUDE_SCHEDULE=8,13,18

# TUI/CLI selection (which provider the unprefixed subcommands mutate). Defaults to the first enabled provider.
WARMUP_SELECTED_PROVIDER=claude

# Provider: opencode
WARMUP_OPENCODE_ENABLED=true
WARMUP_OPENCODE_BIN=~/.local/bin/opencode
WARMUP_OPENCODE_MODEL=           # no default; user fills in
WARMUP_OPENCODE_TMUX_SESSION=opencode-warmup
WARMUP_OPENCODE_WORK_START=7
WARMUP_OPENCODE_WORK_END=22
WARMUP_OPENCODE_WEEKLY_STOP_PERCENT=85
# fixed mode only:
# WARMUP_OPENCODE_SCHEDULE=9,14,19
```

**Key naming rule:** every provider-specific key is `WARMUP_<UPPER_ID>_*`. The `<ID>` matches the value in `WARMUP_PROVIDERS` (claude, opencode). Order in `WARMUP_PROVIDERS` is the order the tick iterates providers — this is also the order they appear in `status` and the TUI.

**Migration from old schema:**

When `loadConfig()` reads an env that does **not** contain `WARMUP_PROVIDERS`:

1. Implicit provider list is `['claude']`.
2. Old top-level keys (`WARMUP_MODEL`, `WARMUP_TMUX_SESSION`, `WARMUP_SCHEDULE`, `WARMUP_WORK_START`, `WARMUP_WORK_END`, `WARMUP_WEEKLY_STOP_PERCENT`) are read as if they were `WARMUP_CLAUDE_*`.
3. On the next `saveConfig()` call, the file is rewritten in the new schema. **Migration is one-way and silent.** A backup of the old env is written to `warmup.env.bak` next to it on the first save.

The old `WARMUP_*` top-level keys are **kept recognized** on read forever (deprecated aliases), so even users who edit the env by hand don't break.

### 2. Provider abstraction

```ts
// src/providers/types.ts
export type ProviderId = 'claude' | 'opencode';

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
  // Provider-specific knobs that don't fit the common shape.
  // For claude: nothing yet. For opencode: TBD by the spike (A-4).
  extra: Record<string, unknown>;
}

export interface LimitBlock {
  pct: number | null;
  active?: boolean;
  resetsAt?: Date | null;
}

export interface ProviderUsage {
  session: LimitBlock | null;
  week: LimitBlock | null;
  capturedAt?: number;
  inferred?: boolean;
  // Provider-specific extras (e.g. claude: weekSonnet).
  [k: string]: unknown;
}

export type DecisionAction = 'warm' | 'skip-offhours' | 'skip-weekly' | 'skip-active';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

export interface Provider {
  id: ProviderId;
  /** Parse WARMUP_<ID>_* keys (plus the shared top-level defaults) into a ProviderConfig. */
  loadConfig(env: Record<string, string>, shared: SharedConfig): ProviderConfig;
  /** Read current usage from the running CLI. Returns null on failure. */
  probe(cfg: ProviderConfig, now: Date): ProviderUsage | null;
  /** Pure decision: given the usage and the config, decide warm or skip. */
  decide(cfg: ProviderConfig, usage: ProviderUsage | null, now: Date): Decision;
  /** The shell script that arms a usage window for this provider. */
  armScript(): string; // returns the embedded script text
  /** Where the script gets materialized for this provider (e.g. ~/.claude/warmup/arm-opencode.sh). */
  armScriptPath(): string;
}
```

**Files:**

- `src/providers/types.ts` — interfaces above.
- `src/providers/claude.ts` — registers `claude` provider. Wraps the current `parseUsage`, `decide`, and the body of the current `warmup.sh`. **No behavior change** for users who only have `claude` enabled.
- `src/providers/opencode.ts` — registers `opencode` provider. Implementation TBD by the spike; first commit gets the file shell, the `arm-opencode.sh` template (cloned from `warmup.sh` with provider-agnostic variables), and a `probe` that probes opencode in tmux. The `decide` is a near-copy of claude's until the spike tells us otherwise.
- `src/providers/index.ts` — registry. `getProvider(id)` returns the singleton. `listProviderIds()` returns `['claude', 'opencode']` in env order.

### 3. Tick (multi-provider)

The new `runTick`:

```ts
// src/tick.ts
export function runTick({ dryRun = false, now = new Date() }: TickOptions = {}) {
  const top = loadConfig();
  const results: Array<{
    id: ProviderId;
    decision: Decision;
    status: number;
    usage: ProviderUsage | null;
  }> = [];

  for (const id of top.providerIds) {
    const provider = getProvider(id);
    const cfg = provider.loadConfig(envForProvider(id), top.shared);
    if (!cfg.enabled) continue;

    let usage = provider.probe(cfg, now);
    let probed = !!usage;
    if (!usage) usage = inferFromCacheFor(id, now);

    const decision = provider.decide(cfg, usage, now);

    let status = 0;
    if (decision.action === 'warm' && !dryRun) {
      status = armProvider(cfg); // spawns armScript
      writeProviderCache(id, { lastWarmAt: now.getTime() });
    }
    writeProviderCache(id, {
      lastDecision: { ...decision, at: now.toISOString() },
      capturedAt: probed ? usage.capturedAt : undefined,
      session: usage.session,
      week: usage.week,
      ...(usage.weekSonnet ? { weekSonnet: usage.weekSonnet } : {}),
    });
    appendLog(
      now,
      `TICK [${id}] ${decision.action}${dryRun ? ' (dry-run)' : ''} — ${decision.reason} [via ${probed ? 'probe' : usage.inferred ? 'cache' : 'injected'}]`,
    );
    results.push({ id, decision, status, usage });
  }
  pruneLogs(now);
  return results;
}
```

The CLI subcommand `tick --dry-run` returns exit 0 unless at least one provider's `warm` step failed.

### 4. Arm scripts (one per provider)

`warmup.sh` is renamed to `arm-claude.sh` and its hardcoded Claude bits are parameterized:

```sh
# arm-claude.sh
WARMUP_PROVIDER=claude
WARMUP_BIN="${WARMUP_BIN:?must be set}"
WARMUP_MODEL="${WARMUP_MODEL:-haiku}"
WARMUP_TMUX_SESSION="${WARMUP_TMUX_SESSION:?must be set}"
WARMUP_PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_WORKDIR="${WARMUP_WORKDIR:?must be set}"
…
"$WARMUP_TMUX_BIN" new-session -d -s "$WARMUP_TMUX_SESSION" -x 220 -y 50 -c "$WARMUP_WORKDIR" \
  "$WARMUP_BIN" --safe-mode --model "$WARMUP_MODEL"
…
```

`arm-opencode.sh` is a near-clone, but spawns opencode (no `--safe-mode`; that's a Claude flag):

```sh
"$WARMUP_BIN" --model "$WARMUP_MODEL"
```

(The exact opencode flags are determined by the spike.)

Both scripts:

- live in `src/assets/` as strings in `assets.ts` (so they ship embedded in the SEA binary);
- are materialized under `WARMUP_HOME` by `ensureArmScript(providerId)`, replacing the current `ensureWarmupScript()`;
- are tracked in the `files` array of `package.json` so npm installs ship them too.

`runner.ts#runNow()` becomes provider-aware: it accepts a `providerId` (or reads it from the latest cache when the user runs `claude-warmup run` with no args — picks the first enabled provider, currently `claude`).

### 5. Scheduler (single entry, multi-provider tick)

**No change** to the surface of `launchd.ts` and `cron.ts` from the user's perspective. The plist still runs `node <entry> tick` at the `StartCalendarInterval` derived from the global `tickMinutes`. The `intervalsFor(config)` helper now reads from the shared `tickMinutes` (top-level), not from a per-provider cadence.

**Future-proofing (out of scope now):** if per-provider cadences diverge enough to make one shared cadence wasteful, `launchd.ts` can be extended to emit multiple plists (one per provider) and `schedule.applySchedule` would create a labeled plist per provider. This is explicitly **not** in the spec.

### 6. Cache (per-provider)

`usage-cache.json` becomes a map:

```json
{
  "claude": {
    "session": { "pct": 30, "active": true, "resetsAt": "2026-06-15T15:30:00+02:00" },
    "week": { "pct": 4, "active": false, "resetsAt": "2026-06-16T11:00:00+02:00" },
    "weekSonnet": { "pct": 0, "active": false },
    "lastDecision": {
      "action": "skip-active",
      "reason": "window active until 15:30",
      "at": "2026-06-15T13:00:00+02:00"
    },
    "lastWarmAt": 1750000000000
  },
  "opencode": {
    "session": null,
    "week": null,
    "lastDecision": {
      "action": "skip-offhours",
      "reason": "outside working hours 7-22",
      "at": "2026-06-15T03:00:00+02:00"
    }
  }
}
```

**Migration on read:** if the file is the old flat shape (has `session` at the top level, no provider keys), it's wrapped as `{ claude: <old-content> }` on first read and rewritten to the new shape.

**Per-provider `inferFromCacheFor`:** the fallback "did we arm in the last 5h?" is per-provider; each provider's `lastWarmAt` is its own.

### 7. TUI and status (multi-provider view)

**`claude-warmup status` (headless CLI):**

```
● claude-warmup  ACTIVE  (smart · launchd · 2 providers)
  window     08–23h · check every 30m
  scheduler  launchd
  ── claude ──
    model     haiku
    session   30% · resets 15:30
    weekly    4% · resets Jun 16 11:00   (as of 12m ago)
    last      [2026-06-15 13:00:00] TICK [claude] skip-active — window active until 15:30 [via probe]
  ── opencode ──
    model     minimax-m3
    session   (no probe yet)
    weekly    (no probe yet)
    last      [2026-06-15 13:00:00] TICK [opencode] skip-offhours — outside working hours 7-22 [via cache]
```

**TUI (Ink):** a horizontal tab strip across the top (`claude | opencode`) selects the active provider. The existing sections (`Settings`, `Schedule`, `Usage`, `Actions`) re-bind to the selected provider's config and cache. `Model`, `Work start/end`, `Weekly stop` etc. mutate the selected provider. `Save & apply` re-saves the whole config (the schema is one document, not one per provider).

**Empty / disabled providers:** if a provider is disabled, its tab is rendered disabled; the user can re-enable it from a small toggle in the `Settings` section.

### 8. Subcommand surface

Existing subcommands stay. Per-provider additions:

- `claude-warmup provider list` — show `claude, opencode` (with on/off).
- `claude-warmup provider <id> enable|disable` — toggles `WARMUP_<ID>_ENABLED`.
- `claude-warmup provider <id> model <name>` — sets `WARMUP_<ID>_MODEL`.
- `claude-warmup usage --provider <id>` — probes one provider (default: the one the user last interacted with, falling back to `claude`).
- `claude-warmup tick` — iterates all providers (today's behavior, just with more than one).
- `claude-warmup tick --provider <id>` — runs the tick for one provider only (used by `usage` and the TUI).
- `claude-warmup run` — runs the first enabled provider (no change from a Claude-only user's perspective).

### 9. Backward compatibility

A user with a pre-multi-provider install (no `WARMUP_PROVIDERS` in their env) gets:

- Identical behavior: `claude` is the only provider, all the existing keys keep working.
- The first `saveConfig()` call rewrites the env in the new schema and drops a `warmup.env.bak` next to it.
- All existing tests pass without modification (they exercise the `claude` provider).

The `cli.ts` subcommands `mode`, `model`, `schedule`, `scheduler` continue to work and mutate the **selected** provider. The selected provider is a piece of TUI state (persisted in the env as `WARMUP_SELECTED_PROVIDER=claude` or in the cache, defaulting to the first enabled provider). The TUI and the headless `cli` both default to the first enabled provider when no selection is given, so the legacy invocation `claude-warmup model haiku` continues to work for claude-only installs.

### 10. Error handling

- **Probe failure (transient).** Per-provider, falls back to `inferFromCacheFor`. If the cache is missing, treat as no active window and `warm` (the existing "did we arm in the last 5h?" behavior is the worst-case ceiling).
- **Arm script failure (provider's CLI errors out).** Each provider's `armProvider` exit code propagates. The tick logs `TICK [<id>] warm — <reason>` and `arm-<id>.sh` writes its own `START`/`OK`/`DONE` lines (same as today's `warmup.sh`). The next tick reconsiders.
- **Both providers failing on the same tick.** The `tick` returns the highest non-zero status; the plist/cron logs surface the error.
- **Go 5h cap reached mid-day (circuit breaker).** `arm-opencode.sh` will fail when Go's $12 / 5h cap is hit. To avoid ~25 wasted warmup attempts in the hour after the cap (at 31.6k req/5h the waste is <$0.01, but the log noise is worse), `decide.opencode` enters a **1h cooldown** when 2 consecutive arm failures happen within 30 min. During the cooldown, `decide` returns `skip-active` regardless of `lastWarmAt`; the cooldown clears on the next successful arm. Implemented in `src/providers/opencode.ts#decide` against the per-provider cache. (Not needed for Claude — its 5h window is request-capped, not dollar-capped.)
- **One provider disabled, the other enabled.** The disabled one is skipped; no `TICK [<id>]` line is written for it.
- **Cache file unreadable.** Treat as a fresh install. The `loadConfig` path's `try/catch` already does this for the env file; mirror that for the cache.

### 11. Testing

- **Move (don't rewrite) tests** that exercise claude behavior into `src/providers/claude/`:
  - `decide.test.ts` → `src/providers/claude/decide.test.ts` (imports the new `Provider.decide` from `claude.ts`).
  - `parse-usage.test.ts` → `src/providers/claude/probe.test.ts` (tests the parser as a pure function; the tmux-driving part is integration).
- **New unit tests:**
  - `src/providers/registry.test.ts` — get/list providers, env migration.
  - `src/tick.test.ts` — multi-provider orchestration with two fake providers (one always-arms, one never-arms) verifying iteration order, per-provider cache writes, and exit status.
  - `src/config-migration.test.ts` — old env shape → new env shape round-trip, cache file migration.
- **Integration:**
  - The `tick` subcommand is testable end-to-end with a `WARMUP_PROVIDERS=claude` env and a single claude-only tick (regression test for existing behavior).
- **No tests for `opencode.probe`** until the spike defines the shape. The first commit after the spike writes the probe + its test together.

### 12. File-by-file change map (for the plan)

| File                                    | Action  | Notes                                                                                                                                                                  |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/providers/types.ts`                | **new** | Interfaces in §2.                                                                                                                                                      |
| `src/providers/claude.ts`               | **new** | Wraps current `usage.ts` + `decide.ts` + `warmup.sh`.                                                                                                                  |
| `src/providers/opencode.ts`             | **new** | Body filled by the spike (A-4). Stub first.                                                                                                                            |
| `src/providers/index.ts`                | **new** | Registry.                                                                                                                                                              |
| `src/assets.ts`                         | modify  | `ensureArmScript(providerId)` replacing `ensureWarmupScript()`.                                                                                                        |
| `src/usage.ts`                          | delete  | Moved into `src/providers/claude/probe.ts`.                                                                                                                            |
| `src/decide.ts`                         | delete  | Moved into `src/providers/claude/decide.ts`.                                                                                                                           |
| `src/config.ts`                         | modify  | New schema, per-provider parsing, migration.                                                                                                                           |
| `src/types.ts`                          | modify  | Add `ProviderConfig`, `SharedConfig`.                                                                                                                                  |
| `src/paths.ts`                          | modify  | Add `ARM_SCRIPT(id)`, `PROVIDER_CACHE_PATH(id)`.                                                                                                                       |
| `src/tick.ts`                           | rewrite | Multi-provider iteration.                                                                                                                                              |
| `src/runner.ts`                         | modify  | `runNow(providerId?)`.                                                                                                                                                 |
| `src/status.ts`                         | modify  | `Status.providers: Record<id, ProviderStatus>`.                                                                                                                        |
| `src/print-status.ts`                   | modify  | Per-provider block printing.                                                                                                                                           |
| `src/launchd.ts`                        | modify  | Use shared `tickMinutes`. Plist env gets `WARMUP_PROVIDERS` so `tick` knows which to iterate (it reads from `loadConfig` anyway, but explicit is nicer for debugging). |
| `src/cron.ts`                           | modify  | Same as launchd.                                                                                                                                                       |
| `src/cli.ts`                            | modify  | New subcommands (`provider …`, `tick --provider <id>`, `usage --provider <id>`).                                                                                       |
| `src/ui/App.tsx`                        | modify  | Provider tab strip.                                                                                                                                                    |
| `src/ui/useWarmupUi.ts`                 | modify  | Selected-provider state.                                                                                                                                               |
| `src/ui/components/SettingsSection.tsx` | modify  | Bind to selected provider.                                                                                                                                             |
| `src/ui/components/UsageSection.tsx`    | modify  | Bind to selected provider.                                                                                                                                             |
| `src/ui/model.ts`                       | modify  | Per-provider status view.                                                                                                                                              |
| `warmup.sh`                             | rename  | → `src/assets/arm-claude.sh` (embedded string).                                                                                                                        |
| `src/assets/arm-claude.sh`              | **new** | Parameterized claude arm.                                                                                                                                              |
| `src/assets/arm-opencode.sh`            | **new** | Parameterized opencode arm (filled by spike).                                                                                                                          |
| `package.json`                          | modify  | `files` includes `src/assets/arm-*.sh`; SEA config updated.                                                                                                            |
| `scripts/build-sea.sh`                  | modify  | Embed both arm scripts.                                                                                                                                                |
| `sea-config.json`                       | modify  | Add both arm scripts.                                                                                                                                                  |
| `.env.example`                          | modify  | New schema, with `WARMUP_PROVIDERS` example.                                                                                                                           |
| `README.md`                             | modify  | Multi-provider section.                                                                                                                                                |
| `test/decide.test.ts`                   | move    | → `src/providers/claude/decide.test.ts`.                                                                                                                               |
| `test/parse-usage.test.ts`              | move    | → `src/providers/claude/probe.test.ts`.                                                                                                                                |
| `test/scheduler.test.ts`                | modify  | Reads new env schema.                                                                                                                                                  |
| `test/status.test.ts`                   | modify  | New multi-provider shape.                                                                                                                                              |
| `test/config.test.ts`                   | modify  | New schema + migration.                                                                                                                                                |
| `test/ui.test.ts`                       | modify  | Provider tab in TUI.                                                                                                                                                   |
| `test/registry.test.ts`                 | **new** |                                                                                                                                                                        |
| `test/tick.test.ts`                     | **new** | Multi-provider orchestration.                                                                                                                                          |
| `test/config-migration.test.ts`         | **new** |                                                                                                                                                                        |

### 13. Out of scope (deferred)

- Per-provider plist (one scheduler per provider). Cited in §5.
- A web UI, notifications, or external integrations.
- Per-provider metrics beyond the existing `usage-cache.json` and `warmup.log`.
- A pluggable provider system (third-party providers). The `Provider` interface is the seam, but no plugin loader ships.
- Migrating the cache file in-place is one-way and best-effort; if the file is corrupt, the loader throws and falls back to an empty cache (the env migration is the same).

## Open questions for the implementation plan

1. **A-4 verification spike:** how does opencode expose its current usage? (Slash command? CLI subcommand? State file? An `opencode` subcommand that prints JSON?) Output of the spike dictates the implementation of `src/providers/opencode/probe.ts`.
2. **opencode flags:** does opencode have an equivalent of `--safe-mode`? If yes, which one? (Determines the body of `arm-opencode.sh`.)
3. **default model for opencode:** the spec keeps `WARMUP_OPENCODE_MODEL` with no default. The plan should ask the user to pick (or accept whatever the user's currently using) before the first `run`.

## Verification

After implementation, the spec is satisfied when:

- `pnpm check` passes (typecheck, lint, format, tests).
- `claude-warmup status` (with the example config in `.env.example`) prints a section per enabled provider.
- `claude-warmup tick --dry-run` logs one `TICK [<id>]` line per enabled provider, in env order, and exits 0.
- With `WARMUP_PROVIDERS=claude` only, all existing tests pass and the on-disk shape of `warmup.env` and `usage-cache.json` matches the migrated new format.
- The migrated `warmup.env` carries a `.bak` next to it on the first save, with the original content.
- The opencode provider's probe passes a smoke test (in CI or in a local dev loop) on a real opencode install. The smoke test is a separate test file and is allowed to be skipped if `WARMUP_OPENCODE_BIN` is missing.
