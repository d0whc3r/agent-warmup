#!/usr/bin/env bash
# Arms Kimi Code with one non-interactive turn and no project skills loaded.
set -euo pipefail

export PATH="$HOME/.kimi-code/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

KIMI_BIN="${KIMI_BIN:-$HOME/.kimi-code/bin/kimi}"
WARMUP_BIN="${WARMUP_BIN:-$KIMI_BIN}"
MODEL="${WARMUP_MODEL:-kimi-code/kimi-for-coding}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.agent-warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
SKILLS_DIR="$WORKDIR/.empty-skills"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$SKILLS_DIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
CAPTURE="$LOG_DIR/pane-kimi-$(date '+%Y%m%d-%H%M%S').txt"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: kimi not executable at $WARMUP_BIN"; exit 1; }
log "START kimi (model=$MODEL workdir=$WORKDIR)"
set +e
(cd "$WORKDIR" && "$WARMUP_BIN" -m "$MODEL" --skills-dir "$SKILLS_DIR" \
  -p "$PROMPT") > "$CAPTURE" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ] && [ -s "$CAPTURE" ]; then
  log "OK: Kimi Code replied -> usage window armed (capture: $CAPTURE)"
else
  [ "$STATUS" -ne 0 ] || STATUS=2
  log "WARN: Kimi warmup failed (status=$STATUS); check $CAPTURE"
fi
find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
log "DONE kimi (status=$STATUS)"
exit "$STATUS"
