# Supported providers

agent-warmup supports seven providers. Claude is enabled by default. Every other provider is opt-in, because each warmup uses real quota. Enable one with `agent-warmup provider <id> enable`.

| ID | Service | Warmup command | Usage source | Default model |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | interactive Claude session in tmux | live `/usage` | `haiku` |
| `codex` | OpenAI Codex | `codex exec --sandbox read-only` | rate limits in the local Codex session files | `gpt-5.6-luna` |
| `zai` | Z.AI GLM Coding Plan | `opencode run` with the Z.AI provider | local five-hour estimate | `zai-coding-plan/glm-5.3-flash` |
| `kimi` | Kimi Code | `kimi -p` | local five-hour estimate | `kimi-code/kimi-for-coding` |
| `opencode` | OpenCode Go | `opencode run` | live weekly cost from `opencode stats`, local session estimate | `opencode-go/deepseek-v4-flash` |
| `minimax` | MiniMax Token Plan | `opencode run` with the MiniMax provider | local five-hour estimate | `minimax-coding-plan/MiniMax-M2.7` |
| `agy` | Antigravity CLI | `agy --print --sandbox` | local five-hour estimate | `gemini-4-hydrogen` |

## Contents

- [Before you enable a provider](#before-you-enable-a-provider)
- [How each provider reads usage](#how-each-provider-reads-usage)
- [Quota and safety](#quota-and-safety)
- [Why these providers](#why-these-providers)

## Before you enable a provider

- Install the provider CLI and log in with it once by hand. agent-warmup never stores API keys. Each CLI keeps its own credentials.
- Run `agent-warmup detect --apply` to save the absolute path of each CLI.
- Install `tmux` for Claude Code.

Z.AI and MiniMax have no CLI of their own. Both run through the `opencode` binary. Connect each plan in OpenCode first with `opencode auth login`. Until OpenCode holds the credential (`zai-coding-plan` or `minimax-coding-plan`), `detect` and `provider list` show the provider as blocked. This prevents one OpenCode binary from looking like three working providers.

## How each provider reads usage

- Claude opens a short tmux session and reads the `/usage` screen. This check is free: it sends no message and does not start a window.
- Codex reads the five-hour and weekly percentages from the newest session files under `~/.codex/sessions`. These files are the only place where Codex records its server-side rate limits. For this reason, the warmup runs `codex exec` without `--ephemeral`. Each warmup leaves one small session file, which Codex does not delete.
- OpenCode Go reads the weekly cost from `opencode stats` and converts it to a percentage of the weekly allowance.
- Z.AI, Kimi, MiniMax, and Antigravity CLI have no stable usage endpoint for unattended checks. agent-warmup treats a successful warmup in the last five hours as an active window. The status shows it as `active (estimated)`.

When a live check fails, the provider falls back to the same local estimate.

## Quota and safety

Each warmup is a real request that counts against your plan. Enable only the plans whose reset time you want to move.

The warmup runs in an empty workdir with no project code. Codex runs read-only, Kimi loads an empty skills directory, Antigravity runs in its sandbox, and Claude starts in safe mode.

Model IDs and binary paths change over time. Thus, both stay in `config.toml`, and the scheduler does not contain them.

## Why these providers

Claude Code, Codex, Z.AI, OpenCode Go, and MiniMax have a five-hour allowance that starts with the first request, so a warmup moves the reset. Kimi documents its five-hour limit as rolling. Use it as an availability check, not to move a reset.

agent-warmup does not support Copilot, Gemini, and Qwen. Their limits are monthly, daily, weekly, or truly sliding, so a warmup changes nothing.
