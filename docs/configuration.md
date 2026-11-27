# Configuration

agent-warmup keeps its configuration in one [TOML](https://toml.io) file, `~/.agent-warmup/config.toml`. Edit it with the terminal UI, the CLI commands, or a text editor. After a hand edit, run `agent-warmup restart` so the scheduler uses the new values.

The first command you run creates the file with the defaults. When an old `warmup.env` exists, the first command converts it instead.

## Contents

- [Files](#files)
- [config.toml](#configtoml)
- [Validation](#validation)
- [Environment overrides](#environment-overrides)
- [Migration from warmup.env](#migration-from-warmupenv)

## Files

Everything lives in `~/.agent-warmup/`. Set `WARMUP_HOME` to use another directory.

| Path | What it holds |
| --- | --- |
| `config.toml` | Your configuration. |
| `usage-cache.json` | The last usage reading, decision, and warmup time of each provider. When the file does not parse, agent-warmup renames it to `usage-cache.json.bad`, logs a warning that names the file, and starts with an empty cache. |
| `logs/warmup.log` | One line for each tick decision and each warmup result. |
| `logs/cron.log`, `logs/launchd.*.log` | Output of the scheduled job. |
| `arm-<id>.sh` | The warmup script of each provider. The binary writes it before each run. |
| `workdir/` | An empty directory that the agent CLIs start in. It holds no project code. |
| `tick.lock` | A lock that a tick holds while it runs. A tick that starts while another one runs logs one line and stops. |

After each tick, agent-warmup removes the log lines that are older than 14 days.

## config.toml

The file has one `[providers.<id>]` table for each agent and no top-level keys. A key or table that you leave out keeps its default.

```toml
[providers.claude]
enabled = true
binary = '~/.local/bin/claude'
model = 'haiku'
work_start = 8
work_end = 23
weekly_stop_percent = 90

[providers.codex]
enabled = false
binary = '~/.local/bin/codex'
model = 'gpt-5.6-luna'
work_start = 8
work_end = 23
weekly_stop_percent = 85
```

### Provider keys

| Key | Meaning |
| --- | --- |
| `enabled` | `true` to warm this agent. The scheduler and `run` use only enabled agents. Every agent can be off: the tick then does nothing. |
| `binary` | Path to the agent CLI. agent-warmup expands `~/`. Use an absolute path, because the scheduler runs with a minimal `PATH`. `agent-warmup detect --apply` writes it for you. |
| `model` | The model for the warmup request. Claude accepts `haiku`, `sonnet`, or `opus`. |
| `work_start` | First working hour, 0 to 23. agent-warmup warms only inside the working hours. |
| `work_end` | End of the working hours, `work_start + 1` to 24. The range does not include this hour. |
| `weekly_stop_percent` | 1 to 100. agent-warmup stops warming when the weekly usage reaches this value. |

These values are fixed and have no key:

- The tick runs every 15 minutes inside the working hours. See [scheduling](scheduling.md).
- The scheduler is launchd on macOS and cron on Linux.
- The tmux session of an agent is `agent-warmup-<id>`, and its usage probe uses `agent-warmup-<id>-usage`.

### Provider defaults

Every provider uses `work_start = 8` and `work_end = 23`. Only Claude starts enabled.

| ID | `binary` | `model` | `weekly_stop_percent` |
| --- | --- | --- | --- |
| `claude` | `~/.local/bin/claude` | `haiku` | 90 |
| `codex` | `~/.local/bin/codex` | `gpt-5.6-luna` | 85 |
| `zai` | `~/.opencode/bin/opencode` | `zai-coding-plan/glm-5.3-flash` | 85 |
| `kimi` | `~/.kimi-code/bin/kimi` | `kimi-code/kimi-for-coding` | 85 |
| `opencode` | `~/.opencode/bin/opencode` | `opencode-go/deepseek-v4-flash` | 85 |
| `minimax` | `~/.opencode/bin/opencode` | `minimax-coding-plan/MiniMax-M2.7` | 85 |
| `agy` | `~/.local/bin/agy` | `gemini-4-hydrogen` | 85 |

## Validation

Every command reads and validates `config.toml`. An unknown key is an error that shows the key and its line, so a typo does not go unnoticed. A value out of range is an error that names the key, for example `providers.codex.work_start: 25 is out of range 0-23`.

The CLI and the UI refuse to save a configuration that is not valid.

## Environment overrides

These variables change paths and timings for one run. agent-warmup does not save them to `config.toml`.

| Variable | Effect | Default |
| --- | --- | --- |
| `WARMUP_HOME` | The data directory. `start` passes it to the scheduled tick. | `~/.agent-warmup` |
| `WARMUP_WORKDIR` | The directory that the agent CLIs start in. `uninstall` deletes it only when it is inside `WARMUP_HOME`. | `$WARMUP_HOME/workdir` |
| `WARMUP_LOG_RETENTION_DAYS` | Days of log lines to keep. | `14` |
| `WARMUP_PROMPT` | The warmup prompt that the arm scripts send. | `reply with only the word: ok` |
| `WARMUP_READY_WAIT` | Seconds to wait for the Claude session to start. | `12` for the usage probe, `10` for a warmup |
| `WARMUP_RESPONSE_WAIT` | Seconds to wait for the Claude reply. | `6` for the usage probe, `25` for a warmup |
| `WARMUP_<ID>_SCRIPT` | Run this script instead of the built-in warmup script for provider `<ID>`, for example `WARMUP_CODEX_SCRIPT`. | none |
| `TMUX_BIN` | The tmux binary. | first tmux in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, or `/bin` |
| `CODEX_HOME` | The Codex data directory, where Codex writes its rate limits. | `~/.codex` |
| `XDG_DATA_HOME` | The base of the OpenCode credential file `opencode/auth.json`. | `~/.local/share` |

The scheduled job does not see variables from your shell profile. To apply an override to scheduled runs, set it in the launchd plist or the crontab line yourself.

## Migration from warmup.env

Older versions stored the configuration in `~/.agent-warmup/warmup.env`. When `config.toml` does not exist and `warmup.env` does, the first command:

1. Converts the `WARMUP_*` keys of the remaining settings to `config.toml`. It reads the multi-provider keys (`WARMUP_PROVIDERS`, `WARMUP_<ID>_MODEL`, ...) and the older single-provider keys (`WARMUP_MODEL`, `WARMUP_WORK_START`, ...). The older keys go to Claude.
2. Drops the keys of settings that no longer exist, and logs one line for each dropped key. The migration does not fail because of them. The dropped keys are `WARMUP_MODE`, `WARMUP_SCHEDULER`, `WARMUP_TICK_MINUTES`, `WARMUP_SELECTED_PROVIDER`, `WARMUP_SCHEDULE`, `WARMUP_TMUX_SESSION`, `WARMUP_<ID>_SCHEDULE`, and `WARMUP_<ID>_TMUX_SESSION`.
3. Renames `warmup.env` to `warmup.env.bak`.
4. Renames `usage-cache.json` to `usage-cache.json.bak`, because the cache format changed. The first tick after the upgrade has no warmup history.

When a value of a remaining setting is not valid, the migration stops with an error that names the key. It writes nothing and keeps `warmup.env`. Fix the value and run the command again.

The old tmux sessions are the defaults `<id>-warmup` and each session that `warmup.env` (or `warmup.env.bak`) set. `agent-warmup clean-legacy`, which `install.sh` runs, kills them when it removes the old launchd job or cron block.

The migration does not read the old home `~/.claude/warmup`. Copy its `warmup.env` to `~/.agent-warmup/` if you still use it.
