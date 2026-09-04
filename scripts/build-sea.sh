#!/usr/bin/env bash
#
# Build a single-executable (SEA) of agent-warmup for the HOST OS/arch (local builds).
#   1. bundle the CLI to one ESM file (tsdown)
#   2. `node --build-sea` generates the blob and injects it into a copy of the
#      running node binary in a single step (Node >=26; no postject)
#   3. re-sign on macOS (the binary was modified after signing)
#
# Produces dist/agent-warmup. Release binaries for every target are cross-compiled
# from ubuntu in .github/workflows/release.yml (it overrides sea-config.json's
# `executable`) and attached to the GitHub Release for the version tag. This script
# is the simple native path for local dev. Windows is out of scope: the warmup
# mechanism needs tmux + bash, which Windows lacks.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist/agent-warmup"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  echo "✗ build:sea needs Node >=26 (have $(node -v)) for --build-sea + ESM main. Try: nvm use 26" >&2
  exit 1
fi

echo "› bundling (tsdown)"
npx tsdown

echo "› building SEA (node --build-sea)"
node --build-sea sea-config.json # reads sea-config.json, writes $OUT directly

case "$(uname -s)" in
  Darwin) codesign --sign - "$OUT" ;; # ad-hoc re-sign; the blob injection broke the signature
  Linux) : ;;                         # nothing to sign
  *)
    echo "✗ unsupported OS: $(uname -s) (agent-warmup builds on macOS + Linux only)" >&2
    exit 1
    ;;
esac

chmod +x "$OUT"
echo "✓ built $OUT ($(du -h "$OUT" | cut -f1))"
