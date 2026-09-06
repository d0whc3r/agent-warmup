# Configuration

Everything lives under `~/.agent-warmup/`: `warmup.env`, the usage cache, logs
and the sterile warmup workdir — a neutral home, nothing under any one agent's
dot-dir. Set `WARMUP_HOME` to override.

A legacy `~/.claude/warmup/` install is moved there the first time the CLI runs,
and an installed scheduler entry still logging to the old path is re-applied the
next time you open the TUI or run `status`.

## warmup.env

The installer (and any first CLI run) seeds `~/.agent-warmup/warmup.env` from the
built-in defaults: every provider gets a stanza, only Claude is enabled, and the
scheduler is the one your platform supports. An existing file is never touched, so
re-running the installer keeps your edits.

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

See [`.env.example`](../.env.example) for all provider stanzas — it mirrors the
seeded file key for key (a test enforces that).

Legacy flat `WARMUP_MODEL`, `WARMUP_SCHEDULE` and smart-mode keys migrate to the
Claude provider on first save, with a `.bak` copy kept beside the old config.
