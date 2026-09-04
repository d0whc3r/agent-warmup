#!/usr/bin/env bash
# Install agent-warmup from a GitHub Release into ~/.local/bin (or INSTALL_DIR).
#
#   curl -fsSL https://github.com/d0whc3r/agent-warmup/releases/latest/download/install.sh | bash
#
# Env:
#   INSTALL_DIR  destination directory          (default: ~/.local/bin)
#   VERSION      release tag, e.g. v1.2.3       (default: latest)
#   REPO         GitHub owner/repo              (default: d0whc3r/agent-warmup)
set -euo pipefail

REPO="${REPO:-d0whc3r/agent-warmup}"
BIN_NAME="agent-warmup"
ALIAS_NAME="claude-warmup"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗ $1 is required" >&2
    exit 1
  fi
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      echo "✗ Windows is not supported (the warmup runner needs tmux + bash)" >&2
      exit 1
      ;;
    *)
      echo "✗ unsupported OS: $(uname -s) (macOS and Linux only)" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *)
      echo "✗ unsupported arch: $(uname -m) (x64 and arm64 only)" >&2
      exit 1
      ;;
  esac
  echo "${os}-${arch}"
}

release_tag() {
  local version="${VERSION:-latest}"
  if [ "$version" = latest ]; then
    echo latest
    return
  fi
  case "$version" in
    v*) echo "$version" ;;
    *) echo "v${version}" ;;
  esac
}

download_url() {
  local target="$1"
  local tag asset
  tag="$(release_tag)"
  asset="${BIN_NAME}-${target}"
  if [ "$tag" = latest ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${tag}/${asset}"
  fi
}

install_dir() {
  echo "${INSTALL_DIR:-${HOME}/.local/bin}"
}

path_has_dir() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

shell_rc_hint() {
  case "${SHELL:-}" in
    */zsh) echo "${HOME}/.zshrc" ;;
    */bash) echo "${HOME}/.bashrc" ;;
    */fish) echo "${HOME}/.config/fish/config.fish" ;;
    *) echo "your shell profile" ;;
  esac
}

verify_binary() {
  local dest="$1"
  if [ "${INSTALL_VERIFY:-1}" = 0 ]; then
    return 0
  fi
  if "$dest" help >/dev/null 2>&1; then
    return 0
  fi
  echo "✗ ${dest} failed to run" >&2
  if [ "$(uname -s)" = Darwin ]; then
    echo "  macOS Gatekeeper may have blocked it. System Settings → Privacy & Security → Open Anyway" >&2
    echo "  or: xattr -d com.apple.quarantine ${dest}" >&2
  fi
  exit 1
}

install_binary() {
  local target url dir dest tmp
  : "${HOME:?HOME is not set}"
  need_cmd curl
  need_cmd mktemp
  need_cmd uname

  target="$(detect_target)"
  url="$(download_url "$target")"
  dir="$(install_dir)"
  dest="${dir}/${BIN_NAME}"

  echo "› installing ${BIN_NAME} (${target})"
  echo "  ${url}"

  mkdir -p "$dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/${BIN_NAME}.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT

  if ! curl -fL --retry 3 --retry-delay 1 -o "$tmp" "$url"; then
    echo "✗ failed to download ${url}" >&2
    echo "  Check https://github.com/${REPO}/releases for available assets." >&2
    exit 1
  fi
  if [ ! -s "$tmp" ]; then
    echo "✗ download was empty: ${url}" >&2
    exit 1
  fi

  chmod +x "$tmp"
  if [ "$(uname -s)" = Darwin ]; then
    xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
  fi

  rm -f "$dest"
  mv "$tmp" "$dest"
  trap - EXIT
  ln -sfn "$dest" "${dir}/${ALIAS_NAME}"

  verify_binary "$dest"

  echo "✓ installed ${dest}"
  echo "  alias     ${dir}/${ALIAS_NAME}"
  if path_has_dir "$dir"; then
    echo "  next      ${BIN_NAME} status"
  else
    echo "  PATH does not include ${dir}. Add this to $(shell_rc_hint):"
    case "${SHELL:-}" in
      */fish) echo "    fish_add_path ${dir}" ;;
      *) echo "    export PATH=\"${dir}:\$PATH\"" ;;
    esac
    echo "  then run: ${dest} status"
  fi
}

main() {
  case "${1:-}" in
    --print-target)
      detect_target
      ;;
    --print-url)
      download_url "$(detect_target)"
      ;;
    --print-dir)
      : "${HOME:?HOME is not set}"
      install_dir
      ;;
    -h | --help)
      echo "Install ${BIN_NAME} from https://github.com/${REPO}/releases"
      echo
      echo "Usage: curl -fsSL https://github.com/${REPO}/releases/latest/download/install.sh | bash"
      echo
      echo "Env: INSTALL_DIR  VERSION  REPO"
      ;;
    "")
      install_binary
      ;;
    *)
      echo "✗ unknown option: $1" >&2
      echo "  try: bash install.sh --help" >&2
      exit 1
      ;;
  esac
}

main "$@"
