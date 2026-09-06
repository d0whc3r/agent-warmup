#!/usr/bin/env bash
#
# Cross-build the release SEA binaries into out/, one per target in $TARGETS.
#
#   bash scripts/build-sea-release.sh [expected-version]
#
# Run by semantic-release's `prepare` step (see .releaserc.json) so the bundle is
# built AFTER package.json has been bumped — src/version.ts inlines that version,
# so a released binary reports its own tag. Passing the expected version makes the
# smoke test assert exactly that.
#
# `node --build-sea` (Node 26) injects the app blob into a *target* Node runtime via
# LIEF, so the host arch/OS does not matter: each target downloads its own official
# Node build. macOS Mach-O signatures are invalidated by the injection and arm64
# macOS refuses to run unsigned, so those get ad-hoc signed with rcodesign.
#
# Env:
#   TARGETS    space-separated os-arch list   (default: the four release targets)
#   RCODESIGN  path to the rcodesign binary   (default: rcodesign on PATH)
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_VERSION="${1:-}"
TARGETS="${TARGETS:-linux-x64 linux-arm64 darwin-x64 darwin-arm64}"
RCODESIGN="${RCODESIGN:-rcodesign}"

echo "› bundling (tsdown)"
npx tsdown

NODE_VERSION="$(node -v)" # e.g. v26.2.0
mkdir -p out
for TARGET in $TARGETS; do
  OS="${TARGET%-*}"
  ARCH="${TARGET#*-}"
  echo "::group::$TARGET"

  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${OS}-${ARCH}.tar.gz" -o node.tar.gz
  rm -rf target-node && mkdir -p target-node
  tar xf node.tar.gz -C target-node --strip-components=1

  OUT="out/agent-warmup-${TARGET}"
  jq --arg exe "$PWD/target-node/bin/node" --arg out "$OUT" \
    '.executable = $exe | .output = $out' sea-config.json > sea.target.json
  node --build-sea sea.target.json
  chmod +x "$OUT"

  if [ "$OS" = darwin ]; then
    "$RCODESIGN" sign "$OUT"
  fi
  echo "::endgroup::"
done

# Only a binary for the host os/arch can be executed here; the rest are foreign.
HOST="$(node -p 'process.platform + "-" + process.arch')"
HOST_BIN="out/agent-warmup-${HOST}"
if [ ! -x "$HOST_BIN" ]; then
  echo "› skipping smoke test: no ${HOST} binary in this build"
  exit 0
fi

echo "› smoke test ${HOST_BIN}"
"$HOST_BIN" help > /dev/null
BUILT_VERSION="$("$HOST_BIN" version)"
if [ -n "$EXPECTED_VERSION" ] && [ "$BUILT_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "✗ binary reports ${BUILT_VERSION}, expected ${EXPECTED_VERSION}" >&2
  echo "  the bundle was built before the version bump — check the prepare order" >&2
  exit 1
fi
echo "✓ built $(echo "$TARGETS" | wc -w | tr -d ' ') binaries (version ${BUILT_VERSION})"
