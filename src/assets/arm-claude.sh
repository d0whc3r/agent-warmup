#!/usr/bin/env bash
#
# agent-warmup/arm-claude.sh -- arms Claude Code's 5h usage window by launching a
# real interactive session inside tmux (not -p), sending a trivial prompt, and
# exiting. Reads all its config from env so the CLI can drive it headlessly.
#
# Uses --safe-mode: keeps normal auth (Keychain/OAuth) but disables hooks, MCP,
# CLAUDE.md and plugins -> fast startup, cheap, no integration prompts.
set -euo pipefail

# Robust minimal PATH (launchd/cron start with a bare PATH).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
WARMUP_BIN="${WARMUP_BIN:-$CLAUDE_BIN}"
MODEL="${WARMUP_MODEL:-haiku}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.agent-warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
SESSION="${WARMUP_TMUX_SESSION:-claude-warmup}"
READY_WAIT="${WARMUP_READY_WAIT:-10}"
RESPONSE_WAIT="${WARMUP_RESPONSE_WAIT:-25}"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: claude not executable at $WARMUP_BIN"; exit 1; }
[ -x "$TMUX_BIN" ]   || { log "ERROR: tmux not executable at $TMUX_BIN"; exit 1; }

"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true
log "START claude (model=$MODEL workdir=$WORKDIR)"

"$TMUX_BIN" new-session -d -s "$SESSION" -x 220 -y 50 -c "$WORKDIR" \
  "$WARMUP_BIN" --safe-mode --model "$MODEL"

sleep "$READY_WAIT"

SHOWN="$("$TMUX_BIN" capture-pane -p -t "$SESSION" 2>/dev/null || true)"
if grep -qiE "trust this folder|project you (created|trust)|do you trust" <<<"$SHOWN"; then
  # Two layouts: the numbered list ("1. Yes, proceed") takes the digit; the cursor
  # list (Claude Code >= 2.1.2xx) highlights "No, exit" first, so Down moves onto
  # "Yes, I trust this folder" before Enter confirms.
  if grep -q "Yes, I trust this folder" <<<"$SHOWN"; then
    log "trust dialog detected -> accepting (Down+Enter)"
    "$TMUX_BIN" send-keys -t "$SESSION" Down
  else
    log "trust dialog detected -> accepting (1)"
    "$TMUX_BIN" send-keys -t "$SESSION" "1"
  fi
  sleep 0.5
  "$TMUX_BIN" send-keys -t "$SESSION" Enter
  sleep 4
fi

"$TMUX_BIN" send-keys -t "$SESSION" -l "$PROMPT"
sleep 1
"$TMUX_BIN" send-keys -t "$SESSION" Enter

sleep "$RESPONSE_WAIT"

PANE="$LOG_DIR/pane-claude-$(date '+%Y%m%d-%H%M%S').txt"
"$TMUX_BIN" capture-pane -p -t "$SESSION" -S -400 > "$PANE" 2>/dev/null || true

if grep -q '⏺' "$PANE" 2>/dev/null; then
  log "OK: Claude Code replied -> usage window armed (pane: $PANE)"
  STATUS=0
else
  log "WARN: Claude Code warmup failed (no reply; status=2); check $PANE (may need higher READY_WAIT/RESPONSE_WAIT)"
  STATUS=2
fi

"$TMUX_BIN" send-keys -t "$SESSION" -l "/exit" 2>/dev/null || true
"$TMUX_BIN" send-keys -t "$SESSION" Enter 2>/dev/null || true
sleep 2
"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true

find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

log "DONE claude (status=$STATUS)"
exit "$STATUS"
