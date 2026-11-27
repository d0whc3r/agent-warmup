#!/usr/bin/env bash
# Stands in for tmux in the Claude probe tests. It keeps the pane in a file:
# Enter on a trust prompt shows TMUX_READY_PANE; Enter on any other pane shows
# TMUX_USAGE_PANE. Every send-keys call is appended to $TMUX_FAKE_DIR/keys.
set -euo pipefail
PANE="$TMUX_FAKE_DIR/pane"
case "$1" in
  kill-session) command rm -f "$PANE" ;;
  new-session)
    printf '%s' "$TMUX_INITIAL_PANE" > "$PANE"
    exit "${TMUX_NEW_SESSION_STATUS:-0}" ;;
  capture-pane) [ ! -f "$PANE" ] || cat "$PANE" ;;
  send-keys)
    shift
    keys=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift 2 ;;
        -l) shift ;;
        *) keys="$keys$1"; shift ;;
      esac
    done
    printf "%s\n" "$keys" >> "$TMUX_FAKE_DIR/keys"
    if [ "$keys" = "Enter" ]; then
      case "$(cat "$PANE" 2>/dev/null || true)" in
        *trust*) printf '%s' "$TMUX_READY_PANE" > "$PANE" ;;
        *) printf '%s' "$TMUX_USAGE_PANE" > "$PANE" ;;
      esac
    fi ;;
esac
