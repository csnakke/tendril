#!/usr/bin/env bash
#
# Tendril installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash
#
# Builds Tendril from source inside a throwaway Node container, so nothing but
# the finished app lands on this machine: no Node, no npm, no node_modules.
#
#   1. pull the Node image (only if it isn't here already)
#   2. in a container: git clone → npm install → npm run compile → npm run build:<os>
#   3. copy the app out of the container
#   4. remove the container, and the image if this script pulled it
#
# Result:  Linux  → ~/Applications/Tendril.AppImage
#          macOS  → ~/Applications/Tendril.app
#
# Needs: Docker (Docker Desktop, OrbStack, Colima, … on macOS) and curl.
#
# Options (environment variables):
#   TENDRIL_INSTALL_DIR  where the app goes          (default: ~/Applications)
#   TENDRIL_REPO         git URL to build from        (default: https://github.com/csnakke/tendril.git)
#   TENDRIL_REF          branch or tag to build       (default: main)
#   TENDRIL_NODE_IMAGE   Node image used for building (default: node:22-bookworm)

set -euo pipefail

REPO="${TENDRIL_REPO:-https://github.com/csnakke/tendril.git}"
REF="${TENDRIL_REF:-main}"
IMAGE="${TENDRIL_NODE_IMAGE:-node:22-bookworm}"
INSTALL_DIR="${TENDRIL_INSTALL_DIR:-$HOME/Applications}"

# ---- Output -------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' RED='' YELLOW='' RESET=''
fi
step() { printf '%s==>%s %s\n' "$BOLD$GREEN" "$RESET$BOLD" "$*$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---- Platform -----------------------------------------------------------------

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=mac ;;
  *) fail "Tendril's installer supports macOS and Linux only (this is $(uname -s))." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)." ;;
esac

# ---- Docker -------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || fail "Docker is required to build Tendril. Install Docker and run this again:
    https://docs.docker.com/get-docker/"

if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = linux ]; then
    fail "Docker is installed but not reachable. Start it (sudo systemctl start docker), or add yourself to
    the docker group (sudo usermod -aG docker \$USER, then log in again)."
  fi
  fail "Docker is installed but not running. Start Docker Desktop (or OrbStack / Colima) and run this again."
fi

# The build runs natively on this machine's CPU; the app is built for that CPU too.
case "$ARCH" in
  x64) DOCKER_PLATFORM=linux/amd64 ;;
  arm64) DOCKER_PLATFORM=linux/arm64 ;;
esac

# ---- Cleanup ------------------------------------------------------------------
# Whatever happens, leave nothing behind: the scratch folder, the container,
# and the image if this script was the one that pulled it.

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tendril-install.XXXXXX")"
CONTAINER="tendril-build-$$"
PULLED=0

cleanup() {
  local status=$?
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$PULLED" = 1 ]; then
    step "Removing the build image ($IMAGE)"
    docker rmi "$IMAGE" >/dev/null 2>&1 || warn "could not remove $IMAGE; remove it with: docker rmi $IMAGE"
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- Build --------------------------------------------------------------------

printf '\n%sTendril installer%s  %s(%s, %s)%s\n\n' "$BOLD" "$RESET" "$DIM" "$OS" "$ARCH" "$RESET"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Using the $IMAGE image already on this machine (it will be kept)."
else
  step "Pulling $IMAGE"
  PULLED=1
  docker pull --platform "$DOCKER_PLATFORM" "$IMAGE" >/dev/null
fi

step "Building Tendril ($REF) inside the container"
info "git clone → npm install → npm run compile → npm run build:$OS"
info "This takes a few minutes."

# The build script runs inside the container. Nothing is mounted: the app is
# copied out afterwards with `docker cp`, which works the same on every Docker
# setup (Docker Desktop, OrbStack, Colima, rootless, …).
BUILD='
set -euo pipefail
export ELECTRON_BUILDER_CACHE=/tmp/eb-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
echo "--> git clone $REPO ($REF)"
git clone --quiet --depth 1 --branch "$REF" "$REPO" /work
cd /work
echo "--> npm install"
npm install --loglevel=error
echo "--> npm run compile"
npm run compile
mkdir -p /out
if [ "$OS" = linux ]; then
  echo "--> npm run build:linux -- --$ARCH"
  npm run build:linux -- "--$ARCH" --publish never
  cp "$(ls dist/*.AppImage | head -n 1)" /out/
else
  # The unpacked .app, not the zip target: zipped on Linux, the Electron
  # framework loses its symlinks and macOS rejects the bundle. tar keeps them.
  echo "--> npm run build:mac -- --$ARCH --dir"
  npm run build:mac -- "--$ARCH" --dir --publish never
  tar -C "$(dirname "$(ls -d dist/mac*/Tendril.app | head -n 1)")" -czf /out/Tendril.app.tgz Tendril.app
fi
'

LOG="$WORK/build.log"
if ! docker run --name "$CONTAINER" --platform "$DOCKER_PLATFORM" \
  -e REPO="$REPO" -e REF="$REF" -e OS="$OS" -e ARCH="$ARCH" \
  "$IMAGE" bash -c "$BUILD" >"$LOG" 2>&1; then
  printf '\n%s--- last lines of the build log ---%s\n' "$DIM" "$RESET" >&2
  tail -n 30 "$LOG" >&2
  fail "The build failed (see above)."
fi

docker cp "$CONTAINER:/out/." "$WORK/" >/dev/null

# ---- Install ------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

if [ "$OS" = linux ]; then
  artifact=$(ls "$WORK"/*.AppImage 2>/dev/null | head -n 1) || true
  [ -n "${artifact:-}" ] || fail "The build finished but produced no AppImage."
  target="$INSTALL_DIR/Tendril.AppImage"
  step "Installing $target"
  install -m 0755 "$artifact" "$target"

  # AppImages need FUSE 2 to start; say so now rather than on first launch.
  # (Captured first: `ldconfig -p | grep -q` fails under pipefail when grep exits early.)
  libs="$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true)"
  if [[ "$libs" != *libfuse.so.2* ]]; then
    warn "libfuse2 was not found; the AppImage needs it to start. On Debian/Ubuntu: sudo apt install -y libfuse2t64 (or libfuse2)."
  fi
  run_hint="$target"
else
  [ -f "$WORK/Tendril.app.tgz" ] || fail "The build finished but produced no app."
  target="$INSTALL_DIR/Tendril.app"
  step "Installing $target"
  unpacked="$WORK/app"
  mkdir -p "$unpacked"
  tar -xzf "$WORK/Tendril.app.tgz" -C "$unpacked"
  [ -d "$unpacked/Tendril.app" ] || fail "The build archive does not contain Tendril.app."
  rm -rf "$target"
  mv "$unpacked/Tendril.app" "$target"
  # Built on Linux, the app is unsigned; Apple Silicon refuses to run unsigned
  # code, so sign it ad hoc for this machine.
  codesign --force --deep --sign - "$target" >/dev/null 2>&1 || warn "ad-hoc signing failed; macOS may refuse to open the app."
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  run_hint="open \"$target\""
fi

printf '\n%sTendril is installed.%s\n' "$BOLD$GREEN" "$RESET"
info "Start it with:  $run_hint"
info "To uninstall, delete $target"
