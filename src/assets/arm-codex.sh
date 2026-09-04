#!/usr/bin/env bash
# Arms OpenAI Codex with one ephemeral, read-only, non-interactive turn.
set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

CODEX_BIN="${CODEX_BIN:-$HOME/.local/bin/codex}"
WARMUP_BIN="${WARMUP_BIN:-$CODEX_BIN}"
MODEL="${WARMUP_MODEL:-gpt-5.6-luna}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.agent-warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
CAPTURE="$LOG_DIR/pane-codex-$(date '+%Y%m%d-%H%M%S').txt"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: codex not executable at $WARMUP_BIN"; exit 1; }
log "START codex (model=$MODEL workdir=$WORKDIR)"
set +e
"$WARMUP_BIN" exec --ephemeral --sandbox read-only --skip-git-repo-check \
  --ignore-user-config --ignore-rules -C "$WORKDIR" -m "$MODEL" "$PROMPT" > "$CAPTURE" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ] && [ -s "$CAPTURE" ]; then
  log "OK: OpenAI Codex replied -> usage window armed (capture: $CAPTURE)"
else
  [ "$STATUS" -ne 0 ] || STATUS=2
  log "WARN: Codex warmup failed (status=$STATUS); check $CAPTURE"
fi
find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
log "DONE codex (status=$STATUS)"
exit "$STATUS"
