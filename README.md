# agent-warmup

[![CI](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml/badge.svg)](https://github.com/d0whc3r/agent-warmup/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/d0whc3r/agent-warmup)](https://github.com/d0whc3r/agent-warmup/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

agent-warmup starts the usage window of your AI coding subscriptions before you start to work. A warmup is one very small model request. On a plan with a fixed five-hour window, it moves the next reset to a useful time. On a plan with a rolling window, it is a scheduled availability check.

It supports Claude Code, OpenAI Codex, Z.AI, Kimi, OpenCode Go, MiniMax, and Antigravity CLI (`agy`). See [supported providers](docs/providers.md).

Every warmup uses real quota. Enable only the plans whose reset time you want to control.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The terminal UI](#the-terminal-ui)
- [Options](#options)
- [Commands](#commands)
- [Upgrade and uninstall](#upgrade-and-uninstall)
- [Docs](#docs)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/d0whc3r/agent-warmup/main/install.sh | bash
```

The script installs one static binary at `~/.local/bin/agent-warmup` for macOS or Linux on amd64 or arm64. It makes sure that the sha256 checksum of the download is correct.

- Set `INSTALL_DIR` to install somewhere else.
- Set `VERSION=v1.2.3` to install a specific release. The default is the latest release.

The script also removes what an older TypeScript install left behind: the old launchd job, the old cron block, and their tmux sessions. When an old global install of `agent-warmup` comes earlier on your `PATH`, the script prints the command that removes it.

Requirements:

- macOS or Linux.
- The CLI of each provider you enable, installed and logged in.
- `tmux` for Claude Code.

If macOS blocks the first launch, allow it in System Settings > Privacy & Security > Open Anyway.

Each release carries a signed build provenance attestation for the binaries and `checksums.txt`. To check that a binary comes from this repository's release workflow, run [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify):

```bash
gh attestation verify ~/.local/bin/agent-warmup --repo d0whc3r/agent-warmup
```

## Quick start

```bash
# 1. Find the installed agent CLIs and save the paths that work.
agent-warmup detect --apply

# 2. Enable the subscriptions you use. Only Claude starts enabled.
agent-warmup provider codex enable

# 3. Run one warmup by hand.
agent-warmup run

# 4. Install the scheduler.
agent-warmup start
```

## The terminal UI

Run `agent-warmup` with no arguments to open the terminal UI. It is one screen with a 24-hour lane for each agent:

```
 agent-warmup ● active · next tick 13:45

           00      04      08      12      16      20       Fri Nov 27
                                     ▽▼                     ▼ 13:42  ▽ 13:00
▸ claude   ················░░░░░██████◆███▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ 42% · resets 15:30
  codex    ················░░░░░░█████◆████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ active (estimated) …
  zai      ················································ off
           █ armed  ▒ predicted  ░ work hours  · off  ◆ next tick

 space  on/off   m  model   [   ]  work start/end   w  weekly stop   enter  edit
 ←   →  hour   r  run now   a  apply   v  log   /  command   ?  keys   q  quit
```

- Each lane shows the work hours, the usage windows that are armed now, the windows that the coming ticks will arm, and the next tick. The text on the right is the session usage.
- `▼` marks the current time. `▽` marks the hour cursor, which the `[` and `]` keys use.
- Below the lanes, the detail area shows the selected agent: its model, work hours, weekly stop, binary, usage, next tick, and its newest log lines.
- The edit panel (`enter`) changes the selected agent. Under each field, one line tells why the field exists. On a terminal 120 columns wide or more, the panel opens on the right of the lanes, so you see each change on the lanes at once.
- The command line (`/`) runs the same actions as the keys, for example `hours claude 8-18` or `model codex gpt-5.6-sol`. `tab` completes the command, the agent, and the value. `?` lists every command.

The UI saves each change to the configuration file at once. An edit that is not valid shows the error and does not change the file. A change to the schedule shows `◇ unapplied` until you press `a`.

### Key bar

The two lines at the bottom are the key bar. Each key shows in a box, followed by what it does. The key bar changes with what is open: the lanes, the edit panel, the command line, a typed value, the log, or the help. `?` shows every key.

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Select the previous or next agent |
| `←`/`→` or `h`/`l` | Move the hour cursor |
| `space` | Turn the agent on or off |
| `m` | Use the next suggested model |
| `[` / `]` | Start the work hours at the cursor / end them after the cursor |
| `w` | Type the weekly stop percent |
| `enter` | Open the edit panel |
| `d` | Detect the agent's binary |
| `r` | Run a warmup of every enabled agent now |
| `a` | Apply the schedule (install the scheduler) |
| `x` | Stop the scheduler |
| `v` | View warmup.log |
| `u` | Refresh the status |
| `/` | Open the command line |
| `?` | Show all keys and commands |
| `esc` | Close the panel, the help, the log, or the command line |
| `q`, `ctrl+c` | Quit |

In the edit panel, `↑`/`↓` select a field, `←`/`→` change it, and `enter` types a new value.

### Mouse

The mouse does the same things as the keys. Every action still has a key.

- Click a lane to select it.
- Click a lane's hour strip to move the hour cursor to that hour.
- Drag across the hour strip to set the work hours: they start at the hour where you press and end after the hour where you release.
- Use the wheel to move through the lanes, or to scroll the log.
- Click a key in the key bar to press it.
- Click a field of the edit panel to select it.

You can turn every agent off. The scheduled tick then does nothing.

The UI fits an 80x24 terminal and does not use color alone to show state: each state has a symbol, and the legend explains them. It respects `NO_COLOR`. Without a terminal, `agent-warmup` prints the status instead.

## Options

Each agent has these options in `config.toml`. Nothing else is configurable. See [configuration](docs/configuration.md) for the file format.

| Option | Why it exists |
| --- | --- |
| `enabled` | Each warmup spends real quota, so only the agents that are on get warmups. |
| `model` | Each warmup spends quota of this model, so pick the cheapest model that starts the window. |
| `work_start`, `work_end` | The window is ready when your workday starts: agent-warmup warms only inside these hours. |
| `weekly_stop_percent` | It skips warmups when the weekly use is above this value, to save quota for your own work. |
| `binary` | agent-warmup finds the agent CLI automatically. Set it only if detection fails. |

## Commands

```text
agent-warmup                                 Open the terminal UI
agent-warmup status [AGENT]                  Show the scheduler and every enabled agent, or one agent
agent-warmup usage [AGENT]                   Read the usage of every enabled agent now, or one agent
agent-warmup run [AGENT]                     Warm every enabled agent now, or one agent
agent-warmup start | stop | restart          Install, remove, or reload the scheduler
agent-warmup logs [-f]                       Show the warmup log
agent-warmup detect [--apply]                Find the installed agent CLIs
agent-warmup provider [list]                 List the agents
agent-warmup provider AGENT enable|disable   Turn an agent on or off
agent-warmup provider AGENT model NAME       Set an agent's model
agent-warmup provider AGENT binary PATH      Set an agent's binary path
agent-warmup upgrade                         Replace the binary with the latest release
agent-warmup uninstall                       Remove the scheduler, tmux sessions, arm scripts, workdir, and cache
agent-warmup version                         Print the version, commit, and build date
agent-warmup completion bash|zsh|fish|powershell  Print a shell completion script
```

`AGENT` is an agent ID, for example `claude` or `codex`. Without it, `status`, `usage`, `run`, and the scheduler's hidden `tick` command act on every enabled agent. To change the work hours or the weekly stop, use the terminal UI or edit `config.toml`.

The global flag `-v` (`--verbose`) logs debug details to stderr. Exit status 0 means success, 1 an error, and 2 a bad command line. When an arm script fails, `run` and the scheduler's hidden `tick` command print the agent and the script's status, for example `✗ kimi failed (status 7)`. Then they exit with 1.

Run `agent-warmup --help` to see the paths of the configuration file, the cache, the logs, and the launchd plist.

## Upgrade and uninstall

`agent-warmup upgrade` downloads the latest GitHub release, makes sure that its checksum is correct, and replaces the binary in place. `agent-warmup version` prints the version you have.

`agent-warmup uninstall` removes the scheduler entries, the tmux sessions, the arm scripts, the workdir when it is inside `WARMUP_HOME`, and the usage cache. It keeps `config.toml` and the logs. Delete the binary yourself if you no longer want it.

## Docs

- [Configuration](docs/configuration.md): `config.toml`, every setting, environment overrides, and the migration from `warmup.env`.
- [Scheduling](docs/scheduling.md): when a tick warms, the 15-minute tick, launchd and cron, cooldowns, and binary detection.
- [Supported providers](docs/providers.md): what each provider runs and how it reads usage.
- [Architecture](docs/architecture.md): the package map and the flow of one tick.
- [Development](docs/development.md): build from source, tests, lint, and releases.

## License

[MIT](LICENSE) © d0whc3r
