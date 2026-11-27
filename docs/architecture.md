# Architecture

agent-warmup is one static Go binary. The scheduled job runs the same binary with `tick`, so the scheduler and the CLI always share one version. This page shows the package map, the dependency rules, and the flow of one tick.

## Contents

- [Package map](#package-map)
- [Dependency rules](#dependency-rules)
- [The flow of one tick](#the-flow-of-one-tick)
- [The timeline of the terminal UI](#the-timeline-of-the-terminal-ui)
- [Files on disk](#files-on-disk)

## Package map

| Package | Job |
| --- | --- |
| `cmd/agent-warmup` | `main`. Holds the build info (`version`, `commit`, `date`, set with `-ldflags -X`), sets up signal handling, and calls `cli.Execute`. |
| `internal/cli` | The [cobra](https://github.com/spf13/cobra) command tree and the status output. |
| `internal/tui` | The terminal UI, built with [Bubble Tea v2](https://github.com/charmbracelet/bubbletea). It draws the lanes that `warmup.Timeline` projects, and runs every key, edit panel field, and command through one action table. One function renders the frame and records its click zones, so the mouse hits what the screen shows. |
| `internal/warmup` | The tick (probe, decide, arm), the runner that runs the arm scripts, and `Timeline`, which projects each agent's day for the terminal UI. |
| `internal/scheduler` | Installs, removes, and reports the job that runs the tick every 15 minutes: the launchd job on macOS, the cron block on Linux. |
| `internal/detect` | Finds the agent CLIs and checks the OpenCode credentials. |
| `internal/selfupdate` | `upgrade` from GitHub releases and `uninstall`. |
| `internal/legacy` | Removes what the TypeScript release left behind: the old launchd job, the old cron block, and their tmux sessions (`config.LegacySessions`). `install.sh` runs it through `agent-warmup clean-legacy`. |
| `internal/sysexec` | Runs `launchctl`, `crontab`, and `tmux` for `scheduler`, `legacy`, and `selfupdate`. |
| `internal/sandbox` | Test helper. Gives a test its own `HOME`, `WARMUP_HOME`, and stub `launchctl`, `crontab`, and `tmux` on `PATH`. Only tests import it. |
| `internal/provider` | The `Provider` interface, the seven providers, and their embedded arm scripts (`scripts/*.sh`). |
| `internal/config` | Loads, validates, and saves `config.toml`, and migrates `warmup.env`. |
| `internal/cache` | Reads `usage-cache.json` and updates one provider entry under a file lock. |
| `internal/logs` | Appends to, prunes, and reads `warmup.log`. |
| `internal/paths` | Resolves every path from the environment. |
| `internal/atomicfile` | Writes a file through a temp file and a rename. |
| `internal/domain` | The shared types: provider IDs, configuration, usage, decisions, and cache entries. `ProviderID.TmuxSession` names the tmux session of each agent. |

## Dependency rules

```
cli, tui
   │
   ▼
warmup, scheduler, detect, selfupdate, legacy
   │
   ▼
provider, config, cache, logs, sysexec
   │
   ▼
paths, atomicfile, domain
```

- A package can import the packages below it. No package imports a package above it. `domain` imports nothing internal.
- Only `cli` and `tui` print to the user. The other packages return values and errors.
- Every function that starts a process or makes a network call takes a `context.Context` first.
- Every cache write goes through `cache.Update`, which holds an exclusive file lock. Thus, a scheduled tick and a manual run cannot overwrite each other.

## The flow of one tick

launchd or cron runs `agent-warmup tick`. The tick handles every enabled provider in its own goroutine.

```
agent-warmup tick
  │
  ├─ config.Load ─────────────── read and validate config.toml
  │
  ├─ for each enabled provider, in parallel:
  │     │
  │     ├─ cache entry ───────── last usage, last warmup, cooldown
  │     │
  │     ├─ Provider.Probe ────── live usage (tmux /usage, Codex session files, opencode stats)
  │     │     └─ on error: Provider.InferFromCache (estimate from the last warmup)
  │     │
  │     ├─ Provider.Decide ───── working hours, weekly stop, cooldown, active window
  │     │
  │     ├─ cache.Update ──────── save the decision and the live usage
  │     ├─ logs.Append ───────── "TICK [<id>] <action> ..."
  │     │
  │     └─ action is warm?
  │           └─ runner: write arm-<id>.sh, run it with /bin/bash (5 minute timeout)
  │                 └─ cache.Update with Provider.RecordArm (last warmup or cooldown)
  │
  ├─ logs.Prune ──────────────── drop log lines older than the retention
  │
  └─ print one line per provider and per failed arm, exit 1 when an arm failed
```

The tick never reinstalls the scheduler. If a launchd job reloads itself, the job stops.

## The timeline of the terminal UI

`warmup.Timeline` projects today for each agent from the configuration, the cache, the recent `warmup.log` entries, and the current time. It does no I/O, so the UI calls it again after each edit.

- The base is the work hours.
- The armed windows come from the `DONE <id> (status=0)` log lines, the last arm in the cache, and a live session's reset time. A window from yesterday evening reaches past midnight.
- The predicted windows come from the same `Provider.Decide` as the tick, run at each coming scheduled tick (`scheduler.Ticks`). The provider rules (working hours, weekly stop, cooldown, active window) thus apply to the projection too.

## Files on disk

See [configuration](configuration.md#files) for the files under `~/.agent-warmup/`. The launchd plist is `~/Library/LaunchAgents/com.d0whc3r.agent-warmup.plist`.
