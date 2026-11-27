#!/usr/bin/env bash
# Arms Google Antigravity CLI (`agy`) with one sandboxed, non-interactive turn.
set -euo pipefail
umask 077

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"
WARMUP_BIN="${WARMUP_BIN:-$AGY_BIN}"
MODEL="${WARMUP_MODEL:-gemini-4-hydrogen}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.agent-warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
CAPTURE="$LOG_DIR/pane-agy-$(date '+%Y%m%d-%H%M%S').txt"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: agy is not executable at $WARMUP_BIN. Run: agent-warmup detect --apply"; exit 1; }
log "START agy (model=$MODEL workdir=$WORKDIR)"
set +e
(cd "$WORKDIR" && "$WARMUP_BIN" --print --sandbox --disable-slash-commands \
  --print-timeout 120s --model "$MODEL" "$PROMPT") > "$CAPTURE" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ] && [ -s "$CAPTURE" ]; then
  log "OK: Antigravity CLI replied -> usage window armed (capture: $CAPTURE)"
else
  [ "$STATUS" -ne 0 ] || STATUS=2
  log "WARN: Antigravity CLI warmup failed (status=$STATUS). Read $CAPTURE"
fi
find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
log "DONE agy (status=$STATUS)"
exit "$STATUS"
