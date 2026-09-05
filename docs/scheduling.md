# Scheduling

`agent-warmup start` installs a launchd agent (macOS, with cron fallback) or a
crontab entry (Linux) that runs `agent-warmup tick`.

## Modes

**`smart`** checks every 30 minutes inside the union of all enabled providers'
working bands. Each provider independently skips when it is outside its band,
over its weekly threshold, already active, or cooling down after repeated
failures. Claude and OpenCode Go use live data where available; the others use
local successful-arm history.

**`fixed`** runs only at each provider's configured hours. A single launchd or
cron entry contains the union of those hours; the tick only arms providers whose
own schedule matches the current hour.

## Concurrency and failures

Providers are probed and armed concurrently, both by the tick and by `run`. Each
has its own cache entry and decision, so a slow or failing provider never delays
or cancels another; an arm still running after five minutes is killed.

Arm output is prefixed with the agent id, and `run` ends with a per-agent ✓/✗
summary. In `warmup.log` every line carries its agent (`TICK [codex] …`,
`START codex …`, `OK: OpenAI Codex replied …`).

Two failed arms within two hours (two consecutive failing ticks at any cadence)
put cache-based providers into a one-hour cooldown, so an expired login or a
missing binary is not retried on every tick.

## Finding the agent binaries

`agent-warmup detect` looks for each agent's CLI in its default install prefix,
then on `$PATH`, then in the usual prefixes (`~/.local/bin`, `~/.bun/bin`,
`/opt/homebrew/bin`, …). A configured path that still works is never replaced.

`--apply` writes the absolute detected path for every agent whose configured
path is missing. The scheduler runs with a minimal `PATH`, so an absolute path
is required there — a bare command name is not enough.
