#!/usr/bin/env bash
#
# zkao CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/zksecurity/zkao-sdk/main/install.sh | bash
#
# Installs the published `@zksecurity/zkao-cli` package globally and exposes the
# `zkao` binary. Uses whichever Node package manager is available (npm, then
# pnpm, then bun). Set ZKAO_CLI_VERSION to pin a version (defaults to latest).
# Pass --next or set ZKAO_CHANNEL=next for the staging channel:
#
#   curl -fsSL https://raw.githubusercontent.com/zksecurity/zkao-sdk/main/install.sh | bash -s -- --next
set -euo pipefail

PKG="@zksecurity/zkao-cli"
CHANNEL="${ZKAO_CHANNEL:-latest}"
for arg in "$@"; do
  case "$arg" in
    --next) CHANNEL="next" ;;
    *) printf 'zkao install: unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
case "$CHANNEL" in
  latest|next) ;;
  *) printf 'zkao install: ZKAO_CHANNEL must be latest or next, got: %s\n' "$CHANNEL" >&2; exit 1 ;;
esac
VERSION="${ZKAO_CLI_VERSION:-$CHANNEL}"
SPEC="${PKG}@${VERSION}"

err() { printf 'zkao install: %s\n' "$1" >&2; }

install_with() {
  # $1 = human label, rest = command
  local label="$1"; shift
  err "installing ${SPEC} with ${label}..."
  "$@"
}

if command -v npm >/dev/null 2>&1; then
  install_with npm npm install -g "$SPEC"
elif command -v pnpm >/dev/null 2>&1; then
  install_with pnpm pnpm add -g "$SPEC"
elif command -v bun >/dev/null 2>&1; then
  install_with bun bun add -g "$SPEC"
else
  err "no supported package manager found (need npm, pnpm, or bun)."
  err "install Node.js 18+ (which ships npm) and re-run this script."
  exit 1
fi

if command -v zkao >/dev/null 2>&1; then
  err "installed: $(zkao --version 2>/dev/null || echo "$SPEC")"
  err "next: run \`zkao login\` to authorize the CLI for a project."
  if [ "$CHANNEL" = "next" ]; then
    err "the next channel tracks staging: set ZKAO_URL=staging.zkao.io before \`zkao login\`."
  fi
else
  err "installed ${SPEC}, but \`zkao\` is not on your PATH."
  err "add your package manager's global bin directory to PATH, e.g.:"
  err "  npm:  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  err "then run \`zkao login\`."
fi
