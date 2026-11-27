#!/usr/bin/env bash
#
# agent-warmup OpenCode runner. OpenCode Go, Z.AI Coding Plan, and MiniMax Token
# Plan share it. The credential store of OpenCode selects the account.
set -euo pipefail
umask 077

# launchd and cron start with a bare PATH, so add the usual install directories.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
WARMUP_BIN="${WARMUP_BIN:-$OPENCODE_BIN}"
MODEL="${WARMUP_MODEL:-opencode-go/deepseek-v4-flash}"
PROMPT="${WARMUP_PROMPT:-reply with only the word: ok}"
PROVIDER="${WARMUP_PROVIDER:-opencode}"
PROVIDER_NAME="${WARMUP_PROVIDER_NAME:-OpenCode Go}"
WARMUP_HOME="${WARMUP_HOME:-$HOME/.agent-warmup}"
WORKDIR="${WARMUP_WORKDIR:-$WARMUP_HOME/workdir}"
LOG_DIR="${WARMUP_LOG_DIR:-$WARMUP_HOME/logs}"
RETENTION_DAYS="${WARMUP_LOG_RETENTION_DAYS:-14}"

mkdir -p "$WORKDIR" "$LOG_DIR"
LOG="$LOG_DIR/warmup.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

[ -x "$WARMUP_BIN" ] || { log "ERROR: opencode is not executable at $WARMUP_BIN. Run: agent-warmup detect --apply"; exit 1; }
log "START $PROVIDER (model=$MODEL workdir=$WORKDIR)"

PANE="$LOG_DIR/pane-$PROVIDER-$(date '+%Y%m%d-%H%M%S').txt"
set +e
(cd "$WORKDIR" && "$WARMUP_BIN" run --model "$MODEL" --format json \
  --title "agent-warmup-$PROVIDER" "$PROMPT") > "$PANE" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ] && [ -s "$PANE" ]; then
  log "OK: $PROVIDER_NAME replied -> usage window armed (capture: $PANE)"
else
  [ "$STATUS" -ne 0 ] || STATUS=2
  log "WARN: $PROVIDER_NAME warmup failed (status=$STATUS). Read $PANE"
fi

find "$LOG_DIR" -name 'pane-*.txt' -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

log "DONE $PROVIDER (status=$STATUS)"
exit "$STATUS"
