# agent-warmup: provider-neutral scope

**Status:** Implemented  
**Date:** 2026-09-04

## Product definition

`agent-warmup` primes quota windows for AI coding subscriptions before a
developer's working hours. Anchored windows can be aligned; rolling windows are
explicitly pulse-only. The app owns one scheduler, one config, one cache and one
TUI while each provider adapter owns its probe, fallback estimate, runner,
models and failure bookkeeping.

The tool sends a real minimal request. It is not a latency benchmark. Providers
without a time-window subscription do not fit.

## Included adapters

- Claude Code: live `/usage`; interactive safe-mode request through tmux.
- OpenAI Codex: five-hour plan allowance; ephemeral read-only `codex exec`.
- Z.AI GLM Coding Plan: five-hour cycle; OpenCode with the official
  `zai-coding-plan` provider.
- Kimi Code: explicitly marked rolling five-hour pulse plus weekly quota;
  official `kimi -p` CLI. This does not shift the rolling reset boundary.
- OpenCode Go: five-hour/weekly/monthly plan; live weekly statistics and local
  session inference.
- MiniMax Token Plan: five-hour allowance plus weekly allowance; OpenCode with
  the official `minimax-coding-plan` provider.

All non-Claude providers are opt-in. Credentials stay in the underlying CLI's
auth store and are never copied into `warmup.env`.

## Excluded for now

- GitHub Copilot: its included allowance resets at a fixed monthly boundary.
- Gemini CLI: daily and per-minute limits do not gain a useful boundary from a
  warmup.
- Qwen/Alibaba Coding Plan: a genuinely sliding five-hour quota releases usage
  continuously; a warmup consumes allowance but does not shift a reset window.
- API-key pay-as-you-go providers: there is no subscription window to align.

An excluded service can be reconsidered if it introduces an anchored window and
a supported unattended coding-agent invocation.

## Architecture contract

The registry is the source of truth for built-in IDs. A provider declares:

1. human-readable name and model choices;
2. live or estimated probe capability;
3. cache inference and pure decision behavior;
4. arm script and environment mapping;
5. optional post-arm cache bookkeeping.

The scheduler and tick contain no provider-ID branches. Fixed mode evaluates
each provider's own schedule; smart mode evaluates each provider's usage window.
Two failures inside 30 minutes trigger a one-hour cooldown for cache-only
providers.

## Compatibility

- Canonical command/package: `agent-warmup`.
- Compatibility command alias: `claude-warmup`.
- New home: `~/.agent-warmup`.
- If only the legacy `~/.claude/warmup` exists, it remains active.
- Legacy flat config migrates into the Claude stanza on first save.
- The existing launchd label and cron marker remain stable to avoid orphaning
  installed schedulers during the rename.

## Primary references

- [OpenAI Codex pricing and five-hour limits](https://learn.chatgpt.com/docs/pricing)
- [OpenAI Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Z.AI Coding Plan FAQ](https://docs.z.ai/devpack/faq)
- [Z.AI with OpenCode](https://docs.z.ai/devpack/tool/opencode)
- [Kimi Code membership limits](https://www.kimi.com/code/docs/en/kimi-code/membership.html)
- [Kimi CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [MiniMax Token Plan](https://platform.minimax.io/subscribe/token-plan)
- [GitHub Copilot allowance resets](https://docs.github.com/en/copilot/reference/copilot-billing/license-changes)
