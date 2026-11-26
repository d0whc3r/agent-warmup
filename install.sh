#!/usr/bin/env bash
# Install agent-warmup from a GitHub Release into ~/.local/bin (or INSTALL_DIR).
#
#   curl -fsSL https://raw.githubusercontent.com/d0whc3r/agent-warmup/main/install.sh | bash
#
# Env:
#   INSTALL_DIR  destination directory          (default: ~/.local/bin)
#   WARMUP_HOME  config/log directory           (default: ~/.agent-warmup)
#   VERSION      release tag, e.g. v1.2.3       (default: latest)
#   REPO         GitHub owner/repo              (default: d0whc3r/agent-warmup)
set -euo pipefail

REPO="${REPO:-d0whc3r/agent-warmup}"
BIN_NAME="agent-warmup"

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

validate_repo() {
  if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    echo "✗ invalid REPO: ${REPO} (expected owner/repo)" >&2
    exit 1
  fi
}

release_tag() {
  local version="${VERSION:-latest}"
  if [ "$version" = latest ]; then
    echo latest
    return
  fi
  if [[ ! "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "✗ invalid VERSION: ${version} (expected semver like v1.2.3 or latest)" >&2
    exit 1
  fi
  case "$version" in
    v*) echo "$version" ;;
    *) echo "v${version}" ;;
  esac
}

release_asset_url() {
  local asset="$1"
  local tag
  validate_repo
  tag="$(release_tag)"
  if [ "$tag" = latest ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${tag}/${asset}"
  fi
}

download_url() {
  local target="$1"
  release_asset_url "${BIN_NAME}-${target}"
}

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 1
  fi
}

verify_checksum() {
  local file="$1" asset="$2" sums_file="$3" expected actual
  [ -s "$sums_file" ] || return 0
  expected="$(awk -v name="$asset" '$2 == name && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1); exit }' "$sums_file")"
  [ -n "$expected" ] || return 0
  actual="$(sha256_of "$file" | tr '[:upper:]' '[:lower:]')" || return 0
  if [ "$actual" != "$expected" ]; then
    echo "✗ checksum mismatch for ${asset}" >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    exit 1
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

config_path() {
  echo "${WARMUP_HOME:-${HOME}/.agent-warmup}/warmup.env"
}

# The binary writes a fully commented warmup.env from its built-in defaults on any
# run, so a fresh install lands with a template to edit. An existing config is kept.
# `existed` is sampled before the binary is ever run, since verify_binary already
# triggers the seed.
seed_config() {
  local dest="$1" existed="$2" cfg
  cfg="$(config_path)"
  if [ "$existed" = 1 ]; then
    echo "  config    ${cfg} (kept)"
    return 0
  fi
  "$dest" help >/dev/null 2>&1 || true
  if [ -f "$cfg" ]; then
    echo "  config    ${cfg}"
  else
    echo "  config    ${cfg} (created on first run)"
  fi
}

install_binary() {
  local target asset url sums_url dir dest tmp sums_tmp cfg_existed=0
  : "${HOME:?HOME is not set}"
  need_cmd curl
  need_cmd mktemp
  need_cmd uname

  target="$(detect_target)"
  asset="${BIN_NAME}-${target}"
  url="$(download_url "$target")"
  sums_url="$(release_asset_url "SHA256SUMS")"
  dir="$(install_dir)"
  dest="${dir}/${BIN_NAME}"

  echo "› installing ${BIN_NAME} (${target})"
  echo "  ${url}"

  mkdir -p "$dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/${BIN_NAME}.XXXXXX")"
  sums_tmp="$(mktemp "${TMPDIR:-/tmp}/${BIN_NAME}-sums.XXXXXX")"
  trap 'rm -f "$tmp" "$sums_tmp"' EXIT

  curl -fsSL --proto=https --tlsv1.2 --retry 2 --retry-delay 1 -o "$sums_tmp" "$sums_url" 2>/dev/null || rm -f "$sums_tmp"

  if ! curl -fL --proto=https --tlsv1.2 --retry 3 --retry-delay 1 -o "$tmp" "$url"; then
    echo "✗ failed to download ${url}" >&2
    echo "  Check https://github.com/${REPO}/releases for available assets." >&2
    exit 1
  fi
  if [ ! -s "$tmp" ]; then
    echo "✗ download was empty: ${url}" >&2
    exit 1
  fi

  verify_checksum "$tmp" "$asset" "$sums_tmp"
  rm -f "$sums_tmp"

  chmod +x "$tmp"
  if [ "$(uname -s)" = Darwin ]; then
    xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
  fi

  rm -f "$dest"
  mv "$tmp" "$dest"
  trap - EXIT

  if [ -f "$(config_path)" ]; then
    cfg_existed=1
  fi
  verify_binary "$dest"

  echo "✓ installed ${dest}"
  seed_config "$dest" "$cfg_existed"
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
    --print-config)
      : "${HOME:?HOME is not set}"
      config_path
      ;;
    -h | --help)
      echo "Install ${BIN_NAME} from https://github.com/${REPO}/releases"
      echo
      echo "Usage: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash"
      echo
      echo "Env: INSTALL_DIR  VERSION  REPO  WARMUP_HOME"
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
