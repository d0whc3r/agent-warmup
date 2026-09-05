# agent-warmup

[![CI](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml/badge.svg)](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/d0whc3r/agent-warmup)](https://github.com/d0whc3r/agent-warmup/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Prime the usage windows of several AI coding subscriptions before you work. A
warmup is one deliberately tiny model request. For anchored five-hour windows
this aligns the next reset with a useful time; for rolling windows it is only a
scheduled readiness pulse and does not move the reset boundary.

The canonical CLI is `agent-warmup`. The old `claude-warmup` command remains an
alias, and existing installs under `~/.claude/warmup` are detected automatically.

## Supported providers

| ID         | Service              | Runner                               | Usage strategy                        | Default model                      |
| ---------- | -------------------- | ------------------------------------ | ------------------------------------- | ---------------------------------- |
| `claude`   | Claude Code          | interactive Claude session in `tmux` | live `/usage`                         | `haiku`                            |
| `codex`    | OpenAI Codex         | `codex exec`, ephemeral/read-only    | rate limits from local session logs   | `gpt-5.6-luna`                     |
| `zai`      | Z.AI GLM Coding Plan | authenticated OpenCode provider      | local five-hour estimate              | `zai-coding-plan/glm-5.3-flash`    |
| `kimi`     | Kimi Code            | `kimi -p`                            | rolling-window pulse + local estimate | `kimi-code/kimi-for-coding`        |
| `opencode` | OpenCode Go          | `opencode run` + `opencode stats`    | live weekly + local session estimate  | `opencode-go/deepseek-v4-flash`    |
| `minimax`  | MiniMax Token Plan   | authenticated OpenCode provider      | local five-hour estimate              | `minimax-coding-plan/MiniMax-M2.7` |

Claude is enabled by default. Every other provider is opt-in because a warmup
consumes real quota. Z.AI, Kimi, and MiniMax currently expose no stable
machine-readable quota endpoint suitable for unattended polling, so the CLI
conservatively treats a successful warmup within the last five hours as an
active window (shown as `active (estimated)` in status and the TUI). Codex
reads the five-hour and weekly percentages its own sessions log under
`~/.codex/sessions`; warmups are ephemeral and do not refresh that log, so the
figures are as of your last interactive Codex session.

MiniMax is included because its Token Plan also has a five-hour allowance. Kimi
is included as requested, but its official documentation calls the five-hour
limit rolling: use it as an availability pulse, not as a way to shift a reset.
Copilot, Gemini and Qwen are intentionally excluded because their relevant
limits are fixed monthly/daily/weekly or genuinely sliding and no pulse was
requested for them.

## Requirements

- macOS (launchd, with cron fallback) or Linux (cron)
- Node.js 24+ and pnpm when running from source
- The CLI for every provider you enable, already authenticated
- `tmux` for Claude Code probing/arming; the other runners are non-interactive

For Z.AI and MiniMax, connect the corresponding Coding Plan inside OpenCode
first (`opencode auth login`). Credentials stay in each vendor CLI's own auth
store; `agent-warmup` never persists API keys.

## Install

```bash
curl -fsSL https://github.com/d0whc3r/agent-warmup/releases/latest/download/install.sh | bash
```

The script detects macOS/Linux and x64/arm64, downloads the matching binary from
the [latest GitHub Release](https://github.com/d0whc3r/agent-warmup/releases/latest),
and installs it as `~/.local/bin/agent-warmup` (with a `claude-warmup` alias).
If that URL 404s (no tag has attached `install.sh` yet), use the copy on `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/d0whc3r/agent-warmup/main/install.sh | bash
```

Override the destination with `INSTALL_DIR`, or pin a tag with `VERSION`:

```bash
INSTALL_DIR=/usr/local/bin VERSION=v1.2.3 \
  curl -fsSL https://github.com/d0whc3r/agent-warmup/releases/latest/download/install.sh | bash
```

| Platform            | Asset                       |
| ------------------- | --------------------------- |
| Linux x64           | `agent-warmup-linux-x64`    |
| Linux arm64         | `agent-warmup-linux-arm64`  |
| macOS Intel         | `agent-warmup-darwin-x64`   |
| macOS Apple Silicon | `agent-warmup-darwin-arm64` |

macOS binaries are ad-hoc signed. The installer clears the Gatekeeper quarantine
attribute; if the first launch is still blocked, use System Settings → Privacy &
Security → Open Anyway.

### From source

```bash
git clone https://github.com/d0whc3r/agent-warmup.git
cd agent-warmup
pnpm install
pnpm link --global
agent-warmup status
```

Build with `pnpm build`. A standalone binary can be built on Node 26+ with
`pnpm build:sea`; it is written to `dist/agent-warmup`.

## Quick start

```bash
# See which agent CLIs are installed on this machine.
agent-warmup detect

# Adopt the detected paths for any agent whose configured path does not work.
agent-warmup detect --apply

# See every built-in adapter. Only Claude starts enabled.
agent-warmup provider list

# Enable the subscriptions you use.
agent-warmup provider codex enable
agent-warmup provider zai enable
agent-warmup provider kimi enable

# Select which provider the unqualified model/schedule commands edit.
agent-warmup provider codex select
agent-warmup model gpt-5.6-luna

# Verify one warmup manually, then install the scheduler.
agent-warmup run --provider codex   # one agent; without --provider, all enabled
agent-warmup start
```

## The terminal UI

Running `agent-warmup` with no arguments opens the Ink terminal UI. It has three
tabs — `tab` / `shift+tab` cycle them, `1`, `2` and `3` jump straight to one:

| Tab          | What it holds                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| **Overview** | Scheduler state, next run, the active window, the last tick, one usage line per agent, and the actions |
| **Agents**   | The agent picker plus the selected agent's model, binary path and tmux session, with its usage         |
| **Schedule** | Mode, scheduler, and either the smart-mode band or the fixed-mode hour grid                            |

Every agent keeps its own model, binary path and tmux session. On the Agents tab
the settings card below the list is bound to the agent under the cursor — its id
is in the card title (`SETTINGS · codex`) — so configuring an agent never
requires enabling or selecting it first:

- `↑/↓` walk the agent list (focus only leaves the list at either end).
- `space` enables or disables the agent under the cursor.
- `enter` jumps into that agent's settings; `↑` returns to the list.
- `←/→` cycle the model, `enter` edits the binary path or session name by hand.
- `d` autodetects the binary of the agent on screen.

The `Binary` row shows the configured path with a `✓`/`✗` marker for whether it
actually works. `Run warmup (all enabled)` (`r`) warms every enabled agent, the
same set `Save & apply` schedules. The `*` in the list marks the default agent
for CLI commands run without `--provider`; `p` cycles it.

The action keys work from every tab: `s` save & apply, `r` run a warmup now,
`t` stop the schedulers, `l` view logs, `m` toggle smart/fixed, `p` cycle the
enabled agents, `?` the full key map, `q` quit.

## Commands

```text
agent-warmup                         Open the interactive TUI
agent-warmup status                  Show scheduler and provider status
agent-warmup usage [--provider ID]   Probe usage or show the local estimate
agent-warmup tick [--dry-run] [--provider ID]
agent-warmup run [--provider ID]     Warm every enabled agent now (or just one)
agent-warmup start|stop|restart      Manage launchd/cron
agent-warmup mode smart|fixed
agent-warmup scheduler launchd|cron
agent-warmup detect [--apply]        Find installed agent CLIs
agent-warmup provider list
agent-warmup provider ID enable|disable|select
agent-warmup provider ID detect      Detect and save this agent's binary path
agent-warmup provider ID model NAME
agent-warmup provider ID binary PATH
agent-warmup provider ID schedule H ...
agent-warmup logs [-f]
```

## Finding the agent binaries

`agent-warmup detect` looks for each agent's CLI in its default install prefix,
then on `$PATH`, then in the usual prefixes (`~/.local/bin`, `~/.bun/bin`,
`/opt/homebrew/bin`, …). A configured path that still works is never replaced.
`--apply` writes the absolute detected path for every agent whose configured
path is missing, which is what the launchd/cron tick needs: the scheduler runs
with a minimal `PATH`, so a bare command name is not enough.

## Scheduling modes

`smart` mode checks every 30 minutes inside the union of all enabled providers'
working bands. Each provider independently skips when it is outside its band,
over its weekly threshold, already active, or cooling down after repeated
failures. Claude and OpenCode Go use live data where available; the other
providers use local successful-arm history.

`fixed` mode runs only at each provider's configured hours. A single launchd or
cron entry contains the union of those hours; the tick only arms providers whose
own schedule matches the current hour.

Two failed arms within 30 minutes put cache-based providers into a one-hour
cooldown. This prevents an expired login or missing binary from being retried on
every scheduler tick.

## Configuration and files

New installs use `~/.agent-warmup/` for `warmup.env`, the usage cache, logs and
the sterile warmup workdir. If the legacy `~/.claude/warmup/` exists and the new
home does not, it continues to be used. Set `WARMUP_HOME` to override either.

Configuration is a plain `.env` file:

```dotenv
WARMUP_MODE=smart
WARMUP_SCHEDULER=launchd
WARMUP_TICK_MINUTES=30
WARMUP_PROVIDERS=claude,codex,kimi
WARMUP_SELECTED_PROVIDER=codex

WARMUP_CODEX_ENABLED=true
WARMUP_CODEX_BIN=~/.local/bin/codex
WARMUP_CODEX_MODEL=gpt-5.6-luna
WARMUP_CODEX_WORK_START=8
WARMUP_CODEX_WORK_END=23
WARMUP_CODEX_WEEKLY_STOP_PERCENT=85
WARMUP_CODEX_SCHEDULE=8,13,18
```

See [`.env.example`](.env.example) for all provider stanzas. Legacy flat
`WARMUP_MODEL`, `WARMUP_SCHEDULE` and smart-mode keys migrate to the Claude
provider on first save, with a `.bak` copy kept beside the old config.

## Safety and quota semantics

A warmup is a real billable/subscription request, including pulse-only adapters.
Enable only plans whose reset timing you intentionally want to align. Provider
limits and model catalogs change over time, so model IDs and binary paths remain
configurable instead of being baked into the scheduler.

The warmup workdir contains no project code. Codex runs ephemeral and read-only;
Kimi loads an empty skills directory; Claude starts in safe mode. Logs and output
captures are retained for 14 days by default.

## Releasing

Push a version tag. GitHub Actions builds the four SEA binaries, attaches
them to the GitHub Release for that tag, and uploads `install.sh` so the
curl installer can fetch that release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Tags with a hyphen (`v1.2.3-rc.1`) are published as GitHub prereleases.
`workflow_dispatch` on `.github/workflows/release.yml` smoke-tests the same
matrix without publishing.

## License

[MIT](LICENSE) © d0whc3r
