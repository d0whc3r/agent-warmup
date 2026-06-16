#!/usr/bin/env bash
#
# claude-warmup/arm-opencode.sh -- arms OpenCode Go's 5h usage window by launching
# a real interactive session inside tmux, sending a trivial prompt, and exiting.
# The "arming" request is the same shape as Claude's: a small request at the
# start of the window keeps the 5h rolling cap fresh. On Go the cost is
# negligible (~$0.0004 with the cheapest model, opencode-go/deepseek-v4-flash).
set -euo pipefail

# Robust minimal PATH (launchd/cron start with a bare PATH).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
WARMUP_BIN="${WARMUP_BIN:-$OPENCODE_BIN}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
MODEL="${WARMUP_MODEL:-opencode-go/deepseek-v4-flash}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.claude/warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
SESSION="${WARMUP_TMUX_SESSION:-opencode-warmup}"
READY_WAIT="${WARMUP_READY_WAIT:-10}"
RESPONSE_WAIT="${WARMUP_RESPONSE_WAIT:-25}"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: opencode not executable at $WARMUP_BIN"; exit 1; }
[ -x "$TMUX_BIN" ]   || { log "ERROR: tmux not executable at $TMUX_BIN"; exit 1; }

"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true
log "START opencode (model=$MODEL workdir=$WORKDIR)"

"$TMUX_BIN" new-session -d -s "$SESSION" -x 220 -y 50 -c "$WORKDIR" \
  "$WARMUP_BIN" run --model "$MODEL" --format json --title "claude-warmup-arm"

sleep "$READY_WAIT"

"$TMUX_BIN" send-keys -t "$SESSION" -l "$PROMPT"
sleep 1
"$TMUX_BIN" send-keys -t "$SESSION" Enter
sleep "$RESPONSE_WAIT"

PANE="$LOG_DIR/pane-$(date '+%Y%m%d-%H%M%S').txt"
"$TMUX_BIN" capture-pane -p -t "$SESSION" -S -400 > "$PANE" 2>/dev/null || true

# OpenCode prints a JSON event for each message; we look for a "completed" or
# similar marker to confirm a real request was made (which is what arms the
# window). Falls back to "any non-empty output" if the JSON shape moves.
if grep -qE '"type"[[:space:]]*:[[:space:]]*"(step-finish|message-end|text)"' "$PANE" 2>/dev/null \
   || grep -qE 'completion|finished' "$PANE" 2>/dev/null; then
  log "OK: reply received -> usage window armed (pane: $PANE)"
  STATUS=0
else
  log "WARN: no reply detected; check $PANE"
  STATUS=2
fi

"$TMUX_BIN" send-keys -t "$SESSION" -l "/exit" 2>/dev/null || true
"$TMUX_BIN" send-keys -t "$SESSION" Enter 2>/dev/null || true
sleep 2
"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true

find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

log "DONE opencode (status=$STATUS)"
exit "$STATUS"
