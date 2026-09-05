# Supported providers

| ID         | Service              | Runner                               | Usage strategy                        | Default model                      |
| ---------- | -------------------- | ------------------------------------ | ------------------------------------- | ---------------------------------- |
| `claude`   | Claude Code          | interactive Claude session in `tmux` | live `/usage`                         | `haiku`                            |
| `codex`    | OpenAI Codex         | `codex exec`, ephemeral/read-only    | rate limits from local session logs   | `gpt-5.6-luna`                     |
| `zai`      | Z.AI GLM Coding Plan | authenticated OpenCode provider      | local five-hour estimate              | `zai-coding-plan/glm-5.3-flash`    |
| `kimi`     | Kimi Code            | `kimi -p`                            | rolling-window pulse + local estimate | `kimi-code/kimi-for-coding`        |
| `opencode` | OpenCode Go          | `opencode run` + `opencode stats`    | live weekly + local session estimate  | `opencode-go/deepseek-v4-flash`    |
| `minimax`  | MiniMax Token Plan   | authenticated OpenCode provider      | local five-hour estimate              | `minimax-coding-plan/MiniMax-M2.7` |

Claude is enabled by default. Every other provider is opt-in because a warmup
consumes real quota.

For Z.AI and MiniMax, connect the corresponding Coding Plan inside OpenCode
first (`opencode auth login`). Credentials stay in each vendor CLI's own auth
store; `agent-warmup` never persists API keys.

## How usage is read

Z.AI, Kimi and MiniMax expose no stable machine-readable quota endpoint suitable
for unattended polling, so the CLI conservatively treats a successful warmup
within the last five hours as an active window — shown as `active (estimated)`
in status and the TUI.

Codex reads the five-hour and weekly percentages its own sessions log under
`~/.codex/sessions`. Warmups are ephemeral and do not refresh that log, so the
figures are as of your last interactive Codex session.

## Why these providers

MiniMax is included because its Token Plan also has a five-hour allowance. Kimi
is included on request, but its official documentation calls the five-hour limit
rolling: use it as an availability pulse, not as a way to shift a reset.

Copilot, Gemini and Qwen are intentionally excluded because their relevant
limits are fixed monthly/daily/weekly or genuinely sliding.

## Quota semantics

A warmup is a real billable/subscription request, including for pulse-only
adapters. Enable only plans whose reset timing you intentionally want to align.
Provider limits and model catalogs change over time, so model IDs and binary
paths stay configurable instead of being baked into the scheduler.

The warmup workdir contains no project code: Codex runs ephemeral and read-only,
Kimi loads an empty skills directory, Claude starts in safe mode. Logs and
output captures are retained for 14 days by default.
