# claude-warmup

[![CI](https://github.com/d0whc3r/claude-warmup/actions/workflows/ci.yml/badge.svg)](https://github.com/d0whc3r/claude-warmup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Keeps Claude Code's session "warm" on this Mac: it launches a **real**
interactive session (via `tmux`, not `-p`), sends a trivial prompt, and exits.
That **starts the 5h usage-limit window** at convenient times, so the resets
land inside your working hours.

In the default **smart mode** it first reads Claude Code's own `/usage` (which
costs nothing — running `/usage` sends no message) and only arms a window when
there isn't one already running and your weekly quota allows it. So it never
wastes a request re-arming an active window, and it backs off near the weekly
limit. A legacy **fixed mode** (arm at set hours) is still available.

It ships as a small CLI (`claude-warmup`) with an interactive terminal UI that
manages the mode, schedule, model, and the scheduler (launchd or cron) for you.

## Multi-provider (Claude Code + OpenCode Go)

`claude-warmup` keeps **two independent usage windows warm from a single CLI,
single config, single scheduler entry, single status/TUI, and single set of
logs**. Both providers are enabled by default; you can disable either one with
`claude-warmup provider opencode disable` (or `claude`).

- **Claude Code** — the original. Smart-mode probes Claude's `/usage` and
  arms the 5h session + weekly quota as you would expect.
- **OpenCode Go** ($5 first month / $10/month) — the 5h, weekly and monthly
  caps in USD are tracked server-side; `claude-warmup` reads the weekly %
  from `opencode stats --days 7` and falls back to "did we arm in the last
  5h?" for the session-active check (opencode issue #19190 is in flight
  for a native quota command). The default warmup model is
  `opencode-go/deepseek-v4-flash` — the cheapest on Go (31,650 req/5h,
  ~$0.0004 per warmup) — so the monthly budget is barely touched.

Provider state lives under one `WARMUP_HOME` (default `~/.claude/warmup`),
so logs, the usage cache, and the scheduler entry are shared. The tick
iterates enabled providers in the order you set in `WARMUP_PROVIDERS` and
arms each one independently; a 5h cooldown kicks in if an arm fails twice
in 30 min (only affects Go, since Claude's cap is request-based, not
dollar-based).

CLI:

```
claude-warmup provider list                       # show on/off per provider
claude-warmup provider opencode enable|disable   # toggle
claude-warmup provider opencode model NAME       # override the arming model
claude-warmup provider opencode schedule H ...   # set fixed-mode hours
claude-warmup usage --provider opencode          # probe just one provider
claude-warmup tick --provider claude --dry-run   # tick just one provider
claude-warmup run --provider opencode            # run just one provider
```

In the TUI, press **`p`** to cycle the selected provider (the one whose
settings and usage the panel shows). Configuration in `.env` is per-provider:
`WARMUP_CLAUDE_*` and `WARMUP_OPENCODE_*`; shared knobs (`mode`, `scheduler`,
`tickMinutes`, `selectedProvider`) live at the top level. See
[`.env.example`](.env.example) for the full schema and
[`docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md`](docs/superpowers/specs/2026-06-15-multi-provider-warmup-design.md)
for the design rationale.

Legacy `WARMUP_MODE` / `WARMUP_MODEL` / `WARMUP_SCHEDULE` / `WARMUP_WORK_*` keys
are still read on first load; on the first save the file is rewritten in the
multi-provider schema and a `warmup.env.bak` is dropped next to it for
rollback.

## Requirements

- macOS (scheduler: launchd, with cron as a fallback) or Linux (scheduler: cron)
- [Claude Code](https://claude.com/claude-code) CLI on your `PATH`
- `tmux` (`brew install tmux` on macOS, `apt install tmux` / your package manager on Linux)
- Node.js ≥ 24 and `pnpm` (running from source). Building the standalone binary needs Node ≥ 26.

## Install

### Prebuilt binary (recommended)

Each release attaches a self-contained single-executable (it embeds its own Node
runtime — no Node install needed) for `darwin-arm64`, `darwin-x64`, `linux-x64`
and `linux-arm64`. Download the one for your platform, then:

```bash
chmod +x claude-warmup-*           # make it executable
./claude-warmup-* status           # (macOS: first run may need to clear Gatekeeper quarantine)
```

### From source

```bash
git clone https://github.com/d0whc3r/claude-warmup.git
cd claude-warmup
pnpm install                  # installs deps and builds dist/ (the runnable bundle)
node dist/claude-warmup.mjs   # opens the interactive TUI
```

The interactive TUI is authored in JSX and must be bundled to run under plain Node;
`pnpm install` builds it for you. To run from source without building, use
`pnpm start` (it transpiles on the fly via tsx).

Build the binary yourself (Node ≥ 26): `pnpm run build:sea` → `dist/claude-warmup`.

Optionally link the `claude-warmup` command globally so you can run it from
anywhere:

```bash
pnpm link --global       # then just: claude-warmup
```

The rest of this README uses `claude-warmup` as the command; substitute
`node dist/claude-warmup.mjs` if you didn't link it.

## Usage

Run with no arguments to open the interactive TUI:

```
↑↓ move · ←→ change · space toggle hour · enter select · q quit
```

From there you can pick the scheduler and model, toggle the hours on the
schedule strip, then **Save & apply**, **Run warmup now**, **Stop**, or
**View logs**. The status bar always spells out the keys for whatever row is
focused, and every change is echoed back, so nothing is hidden.

The TUI is accessibility-first: state is conveyed by shape and text (not colour
alone), so it stays usable under `NO_COLOR` and on monochrome terminals. For a
screen reader, run it with `INK_SCREEN_READER=true claude-warmup` — it emits a
clean, linear, labelled reading of the panel instead of the visual layout.

Everything is also scriptable via subcommands:

```
claude-warmup                 Open the interactive TUI
claude-warmup status          Show current status (incl. cached session/weekly usage)
claude-warmup usage           Probe /usage now and print session + weekly limits
claude-warmup tick [--dry-run]  Run one smart decision (probe → decide → maybe warm)
claude-warmup run             Run a warmup right now (foreground)
claude-warmup start           Install + load the active scheduler
claude-warmup stop            Remove both schedulers
claude-warmup restart         Reload the active scheduler
claude-warmup enable          Enable the launchd agent
claude-warmup disable         Disable the launchd agent (kept installed)
claude-warmup mode NAME       Set mode (smart | fixed)
claude-warmup schedule H ...  Set fixed-mode run hours, e.g. "schedule 8 13 18 23"
claude-warmup model NAME      Set model (haiku | sonnet | opus)
claude-warmup scheduler NAME  Choose scheduler (launchd | cron)
claude-warmup logs [-f]       Show recent warmup logs (-f to follow)
claude-warmup help            Show this help
```

The default model is `haiku`. **Smart mode** (default) checks every 30 min from
08:00–23:00; **fixed mode** arms at **08:00, 13:00, 18:00**, each run arming a
fresh 5h window (08→13, 13→18, 18→23).

> Changing `mode`, `schedule`, or the smart settings only re-installs the
> scheduler if it's already active (or after **Save & apply** / `start`). Run
> `claude-warmup restart` after editing the config file by hand.

## Smart mode

Each tick (every `tickMinutes` within the working band) does:

1. **Probe** `/usage` in a throwaway `tmux` session and parse the rendered
   limits — the 5h "Current session" and the "Current week (all models)". This
   sends no message, so it costs nothing and arms no window.
2. **Decide**:
   - outside `workStart`–`workEnd` → **skip** (don't arm windows at night);
   - weekly usage ≥ `weeklyStopPercent` → **skip** (conserve the weekly quota);
   - a 5h window is already active → **skip** (don't waste a request);
   - otherwise → **arm** a fresh window (this is the one real request).
3. **Log** the decision to `warmup.log` and cache the parsed usage to
   `~/.claude/warmup/usage-cache.json` so `status` and the TUI can show it.

Effect: windows chain to your real usage (a new one is armed within one tick of
the previous expiring), requests aren't wasted on already-active windows, and
warmups back off automatically as you approach the weekly limit. If a probe
fails, the tick falls back to "did we arm in the last 5h?" so it still arms at
most once per window.

## How it works

Everything the warmup owns lives under a single home, `~/.claude/warmup/`
(`warmup.env`, `usage-cache.json`, `logs/`, `workdir/`). The CLI persists your
settings to `~/.claude/warmup/warmup.env` and registers
the active scheduler (launchd `LaunchAgent` or a marked `crontab` block). In
**fixed** mode it runs the arm script at the configured hours; in **smart** mode
it runs `claude-warmup tick` every `tickMinutes` across the working band, and the
tick decides whether to invoke it (see [Smart mode](#smart-mode)).

The actual arming is always done by `arm-claude.sh`:

1. Opens `claude --safe-mode --model <model>` inside a detached `tmux` session.
   - `--safe-mode` keeps **normal auth** (your subscription's Keychain/OAuth →
     this is what arms the window) but disables hooks, MCP, CLAUDE.md and
     plugins. Result: fast, cheap startup with no integration prompts.
   - The model defaults to `haiku` (cheapest; enough to arm the window).
2. Accepts the "trust this folder" dialog the first time.
3. Types the prompt (`reply with only the word: ok`) and submits it.
4. Waits for the reply, captures the pane as evidence, and closes the session.

> ⚠️ Each run **consumes a real request** from your quota — that is precisely the
> point: without a request, the window doesn't start.

### Why launchd and not cron?

Your Claude credentials live in the **macOS Keychain** (not in a file). A
`LaunchAgent` runs inside your graphical session (Aqua), where the Keychain is
unlocked, so Claude can read the auth without issues. `cron` jobs on macOS run
in a background context where Keychain access is unreliable (and `cron` also
needs _Full Disk Access_). That's why launchd is the robust choice here.

If you switch to cron and runs fail with an auth/Keychain error, switch back to
launchd with `claude-warmup scheduler launchd`.

## Configuration

Settings managed by the CLI (stored in `~/.claude/warmup/warmup.env`):

| Setting                   | Default       | Values                                                                              |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `mode`                    | `smart`       | `smart` (probe `/usage`, arm only when needed) \| `fixed` (arm at `schedule` hours) |
| `schedule`                | `[8, 13, 18]` | hours of the day, 0–23 (minute 0) — used in `fixed` mode                            |
| `smart.workStart`         | `8`           | earliest hour a tick may arm a window                                               |
| `smart.workEnd`           | `23`          | latest hour (exclusive) a tick may arm a window                                     |
| `smart.tickMinutes`       | `30`          | how often to probe + decide (`5`\|`10`\|`15`\|`20`\|`30`\|`60`)                     |
| `smart.weeklyStopPercent` | `90`          | skip warmups once weekly "all models" usage hits this                               |
| `model`                   | `haiku`       | `haiku` \| `sonnet` \| `opus`                                                       |
| `scheduler`               | `launchd`     | `launchd` \| `cron`                                                                 |

`warmup.env` is a plain `.env`: each setting is a `WARMUP_*` key (`mode` →
`WARMUP_MODE`, `smart.workStart` → `WARMUP_WORK_START`, `schedule` →
`WARMUP_SCHEDULE` as a comma list, …). Edit it directly and run `claude-warmup
restart` to apply. Because the keys match the variables below, you can also
`set -a; source ~/.claude/warmup/warmup.env` to reproduce a run by hand. See
[`.env.example`](.env.example) for a fully-commented template of every key.

The arm script also reads these environment variables (all optional), useful for
manual runs or tuning:

| Variable                    | Default                        | What it does                         |
| --------------------------- | ------------------------------ | ------------------------------------ |
| `WARMUP_MODEL`              | `haiku`                        | Model to use                         |
| `WARMUP_PROMPT`             | `reply with only the word: ok` | Trivial prompt                       |
| `WARMUP_HOME`               | `~/.claude/warmup`             | Root dir for logs + workdir          |
| `WARMUP_WORKDIR`            | `$WARMUP_HOME/workdir`         | Trusted dir the session runs in      |
| `WARMUP_READY_WAIT`         | `10`                           | Sec. to wait for the TUI to start    |
| `WARMUP_RESPONSE_WAIT`      | `25`                           | Sec. to wait for the reply           |
| `WARMUP_LOG_DIR`            | `$WARMUP_HOME/logs`            | Log directory                        |
| `WARMUP_LOG_RETENTION_DAYS` | `14`                           | Delete logs/captures older than this |
| `WARMUP_TMUX_SESSION`       | `claude-warmup`                | tmux session name                    |
| `CLAUDE_BIN`                | `~/.local/bin/claude`          | Path to the `claude` binary          |
| `TMUX_BIN`                  | first `tmux` found on `PATH`   | Path to the `tmux` binary            |

## Logs

- Logs live in `~/.claude/warmup/logs/`: `warmup.log` (one `START`/`OK`/`DONE`
  line per arming run plus one `TICK …` line per smart decision) and a
  `pane-*.txt` snapshot per run. launchd also writes `launchd.out.log` /
  `launchd.err.log`; cron writes `cron.log`.
- **Retention is by age**: every smart tick trims the rolling logs to the last
  `WARMUP_LOG_RETENTION_DAYS` (default 14) by line timestamp and deletes older
  `pane-*.txt` captures. The log dir stays bounded without manual cleanup.
- The last parsed usage snapshot is cached at `~/.claude/warmup/usage-cache.json`.
- Follow them with `claude-warmup logs -f`.

## Run by hand

```bash
claude-warmup run                       # run once in the foreground
tail -f ~/.claude/warmup/logs/warmup.log
```

## License

[MIT](LICENSE) © d0whc3r
