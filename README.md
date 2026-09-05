# agent-warmup

[![CI](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml/badge.svg)](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/d0whc3r/agent-warmup)](https://github.com/d0whc3r/agent-warmup/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Keep the usage windows of your AI coding subscriptions primed before you start
working. A _warmup_ is one deliberately tiny model request: on plans with an
anchored five-hour window it aligns the next reset with a useful time; on
rolling-window plans it is just a scheduled readiness pulse.

Works with Claude Code, OpenAI Codex, Z.AI, Kimi, OpenCode Go and MiniMax —
see [supported providers](docs/providers.md).

## Install

```bash
curl -fsSL https://github.com/d0whc3r/agent-warmup/releases/latest/download/install.sh | bash
```

Installs `~/.local/bin/agent-warmup` for macOS/Linux, x64 or arm64. Override the
destination with `INSTALL_DIR`, or pin a version with `VERSION=v1.2.3`. If that
URL 404s because no release has attached `install.sh` yet, use the copy on
`main`: `https://raw.githubusercontent.com/d0whc3r/agent-warmup/main/install.sh`.

macOS binaries are ad-hoc signed; if the first launch is blocked, allow it in
System Settings → Privacy & Security → Open Anyway.

Requirements: macOS or Linux, the CLI of every provider you enable already
authenticated, and `tmux` for Claude Code.

## Quick start

```bash
# 1. See which agent CLIs are installed, and adopt the paths that work.
agent-warmup detect --apply

# 2. Enable the subscriptions you use (only Claude starts enabled).
agent-warmup provider codex enable

# 3. Try one warmup by hand.
agent-warmup run

# 4. Install the scheduler.
agent-warmup start
```

Every warmup spends real quota, so enable only the plans whose reset timing you
actually want to control.

## The terminal UI

Run `agent-warmup` with no arguments. Three tabs — `tab` / `shift+tab` cycle
them, `1`/`2`/`3` jump straight to one:

| Tab          | What it holds                                                        |
| ------------ | -------------------------------------------------------------------- |
| **Overview** | Scheduler state, next run, last tick, one usage line per agent       |
| **Agents**   | Enable agents and set each one's model, binary path and tmux session |
| **Schedule** | Smart/fixed mode, scheduler backend and the default agent's hours    |

On the **Agents** tab, `↑/↓` walk the list, `space` enables the agent under the
cursor, `enter` opens its settings, `←/→` cycle the model and `d` autodetects
its binary. The `*` marks the default agent — the one CLI commands use without
`--provider` — and `p` cycles it.

Action keys work from any tab: `s` save & apply, `r` run a warmup now, `t` stop
the schedulers, `l` logs, `m` toggle smart/fixed, `?` full key map, `q` quit.
Changes are saved immediately, but the scheduler is only updated when you
press `s`.

## Commands

```text
agent-warmup                         Open the interactive TUI
agent-warmup status                  Show scheduler and provider status
agent-warmup usage [--provider ID]   Probe usage or show the local estimate
agent-warmup run [--provider ID]     Warm every enabled agent now (or just one)
agent-warmup start|stop|restart      Manage the scheduler
agent-warmup logs [-f]               Tail the warmup log
agent-warmup detect [--apply]        Find installed agent CLIs
agent-warmup mode smart|fixed
agent-warmup scheduler launchd|cron
agent-warmup provider list
agent-warmup provider ID enable|disable|select
agent-warmup provider ID model NAME
agent-warmup provider ID binary PATH
agent-warmup provider ID schedule H ...
agent-warmup tick [--dry-run] [--provider ID]
```

## Docs

- [Supported providers](docs/providers.md) — what each adapter runs and how its quota is read
- [Scheduling](docs/scheduling.md) — smart vs fixed mode, cooldowns, binary detection
- [Configuration](docs/configuration.md) — files under `~/.agent-warmup/` and every setting
- [Development](docs/development.md) — build from source, tests, releases

## License

[MIT](LICENSE) © d0whc3r
