# Scheduling

`agent-warmup start` installs one scheduled job that runs `agent-warmup tick`. Each tick decides, for each enabled agent, whether to send a warmup now.

Run `agent-warmup restart` after you change `config.toml` by hand. The CLI commands reapply the scheduler for you when it is active. The terminal UI shows `◇ unapplied` after a schedule change until you press `a`.

## Contents

- [When a tick warms](#when-a-tick-warms)
- [Scheduler backends](#scheduler-backends)
- [Concurrency and failures](#concurrency-and-failures)
- [Finding the agent binaries](#finding-the-agent-binaries)

## When a tick warms

The job runs a tick every 15 minutes inside the working hours of all enabled agents together. In each tick, an agent skips the warmup when one of these is true:

1. The current hour is outside its own `work_start` to `work_end`.
2. Its weekly usage is at or above `weekly_stop_percent`.
3. It is in a cooldown after repeated failures.
4. Its window is already active.

Otherwise it sends a warmup. Thus, inside the working hours, a new window starts as soon as no window is active. Claude, Codex, and OpenCode Go use live usage data. The other agents use the time of the last successful warmup.

The 15-minute tick is fixed. It is short enough that a new window starts at most 15 minutes after the last one ends.

## Scheduler backends

The backend depends on the operating system. You cannot choose it.

- macOS uses launchd: agent-warmup writes `~/Library/LaunchAgents/com.d0whc3r.agent-warmup.plist` with one calendar entry for each tick time, and loads it with `launchctl`. See [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html).
- Linux uses cron: agent-warmup adds one block, marked with `# >>> agent-warmup >>>` and `# <<< agent-warmup <<<`, to your crontab. See [crontab(5)](https://man7.org/linux/man-pages/man5/crontab.5.html). agent-warmup changes only the lines inside its block.

On macOS, `start` also removes an agent-warmup cron block, if one exists. `agent-warmup stop` removes both. Both also remove an entry left by an older TypeScript install (`com.d0whc3r.claude-warmup` and the `claude-warmup` cron block).

The scheduled job starts with a minimal `PATH`. For this reason, `config.toml` must hold absolute binary paths, and the warmup scripts add the usual install directories to `PATH`.

## Concurrency and failures

The tick and `run` check and warm all providers at the same time. Each provider has its own cache entry, decision, and log tag, so a slow or failing provider does not delay another one. If a warmup still runs after five minutes, agent-warmup stops it and reports status 124.

Each line in `warmup.log` names its provider, for example `TICK [codex] ...` and `START codex ...`. `run` ends with one `✓` or `✗` line for each provider.

Two failed warmups within two hours put a provider, other than Claude, into a one-hour cooldown. Thus, agent-warmup does not retry an expired login or a missing binary on every tick. The two-hour window is longer than the slowest tick, so two failed ticks in a row always start the cooldown.

## Finding the agent binaries

`agent-warmup detect` looks for each agent CLI in this order:

1. The path in `config.toml`, when it is an executable file.
2. The directory of the default path.
3. Each directory on `PATH`.
4. The usual install directories: `~/.local/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, and `/usr/bin`. For Claude, `~/.claude/local` comes first.

`agent-warmup detect --apply` saves the found absolute path for each provider whose configured path does not work. It never replaces a configured path that works. In the terminal UI, the `d` key does the same for one agent.
