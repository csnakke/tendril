#!/usr/bin/env bash
#
# Tendril installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash -s -- --uninstall
#
# Builds Tendril from source inside a throwaway Node container, so nothing but
# the finished app lands on this machine: no Node, no npm, no node_modules.
#
#   1. pull the Node image (only if it isn't here already)
#   2. in a container: get the source → npm install → npm run compile → npm run build:<os>
#   3. copy the app out of the container
#   4. remove the container, and the image if this script pulled it
#
# Result:  Linux  → ~/.local/share/tendril, with a launcher entry (app menu,
#                   favourites, panel) and a `tendril` command in ~/.local/bin
#          macOS  → ~/Applications/Tendril.app
#
# Needs: Docker (Docker Desktop, OrbStack, Colima, … on macOS) and curl.
#
# Options (environment variables):
#   TENDRIL_INSTALL_DIR  folder the app goes in       (default: Linux ~/.local/share, macOS ~/Applications)
#   TENDRIL_REPO         git URL or local folder      (default: https://github.com/csnakke/tendril.git)
#   TENDRIL_REF          branch or tag to build       (default: main; ignored for a local folder)
#   TENDRIL_NODE_IMAGE   Node image used for building (default: node:22-bookworm)
#   TENDRIL_PIN          1 = pin to the GNOME dock    (default: 1; Linux only)

set -euo pipefail

REPO="${TENDRIL_REPO:-https://github.com/csnakke/tendril.git}"
REF="${TENDRIL_REF:-main}"
IMAGE="${TENDRIL_NODE_IMAGE:-node:22-bookworm}"
PIN="${TENDRIL_PIN:-1}"

ACTION=install
case "${1:-}" in
  '') ;;
  --uninstall) ACTION=uninstall ;;
  -h | --help) sed -n '2,/^$/s/^# \{0,1\}//p' "$0" 2>/dev/null || true; exit 0 ;;
  *) printf 'Unknown option: %s (use --uninstall, or no option to install)\n' "$1" >&2; exit 2 ;;
esac

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

# Everything is installed for the current user; under sudo it would land in
# root's home and the launcher entry would be root's, not yours.
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  fail "Run the installer as your normal user, without sudo. It asks for sudo itself if it needs it."
fi

# ---- Linux locations ------------------------------------------------------------

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
if [ "$OS" = linux ]; then
  INSTALL_DIR="${TENDRIL_INSTALL_DIR:-$DATA_HOME}"
  APP_ROOT="$INSTALL_DIR/tendril"            # launcher + app/ (the Electron build)
  DESKTOP_FILE="$DATA_HOME/applications/tendril.desktop"
  ICON_THEME="$DATA_HOME/icons/hicolor"
  BIN_LINK="$HOME/.local/bin/tendril"
  # Root-owned copy of Electron's setuid sandbox helper, used only where the
  # kernel refuses unprivileged user namespaces (see the launcher below).
  HELPER_DIR=/usr/local/lib/tendril
  HELPER="$HELPER_DIR/chrome-sandbox"
else
  INSTALL_DIR="${TENDRIL_INSTALL_DIR:-$HOME/Applications}"
fi

# Run a command as root: directly when already root, otherwise via sudo/doas.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  elif command -v doas >/dev/null 2>&1; then doas "$@"
  else return 1
  fi
}

# GNOME (and Ubuntu's dock) keep their favourites in one gsettings key.
gnome_favorites() {
  command -v gsettings >/dev/null 2>&1 || return 1
  gsettings list-keys org.gnome.shell 2>/dev/null | grep -qx favorite-apps || return 1
  gsettings get org.gnome.shell favorite-apps 2>/dev/null
}

uninstall_linux() {
  local removed=0
  if [ -x "$APP_ROOT/app/tendril" ]; then
    rm -rf "$APP_ROOT"; info "removed $APP_ROOT"; removed=1
  fi
  if [ -L "$BIN_LINK" ]; then rm -f "$BIN_LINK"; info "removed $BIN_LINK"; fi
  if [ -f "$DESKTOP_FILE" ]; then rm -f "$DESKTOP_FILE"; info "removed $DESKTOP_FILE"; removed=1; fi
  local icon
  for icon in "$ICON_THEME"/*/apps/tendril.png; do
    if [ -f "$icon" ]; then rm -f "$icon"; fi
  done
  # Left behind by installs from before Tendril dropped the AppImage.
  rm -f "$HOME/Applications/Tendril.AppImage"
  local favs
  if favs="$(gnome_favorites)" && [[ "$favs" == *"'tendril.desktop'"* ]]; then
    favs="$(printf '%s' "$favs" | sed "s/, 'tendril.desktop'//; s/'tendril.desktop', //; s/'tendril.desktop'//")"
    gsettings set org.gnome.shell favorite-apps "$favs" 2>/dev/null || true
  fi
  if [ -e "$HELPER" ]; then
    info "removing $HELPER_DIR (needs sudo)"
    as_root rm -rf "$HELPER_DIR" || warn "could not remove $HELPER_DIR; remove it with: sudo rm -rf $HELPER_DIR"
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA_HOME/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$ICON_THEME" 2>/dev/null || true
  [ "$removed" = 1 ] || info "Tendril was not installed in $APP_ROOT."
}

if [ "$ACTION" = uninstall ]; then
  step "Uninstalling Tendril"
  if [ "$OS" = linux ]; then
    uninstall_linux
  else
    if [ -d "$INSTALL_DIR/Tendril.app" ]; then rm -rf "$INSTALL_DIR/Tendril.app"; info "removed $INSTALL_DIR/Tendril.app"
    else info "Tendril was not installed in $INSTALL_DIR."; fi
  fi
  printf '\n%sDone.%s Your settings are kept; Tendril only removed the app.\n' "$BOLD$GREEN" "$RESET"
  exit 0
fi

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

if [ -d "$REPO" ]; then
  step "Building Tendril (local folder $REPO) inside the container"
else
  step "Building Tendril ($REF) inside the container"
fi
info "npm install → npm run compile → npm run build:$OS"
info "This takes a few minutes."

# The build script runs inside the container. Nothing is mounted: source and
# app are copied in and out with `docker cp`, which works the same on every
# Docker setup (Docker Desktop, OrbStack, Colima, rootless, …).
BUILD='
set -euo pipefail
export ELECTRON_BUILDER_CACHE=/tmp/eb-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
if [ ! -d /work ]; then
  echo "--> git clone $REPO ($REF)"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" /work
fi
cd /work
echo "--> npm install"
npm install --loglevel=error
echo "--> npm run compile"
npm run compile
mkdir -p /out
if [ "$OS" = linux ]; then
  echo "--> npm run build:linux -- --$ARCH"
  npm run build:linux -- "--$ARCH" --publish never
  tar -C "$(ls -d dist/linux*-unpacked | head -n 1)" -czf /out/tendril-linux.tgz .
  # Launcher icons. The base image normally has ImageMagick; without it the
  # full-size icon is installed and desktops scale it themselves.
  mkdir -p /out/icons
  cp icons/icon.png /out/icons/1024.png
  if command -v convert >/dev/null 2>&1; then
    for size in 512 256 128 64 48 32; do
      convert icons/icon.png -resize "${size}x${size}" "/out/icons/$size.png" || true
    done
  fi
else
  # The unpacked .app, not the zip target: zipped on Linux, the Electron
  # framework loses its symlinks and macOS rejects the bundle. tar keeps them.
  echo "--> npm run build:mac -- --$ARCH --dir"
  npm run build:mac -- "--$ARCH" --dir --publish never
  tar -C "$(dirname "$(ls -d dist/mac*/Tendril.app | head -n 1)")" -czf /out/Tendril.app.tgz Tendril.app
fi
'

docker create --name "$CONTAINER" --platform "$DOCKER_PLATFORM" \
  -e REPO="$REPO" -e REF="$REF" -e OS="$OS" -e ARCH="$ARCH" \
  "$IMAGE" bash -c "$BUILD" >/dev/null

# A local folder is copied in as it is on disk (uncommitted changes included),
# minus anything built on this machine.
if [ -d "$REPO" ]; then
  mkdir "$WORK/src"
  tar -C "$REPO" --exclude=node_modules --exclude=out --exclude=dist --exclude=.git -cf - . | tar -C "$WORK/src" -xf -
  docker cp "$WORK/src" "$CONTAINER:/work" >/dev/null
fi

LOG="$WORK/build.log"
if ! docker start -a "$CONTAINER" >"$LOG" 2>&1; then
  printf '\n%s--- last lines of the build log ---%s\n' "$DIM" "$RESET" >&2
  tail -n 30 "$LOG" >&2
  fail "The build failed (see above)."
fi

docker cp "$CONTAINER:/out/." "$WORK/" >/dev/null

# ---- Install: Linux -----------------------------------------------------------

# Started by the launcher entry and by `tendril` on the PATH. It picks the
# Electron sandbox at every start, so a kernel or distro setting that changes
# later (an upgrade that restricts user namespaces, say) never stops the app.
LAUNCHER='#!/bin/sh
# Tendril launcher, written by install.sh. Reinstalling rewrites it.
#
# Electron sandboxes its renderers with unprivileged user namespaces, or, where
# the kernel refuses those (Ubuntu 24.04+ AppArmor, hardened kernels, some
# RHEL setups), with a setuid-root helper. Use whichever works here.
here=$(dirname "$(readlink -f "$0")")
helper=/usr/local/lib/tendril/chrome-sandbox

userns_ok() {
  for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces; do
    [ -r "$f" ] && [ "$(cat "$f")" = 0 ] && return 1
  done
  f=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  [ -r "$f" ] && [ "$(cat "$f")" = 1 ] && return 1
  if command -v unshare >/dev/null 2>&1; then
    unshare -Ur true >/dev/null 2>&1 || return 1
  fi
  return 0
}

helper_ok() {
  [ -u "$helper" ] && [ "$(stat -c %u "$helper" 2>/dev/null)" = 0 ]
}

case "${1:-}" in
  --check-sandbox) userns_ok; exit ;;
esac

if userns_ok; then
  exec "$here/app/tendril" "$@"
elif helper_ok; then
  CHROME_DEVEL_SANDBOX=$helper exec "$here/app/tendril" "$@"
fi

msg="Tendril is running without its sandbox: this system blocks user namespaces and the sandbox helper is not set up. Run the Tendril installer again to set it up."
echo "tendril: $msg" >&2
command -v notify-send >/dev/null 2>&1 && notify-send -i tendril "Tendril" "$msg" 2>/dev/null
exec "$here/app/tendril" --no-sandbox "$@"
'

# Desktop Entry spec: inside a quoted Exec argument " ` $ \ are escaped with a
# backslash, then every backslash is doubled again as a string value, and %
# is written %%. A path with a newline in it cannot be written down at all.
desktop_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')"
}

install_linux() {
  local tgz="$WORK/tendril-linux.tgz"
  [ -f "$tgz" ] || fail "The build finished but produced no app."
  case "$APP_ROOT" in *$'\n'*) fail "The install folder's path contains a newline: $APP_ROOT" ;; esac

  step "Installing $APP_ROOT"
  mkdir -p "$INSTALL_DIR"
  local staged="$APP_ROOT.new.$$"
  rm -rf "$staged"
  mkdir -p "$staged/app"
  tar -xzf "$tgz" -C "$staged/app"
  [ -x "$staged/app/tendril" ] || { rm -rf "$staged"; fail "The build archive does not contain the tendril binary."; }
  printf '%s' "$LAUNCHER" >"$staged/tendril"
  chmod 0755 "$staged/tendril"
  rm -rf "$APP_ROOT"
  mv "$staged" "$APP_ROOT"
  local launcher="$APP_ROOT/tendril"

  # Command on the PATH. Never clobber a real file someone else put there.
  mkdir -p "$(dirname "$BIN_LINK")"
  if [ -L "$BIN_LINK" ] || [ ! -e "$BIN_LINK" ]; then
    ln -sfn "$launcher" "$BIN_LINK"
  else
    warn "$BIN_LINK exists and is not Tendril's; left it alone."
  fi

  step "Adding Tendril to the app menu"
  local size icon
  for icon in "$WORK"/icons/*.png; do
    size="$(basename "$icon" .png)"
    mkdir -p "$ICON_THEME/${size}x${size}/apps"
    install -m 0644 "$icon" "$ICON_THEME/${size}x${size}/apps/tendril.png"
  done
  # 1024x1024 is missing from older icon themes; make sure 512x512 exists.
  if [ ! -f "$ICON_THEME/512x512/apps/tendril.png" ]; then
    mkdir -p "$ICON_THEME/512x512/apps"
    install -m 0644 "$WORK/icons/1024.png" "$ICON_THEME/512x512/apps/tendril.png"
  fi

  mkdir -p "$(dirname "$DESKTOP_FILE")"
  local exec
  exec="$(desktop_quote "$launcher")"
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Tendril
GenericName=Markdown Editor
Comment=Markdown editor with a Word-like table of contents
Exec=$exec %F
Icon=tendril
Terminal=false
Categories=Office;TextEditor;
MimeType=text/markdown;
Keywords=markdown;notes;editor;report;
StartupNotify=true
StartupWMClass=tendril
EOF
  chmod 0644 "$DESKTOP_FILE"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true
  # A stale icon-theme.cache hides new icons; rebuild it or force a rescan.
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f -t "$ICON_THEME" 2>/dev/null || true
  fi
  touch "$ICON_THEME" 2>/dev/null || true

  local favs
  if [ "$PIN" = 1 ] && favs="$(gnome_favorites)"; then
    case "$favs" in
      *"'tendril.desktop'"*) ;;
      '@as []' | '[]') gsettings set org.gnome.shell favorite-apps "['tendril.desktop']" 2>/dev/null || true ;;
      *) gsettings set org.gnome.shell favorite-apps "${favs%]}, 'tendril.desktop']" 2>/dev/null || true ;;
    esac
    info "pinned to the GNOME dock"
  fi

  # Left behind by installs from before Tendril dropped the AppImage.
  if [ -f "$HOME/Applications/Tendril.AppImage" ]; then
    rm -f "$HOME/Applications/Tendril.AppImage"
    info "removed the old ~/Applications/Tendril.AppImage"
  fi

  step "Checking Electron's sandbox"
  if "$launcher" --check-sandbox; then
    info "user namespaces are available: sandbox works without extra setup"
    # A helper from an earlier install would be stale; refresh it if it is there.
    [ -e "$HELPER" ] || return 0
  else
    info "this system blocks unprivileged user namespaces, so Electron needs its"
    info "setuid sandbox helper. Installing it as $HELPER (asks for sudo once)."
  fi
  if as_root mkdir -p "$HELPER_DIR" && as_root install -o 0 -g 0 -m 4755 "$APP_ROOT/app/chrome-sandbox" "$HELPER" \
    && [ -u "$HELPER" ]; then
    info "sandbox helper installed"
  else
    warn "could not install the sandbox helper. Tendril still starts, but without its sandbox;
    run the installer again with sudo available to fix that."
  fi
}

# ---- Install: macOS -----------------------------------------------------------

install_mac() {
  [ -f "$WORK/Tendril.app.tgz" ] || fail "The build finished but produced no app."
  local target="$INSTALL_DIR/Tendril.app"
  step "Installing $target"
  mkdir -p "$INSTALL_DIR"
  local unpacked="$WORK/app"
  mkdir -p "$unpacked"
  tar -xzf "$WORK/Tendril.app.tgz" -C "$unpacked"
  [ -d "$unpacked/Tendril.app" ] || fail "The build archive does not contain Tendril.app."
  rm -rf "$target"
  mv "$unpacked/Tendril.app" "$target"
  # Built on Linux, the app is unsigned; Apple Silicon refuses to run unsigned
  # code, so sign it ad hoc for this machine.
  codesign --force --deep --sign - "$target" >/dev/null 2>&1 || warn "ad-hoc signing failed; macOS may refuse to open the app."
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
}

if [ "$OS" = linux ]; then
  install_linux
  printf '\n%sTendril is installed.%s\n' "$BOLD$GREEN" "$RESET"
  info "Start it from your app menu (search \"Tendril\"); right-click it there to add it to"
  info "favourites or pin it to the panel. From a terminal: tendril"
  case ":$PATH:" in *":$(dirname "$BIN_LINK"):"*) ;; *) info "(add $(dirname "$BIN_LINK") to your PATH for the tendril command)" ;; esac
else
  install_mac
  printf '\n%sTendril is installed.%s\n' "$BOLD$GREEN" "$RESET"
  info "Start it with:  open \"$INSTALL_DIR/Tendril.app\""
fi
info "To uninstall:   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash -s -- --uninstall"
