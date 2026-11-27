#!/usr/bin/env bash
# Install agent-warmup from a GitHub release into ~/.local/bin (or INSTALL_DIR).
#
#   curl -fsSL https://raw.githubusercontent.com/d0whc3r/agent-warmup/main/install.sh | bash
#
# Env:
#   INSTALL_DIR  destination directory     (default: ~/.local/bin)
#   VERSION      release tag, like v1.2.3  (default: latest)
#   WARMUP_HOME  config and log directory  (default: ~/.agent-warmup)
set -euo pipefail

REPO="d0whc3r/agent-warmup"
BIN_NAME="agent-warmup"
SUMS_NAME="checksums.txt"
# Global, so the EXIT trap still sees it after install_binary returns.
tmp_dir=""

fail() {
  echo "✗ $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Install it and run the script again."
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture: $(uname -m) (amd64 and arm64 only)" ;;
  esac
  echo "${os}-${arch}"
}

release_base_url() {
  local version="${VERSION:-latest}"
  if [ "$version" = latest ]; then
    echo "https://github.com/${REPO}/releases/latest/download"
    return
  fi
  if [[ ! "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "invalid VERSION: ${version} (expected a tag like v1.2.3, or latest)"
  fi
  echo "https://github.com/${REPO}/releases/download/v${version#v}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
    return
  fi
  fail "sha256sum or shasum is required to check the download. Install one of them."
}

verify_checksum() {
  local file="$1" asset="$2" sums="$3" expected actual
  expected="$(awk -v name="$asset" '$2 == name { print tolower($1); exit }' "$sums")"
  [ -n "$expected" ] || fail "${SUMS_NAME} has no entry for ${asset}"
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
  fi
}

download() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 -o "$2" "$1" || fail "download failed: $1"
}

# A global npm or pnpm link of the old TypeScript build can come first on PATH and hide the new binary.
warn_shadowed() {
  local dest="$1" name found
  for name in "$BIN_NAME" claude-warmup; do
    while IFS= read -r found; do
      [ "$found" = "$dest" ] && break
      echo "! ${found} is an old install that comes before ${dest} on PATH."
      case "$found" in
        *pnpm*) echo "  Remove it with: pnpm rm -g ${name}" ;;
        *node* | *npm* | *nvm* | *volta* | *fnm*) echo "  Remove it with: npm rm -g ${name}" ;;
        *) echo "  Remove it with: command rm -f ${found}" ;;
      esac
    done < <(type -aP "$name" 2>/dev/null || true)
  done
}

path_hint() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return ;;
  esac
  echo "  ${dir} is not on PATH. Add it to your shell profile:"
  case "${SHELL:-}" in
    */fish) echo "    fish_add_path ${dir}" ;;
    *) echo "    export PATH=\"${dir}:\$PATH\"" ;;
  esac
}

install_binary() {
  : "${HOME:?HOME is not set}"
  need_cmd curl
  need_cmd uname

  local target asset base dir dest staged cfg cfg_existed=0
  target="$(detect_target)"
  asset="${BIN_NAME}-${target}"
  base="$(release_base_url)"
  dir="${INSTALL_DIR:-${HOME}/.local/bin}"
  dest="${dir}/${BIN_NAME}"
  cfg="${WARMUP_HOME:-${HOME}/.agent-warmup}/config.toml"

  echo "› installing ${asset} from ${base}"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/${BIN_NAME}.XXXXXX")"
  trap 'command rm -rf -- "$tmp_dir"' EXIT

  download "${base}/${asset}" "${tmp_dir}/${asset}"
  download "${base}/${SUMS_NAME}" "${tmp_dir}/${SUMS_NAME}"
  verify_checksum "${tmp_dir}/${asset}" "$asset" "${tmp_dir}/${SUMS_NAME}"

  chmod 0755 "${tmp_dir}/${asset}"
  if [ "$(uname -s)" = Darwin ]; then
    xattr -d com.apple.quarantine "${tmp_dir}/${asset}" 2>/dev/null || true
  fi
  mkdir -p "$dir"
  # Copy next to the destination, then rename: the rename is atomic on one
  # file system, so a running agent-warmup never sees a half-written binary.
  staged="${dir}/.${BIN_NAME}.$$"
  command cp -f "${tmp_dir}/${asset}" "$staged"
  mv -f "$staged" "$dest"

  [ -f "$cfg" ] && cfg_existed=1
  if ! "$dest" version >/dev/null 2>&1; then
    echo "✗ ${dest} failed to run" >&2
    if [ "$(uname -s)" = Darwin ]; then
      echo "  If Gatekeeper blocks it, allow it in System Settings > Privacy & Security > Open Anyway." >&2
    fi
    exit 1
  fi
  echo "✓ installed ${dest}"

  # The binary removes what the old TypeScript install left behind: the launchd job, the cron block, and their tmux sessions.
  "$dest" clean-legacy || echo "! legacy cleanup failed. Run: ${dest} clean-legacy"

  if [ "$cfg_existed" = 1 ]; then
    echo "  config    ${cfg} (kept)"
  else
    echo "  config    ${cfg}"
  fi
  warn_shadowed "$dest"
  path_hint "$dir"
  echo "  next      ${BIN_NAME} detect --apply"
}

case "${1:-}" in
  "") install_binary ;;
  -h | --help)
    echo "Install ${BIN_NAME} from https://github.com/${REPO}/releases"
    echo "Env: INSTALL_DIR  VERSION  WARMUP_HOME"
    ;;
  *) fail "unknown option: $1 (try --help)" ;;
esac
