#!/usr/bin/env bash
#
# Tendril installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash -s -- --uninstall
#
# Builds Tendril from source, so nothing but the finished app is left on this
# machine: no Node, no npm, no node_modules.
#
# With Docker (the usual way):
#   1. pull the Node image (only if it isn't here already)
#   2. in a container: get the source → npm ci → npm run compile → npm run build:<os>
#   3. copy the app out of the container
#   4. remove the container, and the image if this script pulled it
#
# Without Docker (or with it stopped) it asks: get Docker and run this again,
# or build here — Node.js (official build, checksum-verified), the source,
# node_modules and every cache in a scratch folder that is deleted afterwards.
# On Linux the terminal's native module needs a C++ compiler, make and python3;
# if they are missing they are installed, and removing them again is offered.
#
# Result:  Linux  → ~/.local/share/tendril, with a launcher entry (app menu,
#                   favourites, panel) and a `tendril` command in ~/.local/bin
#          macOS  → ~/Applications/Tendril.app
#
# Needs: curl, and Docker for the usual way (Docker Desktop, OrbStack, Colima, … on macOS).
#
# Also installs on this machine (not in Docker), when missing, what the
# explorer's Remote section, its saved passwords and the terminal use: pass
# and gnupg, a full rsync, the OpenSSH client, tmux (the terminal runs in it)
# and a windowed pinentry (GPG's passphrase dialog). Linux uses the distribution's package manager (asks for sudo once);
# macOS uses Homebrew. Tendril sets up its own password store (its own GPG key
# and `pass init`, inside its data folder) the first time a secret is saved.
#
# Options (environment variables):
#   TENDRIL_INSTALL_DIR  folder the app goes in       (default: Linux ~/.local/share, macOS ~/Applications)
#   TENDRIL_REPO         git URL or local folder      (default: https://github.com/csnakke/tendril.git)
#   TENDRIL_REF          branch or tag to build       (default: main; ignored for a local folder)
#   TENDRIL_NODE_IMAGE   Node image used for building (default: node:22-bookworm)
#   TENDRIL_PIN          1 = pin to the GNOME dock    (default: 1; Linux only)
#   TENDRIL_SKIP_DEPS    1 = do not install pass, rsync, tmux, … on this machine
#   TENDRIL_IMPORT       a backup (.tendril) to import after a fresh install
#   TENDRIL_BUILD        docker or local: how to build, without asking

# Run as `curl … | bash`, bash reads this script from the same pipe that is
# its standard input, piece by piece. A command that reads standard input
# (brew does) would swallow the rest of the script, and bash would stop there
# without a word. The whole script is one { … } block, so bash has all of it
# before running any of it.
{

set -euo pipefail

REPO="${TENDRIL_REPO:-https://github.com/csnakke/tendril.git}"
REF="${TENDRIL_REF:-main}"
IMAGE="${TENDRIL_NODE_IMAGE:-node:22-bookworm}"
PIN="${TENDRIL_PIN:-1}"
SKIP_DEPS="${TENDRIL_SKIP_DEPS:-0}"

# Printed by --help; it also works through curl | bash, where there is no file to read.
usage() {
  cat <<'USAGE'
Tendril installer for Linux and macOS

  curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash
      install, or update to the latest main
  … | bash -s -- --uninstall
      export the settings (offered), then remove every trace of Tendril
  … | bash -s -- --help
      this text

Switches (set them in front of bash: … | TENDRIL_BUILD=local bash):
  TENDRIL_BUILD        docker or local; default: Docker when it runs, else ask
  TENDRIL_REF          branch or tag to build (main)
  TENDRIL_REPO         git URL or local folder (https://github.com/csnakke/tendril.git)
  TENDRIL_INSTALL_DIR  folder the app goes in (Linux ~/.local/share, macOS ~/Applications)
  TENDRIL_NODE_IMAGE   image for a Docker build (node:22-bookworm)
  TENDRIL_PIN          1 = pin to the GNOME dock, 0 = don't (1)
  TENDRIL_SKIP_DEPS    1 = don't install pass, gnupg, rsync, ssh, pinentry, tmux
  TENDRIL_IMPORT       a .tendril backup to import after installing

After installing: tendril, tendril <file>, tendril --export <file>, tendril --import <file>
USAGE
}

ACTION=install
case "${1:-}" in
  '') ;;
  --uninstall) ACTION=uninstall ;;
  -h | --help) usage; exit 0 ;;
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

have() { command -v "$1" >/dev/null 2>&1; }

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

# Where Tendril keeps its own data (settings, session, themes, fonts, caches).
if [ "$OS" = linux ]; then
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Tendril"
  APP_BIN="$APP_ROOT/tendril"
else
  CONFIG_DIR="$HOME/Library/Application Support/Tendril"
  APP_BIN="$INSTALL_DIR/Tendril.app/Contents/MacOS/Tendril"
fi
PASS_STORE="${PASSWORD_STORE_DIR:-$HOME/.password-store}"

# A yes/no question on the terminal (works under curl | bash); without one, the default.
ask() {
  local answer=""
  if ! { : </dev/tty; } 2>/dev/null; then [ "$2" = y ]; return; fi
  printf '%s %s ' "$1" "$([ "$2" = y ] && echo '[Y/n]' || echo '[y/N]')" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "${answer:-$2}" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

tendril_running() {
  if [ "$OS" = linux ]; then pgrep -f "$APP_ROOT/app/tendril" >/dev/null 2>&1; else pgrep -x Tendril >/dev/null 2>&1; fi
}

# Everything of Tendril's on this machine that exists, one path per line.
# pass, gnupg, rsync, ssh, tmux and Docker are not Tendril's and stay; so do your own
# notes, a templates folder you chose, and ~/.ssh.
tendril_traces() {
  local p
  if [ "$OS" = linux ]; then
    for p in "$APP_ROOT" "$DESKTOP_FILE" "$CONFIG_DIR" "${XDG_CACHE_HOME:-$HOME/.cache}/Tendril" \
      "${XDG_STATE_HOME:-$HOME/.local/state}/Tendril" "$HOME/Applications/Tendril.AppImage"; do
      [ -e "$p" ] && printf '%s\n' "$p"
    done
    [ -L "$BIN_LINK" ] && printf '%s\n' "$BIN_LINK"
    for p in "$ICON_THEME"/*/apps/tendril.png; do [ -f "$p" ] && printf '%s\n' "$p"; done
    [ -e "$HELPER_DIR" ] && printf '%s\n' "$HELPER_DIR"
  else
    for p in "$INSTALL_DIR/Tendril.app" "$CONFIG_DIR" "$HOME/Library/Caches/Tendril" "$HOME/Library/Caches/dev.csnakke.tendril" \
      "$HOME/Library/Caches/dev.csnakke.tendril.ShipIt" "$HOME/Library/Preferences/dev.csnakke.tendril.plist" \
      "$HOME/Library/Saved Application State/dev.csnakke.tendril.savedState" "$HOME/Library/Logs/Tendril" \
      "$HOME/Library/HTTPStorages/dev.csnakke.tendril"; do
      [ -e "$p" ] && printf '%s\n' "$p"
    done
  fi
  for p in "${XDG_RUNTIME_DIR:-/nonexistent}/tendril" "/tmp/tendril-$(id -u)"; do [ -e "$p" ] && printf '%s\n' "$p"; done
  [ -d "$PASS_STORE/tendril" ] && printf '%s\n' "$PASS_STORE/tendril (saved SSH keys and passwords, in pass)"
  return 0
}

# The thumbnails the old AppImage builds wrote for themselves (named after the file's URI).
appimage_thumbnails() {
  local uri hash d cache="${XDG_CACHE_HOME:-$HOME/.cache}/thumbnails"
  uri="file://$HOME/Applications/Tendril.AppImage"
  hash="$(printf '%s' "$uri" | md5sum 2>/dev/null | cut -d' ' -f1)" || return 0
  [ -n "$hash" ] || return 0
  for d in normal large x-large xx-large fail/gnome-thumbnail-factory; do rm -f "$cache/$d/$hash.png"; done
}

uninstall() {
  if tendril_running; then
    ask "Tendril is running. Close it now (open tabs are kept for next time)?" y || fail "Close Tendril, then run the uninstaller again."
    if [ "$OS" = linux ]; then pkill -f "$APP_ROOT/app/tendril" || true; else osascript -e 'quit app "Tendril"' >/dev/null 2>&1 || pkill -x Tendril || true; fi
    sleep 2
  fi

  # 1. A backup first, so a fresh install can bring everything back.
  if [ -x "$APP_BIN" ] && [ -f "$CONFIG_DIR/settings.json" ]; then
    if ask "Export your Tendril settings before removing them?" y; then
      local backup
      backup="$HOME/tendril-backup-$(date +%Y-%m-%d).tendril"
      if "$APP_BIN" --export "$backup" 2>/dev/null; then
        info "To restore it after a fresh install, answer the installer's import question, or run: tendril --import \"$backup\""
      else
        warn "the export failed."
        ask "Uninstall anyway?" n || fail "Nothing was removed."
      fi
    fi
  fi

  local traces
  traces="$(tendril_traces)"
  if [ -z "$traces" ] && [ ! -x "$APP_BIN" ]; then
    info "Tendril is not installed here, and nothing of it is left."
    return 0
  fi
  step "This removes:"
  [ -n "$traces" ] && printf '%s\n' "$traces" | sed 's/^/    /'
  info "and the graph markers (.tendril/) Tendril put in your folders."
  [ "$OS" = linux ] && info "and Tendril's launcher entry, icons and GNOME dock pin."
  ask "Remove all of this?" y || fail "Nothing was removed."

  # 2. Graph markers in your folders: only the ones Tendril recorded.
  if [ -x "$APP_BIN" ]; then
    "$APP_BIN" --remove-graph-markers 2>/dev/null | sed 's/^/    /' || warn "could not remove the graph markers; delete the .tendril folders yourself."
  fi

  # 3. Tendril's entries in pass (the rest of the store is untouched).
  if [ -d "$PASS_STORE/tendril" ]; then
    if have pass; then pass rm --recursive --force tendril >/dev/null 2>&1 || rm -rf "${PASS_STORE:?}/tendril"; else rm -rf "${PASS_STORE:?}/tendril"; fi
    info "removed Tendril's saved keys and passwords from pass"
  fi

  # 4. The app, its data and everything around it. Tendril's own password store
  #    and GPG key live in its data folder; its gpg-agent is stopped first.
  if have gpgconf && [ -d "$CONFIG_DIR/gnupg" ]; then
    GNUPGHOME="$CONFIG_DIR/gnupg" gpgconf --kill gpg-agent >/dev/null 2>&1 || true
    GNUPGHOME="$CONFIG_DIR/gnupg" gpgconf --remove-socketdir >/dev/null 2>&1 || true
  fi
  if [ "$OS" = linux ]; then
    local favs
    if favs="$(gnome_favorites)" && [[ "$favs" == *"'tendril.desktop'"* ]]; then
      favs="$(printf '%s' "$favs" | sed "s/, 'tendril.desktop'//; s/'tendril.desktop', //; s/'tendril.desktop'//")"
      gsettings set org.gnome.shell favorite-apps "$favs" 2>/dev/null || true
    fi
    rm -rf "${APP_ROOT:?}" "${CONFIG_DIR:?}" "${XDG_CACHE_HOME:-$HOME/.cache}/Tendril" "${XDG_STATE_HOME:-$HOME/.local/state}/Tendril"
    rm -f "$DESKTOP_FILE" "$HOME/Applications/Tendril.AppImage"
    [ -L "$BIN_LINK" ] && rm -f "$BIN_LINK"
    local icon
    for icon in "$ICON_THEME"/*/apps/tendril.png; do
      if [ -f "$icon" ]; then rm -f "$icon"; fi
    done
    # Size folders the installer made: only removed when nothing else's icon is in them.
    local d
    for d in "$ICON_THEME"/*/apps; do rmdir "$d" "$(dirname "$d")" 2>/dev/null || true; done
    appimage_thumbnails
    if [ -e "$HELPER_DIR" ]; then
      info "removing $HELPER_DIR (needs sudo)"
      as_root rm -rf "$HELPER_DIR" || warn "could not remove $HELPER_DIR; remove it with: sudo rm -rf $HELPER_DIR"
    fi
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA_HOME/applications" 2>/dev/null || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$ICON_THEME" 2>/dev/null || true
  else
    rm -rf "$INSTALL_DIR/Tendril.app" "${CONFIG_DIR:?}" "$HOME/Library/Caches/Tendril" "$HOME/Library/Caches/dev.csnakke.tendril" \
      "$HOME/Library/Caches/dev.csnakke.tendril.ShipIt" "$HOME/Library/Saved Application State/dev.csnakke.tendril.savedState" \
      "$HOME/Library/Logs/Tendril" "$HOME/Library/HTTPStorages/dev.csnakke.tendril"
    defaults delete dev.csnakke.tendril >/dev/null 2>&1 || true
    rm -f "$HOME/Library/Preferences/dev.csnakke.tendril.plist"
  fi
  rm -rf "${XDG_RUNTIME_DIR:-/nonexistent}/tendril" "/tmp/tendril-$(id -u)"

  local left
  left="$(tendril_traces)"
  [ -z "$left" ] || warn "these could not be removed:
$left"
}

if [ "$ACTION" = uninstall ]; then
  step "Uninstalling Tendril"
  uninstall
  printf '\n%sDone.%s Tendril and its configuration are gone. pass, gnupg, rsync, ssh and tmux are left as they were.\n' "$BOLD$GREEN" "$RESET"
  exit 0
fi

# ---- Prerequisites on this machine ---------------------------------------------
# The Remote section runs the system's own ssh, rsync and pass. Only what is
# missing is installed; nothing already there is touched.


# rsync 3.1 or newer, and not macOS's openrsync: resume and progress need it.
full_rsync() {
  local v
  v="$("$1" --version 2>/dev/null | head -n 1)" || return 1
  [[ "$v" != *openrsync* && "$v" =~ ^rsync\ +version\ +v?([0-9]+)\.([0-9]+) ]] || return 1
  [ "${BASH_REMATCH[1]}" -gt 3 ] || { [ "${BASH_REMATCH[1]}" -eq 3 ] && [ "${BASH_REMATCH[2]}" -ge 1 ]; }
}

# A pinentry that draws a window: Tendril has no terminal for GPG to ask in.
gui_pinentry() {
  local p
  for p in pinentry-mac pinentry-gnome3 pinentry-qt pinentry-qt5 pinentry-gtk-2 pinentry-gtk pinentry-gnome; do
    if have "$p"; then command -v "$p"; return 0; fi
  done
  return 1
}

# Point gpg-agent at the windowed pinentry, unless it is configured already.
use_gui_pinentry() {
  local pin conf="$HOME/.gnupg/gpg-agent.conf" current
  pin="$(gui_pinentry)" || return 0
  [ -f "$conf" ] && grep -q '^[[:space:]]*pinentry-program' "$conf" && return 0
  # The distribution's default may already be a windowed one.
  current="$(readlink -f "$(command -v pinentry 2>/dev/null || echo /nonexistent)" 2>/dev/null || true)"
  if [ "$OS" = linux ] && [ -n "$current" ] && [[ "$current" != *curses* && "$current" != *tty* ]]; then return 0; fi
  mkdir -p "$HOME/.gnupg" && chmod 700 "$HOME/.gnupg"
  printf 'pinentry-program %s\n' "$pin" >>"$conf"
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  info "gpg-agent now asks for your GPG passphrase with $(basename "$pin")"
}

install_deps_linux() {
  local missing=() pkgs=() pm=""
  have pass || missing+=(pass)
  have gpg || have gpg2 || missing+=(gnupg)
  if ! have rsync || ! full_rsync rsync; then missing+=(rsync); fi
  { have ssh && have ssh-agent && have ssh-add && have sftp; } || missing+=(ssh)
  gui_pinentry >/dev/null || missing+=(pinentry)
  have tmux || missing+=(tmux)
  [ "${#missing[@]}" -eq 0 ] && { info "pass, gnupg, rsync, ssh, pinentry and tmux are already installed."; return 0; }

  for c in apt-get dnf pacman zypper apk; do have "$c" && { pm="$c"; break; }; done
  local kde=0
  [[ "${XDG_CURRENT_DESKTOP:-}" == *KDE* ]] && kde=1
  local m
  for m in "${missing[@]}"; do
    case "$pm:$m" in
      apt-get:pass | dnf:pass | pacman:pass | apk:pass) pkgs+=(pass) ;;
      zypper:pass) pkgs+=(password-store) ;;
      apt-get:gnupg | pacman:gnupg | apk:gnupg) pkgs+=(gnupg) ;;
      dnf:gnupg) pkgs+=(gnupg2) ;;
      zypper:gnupg) pkgs+=(gpg2) ;;
      *:rsync) pkgs+=(rsync) ;;
      *:tmux) pkgs+=(tmux) ;;
      apt-get:ssh | apk:ssh) pkgs+=(openssh-client) ;;
      dnf:ssh | zypper:ssh) pkgs+=(openssh-clients) ;;
      pacman:ssh) pkgs+=(openssh) ;;
      pacman:pinentry) pkgs+=(pinentry) ;;
      apk:pinentry) pkgs+=(pinentry-gnome) ;;
      zypper:pinentry) [ "$kde" = 1 ] && pkgs+=(pinentry-qt5) || pkgs+=(pinentry-gnome3) ;;
      *:pinentry) [ "$kde" = 1 ] && pkgs+=(pinentry-qt) || pkgs+=(pinentry-gnome3) ;;
    esac
  done
  if [ -z "$pm" ]; then
    warn "Install these yourself for the Remote section, saved passwords and the terminal's tmux: ${missing[*]}"
    return 0
  fi
  step "Installing ${pkgs[*]} (${pm}, asks for sudo once)"
  local ok=1
  case "$pm" in
    apt-get) as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}" || ok=0 ;;
    dnf) as_root dnf install -y -q "${pkgs[@]}" || ok=0 ;;
    pacman) as_root pacman -S --needed --noconfirm "${pkgs[@]}" || ok=0 ;;
    zypper) as_root zypper --non-interactive install "${pkgs[@]}" || ok=0 ;;
    apk) as_root apk add "${pkgs[@]}" || ok=0 ;;
  esac
  # RHEL and its clones ship pass in EPEL only.
  [ "$ok" = 1 ] || warn "could not install ${pkgs[*]}. Install them yourself (on RHEL-like systems pass is in EPEL); Tendril still installs."
}

install_deps_mac() {
  local brew=""
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { brew="$b"; break; }; done
  have brew && brew="$(command -v brew)"
  local pkgs=()
  local prefix=""
  [ -n "$brew" ] && prefix="$("$brew" --prefix)"
  full_rsync "${prefix:-/nonexistent}/bin/rsync" || pkgs+=(rsync)
  have pass || pkgs+=(pass)
  have pinentry-mac || [ -x "${prefix:-/nonexistent}/bin/pinentry-mac" ] || pkgs+=(pinentry-mac)
  have tmux || [ -x "${prefix:-/nonexistent}/bin/tmux" ] || pkgs+=(tmux)
  [ "${#pkgs[@]}" -eq 0 ] && { info "rsync, pass, pinentry-mac and tmux are already installed (ssh is built into macOS)."; return 0; }
  if [ -z "$brew" ]; then
    fail "Homebrew is needed to install ${pkgs[*]} (Tendril's Remote section and saved passwords use them).
    Install Homebrew first:
      /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
    then run this installer again. (Or skip them: TENDRIL_SKIP_DEPS=1.)"
  fi
  step "Installing ${pkgs[*]} with Homebrew"
  "$brew" install "${pkgs[@]}" </dev/null || warn "brew could not install ${pkgs[*]}; install them yourself for the Remote section and the terminal's tmux."
  export PATH="$prefix/bin:$PATH"
}

if [ "$SKIP_DEPS" != 1 ]; then
  printf '\n%sPrerequisites%s  %s(on this machine: pass, gnupg, rsync, ssh, pinentry, tmux)%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  if [ "$OS" = linux ]; then install_deps_linux; else install_deps_mac; fi
  have gpgconf && use_gui_pinentry
fi

# ---- Building on this machine (no Docker) -----------------------------------------
# Everything goes into the scratch folder ($WORK) and is deleted with it:
# Node.js, the source, node_modules, npm's, node-gyp's and Electron's caches
# and the build output. Only C++ build tools (Linux, for the terminal's native
# module) may have to be installed system-wide; the person is offered to
# remove exactly the ones this installer added.

sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# The official Node.js 22 build for this OS and CPU, checked against nodejs.org's SHA-256 list.
fetch_node() {
  local base="https://nodejs.org/dist/latest-v22.x" plat file sum
  case "$OS-$ARCH" in
    linux-x64) plat=linux-x64 ;; linux-arm64) plat=linux-arm64 ;;
    mac-x64) plat=darwin-x64 ;; mac-arm64) plat=darwin-arm64 ;;
  esac
  curl -fsSL "$base/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt" || fail "Could not reach nodejs.org to fetch Node.js."
  file="$(awk -v s="-$plat.tar.gz" 'substr($2, length($2) - length(s) + 1) == s { print $2; exit }' "$WORK/SHASUMS256.txt")"
  [ -n "$file" ] || fail "nodejs.org has no Node.js 22 build for $plat."
  sum="$(awk -v f="$file" '$2 == f { print $1 }' "$WORK/SHASUMS256.txt")"
  curl -fsSL "$base/$file" -o "$WORK/$file" || fail "Could not download $file."
  [ "$(sha256 "$WORK/$file")" = "$sum" ] || fail "$file does not match nodejs.org's checksum; not using it."
  mkdir -p "$WORK/node"
  tar -xzf "$WORK/$file" -C "$WORK/node" --strip-components=1
  rm -f "$WORK/$file" "$WORK/SHASUMS256.txt"
  info "Node.js $("$WORK/node/bin/node" --version) ($plat), checksum verified"
}

# The source into $WORK/src: a local folder as it is, a GitHub repository as its
# archive (no git needed), anything else with git.
fetch_source() {
  if [ -d "$REPO" ]; then
    copy_local_source "$WORK/src"
  elif [[ "$REPO" =~ ^https://github\.com/([^/]+)/([^/]+)/?$ ]]; then
    mkdir -p "$WORK/src"
    curl -fsSL "https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}/archive/$REF.tar.gz" | tar -xzf - -C "$WORK/src" --strip-components=1 ||
      fail "Could not download the source of $REPO ($REF)."
  elif have git; then
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$WORK/src" || fail "Could not clone $REPO ($REF)."
  else
    fail "git is needed to fetch $REPO."
  fi
}

# Linux compiles the terminal's native module (node-pty): a C++ compiler, make and python3.
ensure_build_tools() {
  [ "$OS" = linux ] || return 0
  if { have g++ || have c++; } && have make && have python3; then
    info "C++ compiler, make and python3 are already installed."
    return 0
  fi
  local pm="" wanted=() p
  for c in apt-get dnf pacman zypper apk; do have "$c" && { pm="$c"; break; }; done
  case "$pm" in
    apt-get) wanted=(build-essential python3) ;;
    dnf | zypper) wanted=(gcc gcc-c++ make python3) ;;
    pacman) wanted=(base-devel python) ;;
    apk) wanted=(build-base python3 linux-headers) ;;
    *) fail "A C++ compiler, make and python3 are needed to build here; install them and run this again." ;;
  esac
  TOOLS_PM="$pm"
  # Only what is not there yet: those are the ones offered for removal afterwards.
  for p in "${wanted[@]}"; do
    case "$pm" in
      apt-get) dpkg -s "$p" >/dev/null 2>&1 && continue ;;
      dnf | zypper) rpm -q "$p" >/dev/null 2>&1 && continue ;;
      pacman) pacman -Q "$p" >/dev/null 2>&1 && continue ;;
      apk) apk info -e "$p" >/dev/null 2>&1 && continue ;;
    esac
    TOOLS_ADDED+=("$p")
  done
  [ "${#TOOLS_ADDED[@]}" -gt 0 ] || return 0
  # apt keeps dependencies around; remember what was already removable, so only ours go later.
  [ "$pm" = apt-get ] && APT_ORPHANS_BEFORE="$(apt-get -s autoremove 2>/dev/null | awk '/^Remv/ { print $2 }' | sort)"
  step "Installing build tools: ${TOOLS_ADDED[*]} ($pm, asks for sudo)"
  case "$pm" in
    apt-get) as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${TOOLS_ADDED[@]}" ;;
    dnf) as_root dnf install -y -q "${TOOLS_ADDED[@]}" ;;
    pacman) as_root pacman -S --needed --noconfirm "${TOOLS_ADDED[@]}" ;;
    zypper) as_root zypper --non-interactive install "${TOOLS_ADDED[@]}" ;;
    apk) as_root apk add "${TOOLS_ADDED[@]}" ;;
  esac || { TOOLS_ADDED=(); fail "Could not install the build tools; install a C++ compiler, make and python3 yourself and run this again."; }
}

# Offered once, at the end (also after a failed build): remove exactly what ensure_build_tools added.
remove_build_tools() {
  [ "${#TOOLS_ADDED[@]}" -gt 0 ] || return 0
  local list=("${TOOLS_ADDED[@]}") extra
  TOOLS_ADDED=()
  if ! ask "Remove the build tools this installer added (${list[*]})?" y; then
    info "Kept: ${list[*]}"
    return 0
  fi
  case "$TOOLS_PM" in
    apt-get)
      as_root env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq "${list[@]}" >/dev/null || true
      # The dependencies they pulled in: newly removable now, and not removable before.
      extra="$(comm -13 <(printf '%s\n' "$APT_ORPHANS_BEFORE") <(apt-get -s autoremove 2>/dev/null | awk '/^Remv/ { print $2 }' | sort) | tr '\n' ' ')"
      # shellcheck disable=SC2086 # a list of package names
      [ -z "${extra// /}" ] || as_root env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq $extra >/dev/null || true
      ;;
    dnf) as_root dnf remove -y -q "${list[@]}" || true ;;
    pacman) as_root pacman -Rns --noconfirm "${list[@]}" || true ;;
    zypper) as_root zypper --non-interactive rm -u "${list[@]}" || true ;;
    apk) as_root apk del "${list[@]}" || true ;;
  esac
  info "removed ${list[*]}"
}

build_locally() {
  ensure_build_tools
  step "Fetching Node.js 22 (temporary, removed afterwards)"
  fetch_node
  if [ -d "$REPO" ]; then step "Using the local folder $REPO"; else step "Fetching the source ($REF)"; fi
  fetch_source
  step "Building Tendril on this machine"
  info "npm ci → npm run compile → npm run build:$OS"
  info "This takes a few minutes."
  (
    export PATH="$WORK/node/bin:$PATH" SRC="$WORK/src" OUT="$WORK" REPO REF OS ARCH \
      npm_config_cache="$WORK/npm-cache" npm_config_devdir="$WORK/node-gyp" \
      ELECTRON_CACHE="$WORK/electron-cache" electron_config_cache="$WORK/electron-cache" \
      ELECTRON_BUILDER_CACHE="$WORK/eb-cache" XDG_CACHE_HOME="$WORK/cache" CSC_IDENTITY_AUTO_DISCOVERY=false
    bash -c "$BUILD"
  ) >"$LOG" 2>&1 || build_failed
}

# ---- How to build: in Docker, or on this machine --------------------------------
# Docker keeps the machine clean by construction. Without it (or with it
# stopped) the person chooses: get Docker and run this again, or build here
# with a temporary Node.js and build tools that are removed afterwards.

docker_hint() {
  if [ "$OS" = mac ]; then
    printf '%s\n' "    Docker Desktop: https://www.docker.com/products/docker-desktop/" \
      "    or OrbStack:    brew install --cask orbstack" \
      "    or Colima:      brew install colima docker && colima start"
  elif ! have docker; then
    printf '%s\n' "    curl -fsSL https://get.docker.com | sh" \
      "    sudo usermod -aG docker \$USER     (then log out and back in)" \
      "    or your distribution's docker package: https://docs.docker.com/engine/install/"
  else
    printf '%s\n' "    sudo systemctl start docker" \
      "    and if it is not that: sudo usermod -aG docker \$USER (then log out and back in)"
  fi
}

BUILD_MODE="${TENDRIL_BUILD:-}"
case "$BUILD_MODE" in '' | docker | local) ;; *) fail "TENDRIL_BUILD must be docker or local (got $BUILD_MODE)." ;; esac
if [ -z "$BUILD_MODE" ]; then
  if have docker && docker info >/dev/null 2>&1; then
    BUILD_MODE=docker
  else
    if have docker; then why="Docker is installed but not running (or not reachable)."; first="Start Docker first"; else why="Docker is not installed."; first="Install Docker first"; fi
    if ! { : </dev/tty; } 2>/dev/null; then
      fail "$why Either get Docker going and run this again:
$(docker_hint)
    or build on this machine without Docker: TENDRIL_BUILD=local (temporary build tools, removed afterwards)."
    fi
    printf '\n%s%s%s How do you want to build Tendril?\n' "$BOLD" "$why" "$RESET" >/dev/tty
    printf '  1) %s   (stops here; run this command again afterwards)\n' "$first" >/dev/tty
    printf '  2) Build on this machine   (temporary Node.js and build tools, removed afterwards)\n' >/dev/tty
    choice=""
    while [ "$choice" != 1 ] && [ "$choice" != 2 ]; do
      printf 'Choose 1 or 2: ' >/dev/tty
      read -r choice </dev/tty || fail "No choice made; nothing was changed."
    done
    if [ "$choice" = 1 ]; then
      printf '\n%s:\n' "$first"
      docker_hint
      printf '\nThen run the same install command again.\n'
      exit 0
    fi
    BUILD_MODE=local
  fi
elif [ "$BUILD_MODE" = docker ] && ! { have docker && docker info >/dev/null 2>&1; }; then
  fail "TENDRIL_BUILD=docker, but Docker is not available:
$(docker_hint)"
fi

# The build runs natively on this machine's CPU; the app is built for that CPU too.
case "$ARCH" in
  x64) DOCKER_PLATFORM=linux/amd64 ;;
  arm64) DOCKER_PLATFORM=linux/arm64 ;;
esac

# ---- Cleanup ------------------------------------------------------------------
# Whatever happens, leave nothing behind: the scratch folder (with the local
# build's Node.js, sources, caches and output), the container, the image if
# this script pulled it, and build tools it installed if the person agrees.

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tendril-install.XXXXXX")"
CONTAINER="tendril-build-$$"
PULLED=0
TOOLS_ADDED=()
TOOLS_PM=""
APT_ORPHANS_BEFORE=""

cleanup() {
  local status=$?
  if [ "$BUILD_MODE" = docker ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ "$PULLED" = 1 ]; then
      step "Removing the build image ($IMAGE)"
      docker rmi "$IMAGE" >/dev/null 2>&1 || warn "could not remove $IMAGE; remove it with: docker rmi $IMAGE"
    fi
  fi
  rm -rf "$WORK"
  remove_build_tools
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- The build itself ------------------------------------------------------------
# The same script builds in the container (SRC=/work, OUT=/out) and on this
# machine (inside $WORK). It fetches the source unless SRC already holds it.

BUILD='
set -euo pipefail
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
if [ ! -d "$SRC" ]; then
  echo "--> git clone $REPO ($REF)"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC"
fi
cd "$SRC"
echo "--> npm ci"
if [ -f package-lock.json ]; then npm ci --loglevel=error; else npm install --loglevel=error; fi
echo "--> npm run compile"
npm run compile
mkdir -p "$OUT"
if [ "$OS" = linux ]; then
  echo "--> npm run build:linux -- --$ARCH"
  npm run build:linux -- "--$ARCH" --publish never
  tar -C "$(ls -d dist/linux*-unpacked | head -n 1)" -czf "$OUT/tendril-linux.tgz" .
  # Launcher icons. ImageMagick, where there is one, makes the smaller sizes;
  # without it the full-size icon is installed and desktops scale it themselves.
  mkdir -p "$OUT/icons"
  cp icons/icon.png "$OUT/icons/1024.png"
  if command -v convert >/dev/null 2>&1; then
    for size in 512 256 128 64 48 32; do
      convert icons/icon.png -resize "${size}x${size}" "$OUT/icons/$size.png" || true
    done
  fi
else
  # The unpacked .app, not the zip target: zipped on Linux, the Electron
  # framework loses its symlinks and macOS rejects the bundle. tar keeps them.
  echo "--> npm run build:mac -- --$ARCH --dir"
  npm run build:mac -- "--$ARCH" --dir --publish never
  tar -C "$(dirname "$(ls -d dist/mac*/Tendril.app | head -n 1)")" -czf "$OUT/Tendril.app.tgz" Tendril.app
fi
'

printf '\n%sTendril installer%s  %s(%s, %s, %s build)%s\n\n' "$BOLD" "$RESET" "$DIM" "$OS" "$ARCH" "$BUILD_MODE" "$RESET"

# A local folder's files as they are on disk (uncommitted changes included), minus build output.
copy_local_source() {
  mkdir -p "$1"
  tar -C "$REPO" --exclude=node_modules --exclude=out --exclude=dist --exclude=.git -cf - . | tar -C "$1" -xf -
}

LOG="$WORK/build.log"
build_failed() {
  printf '\n%s--- last lines of the build log ---%s\n' "$DIM" "$RESET" >&2
  tail -n 30 "$LOG" >&2
  fail "The build failed (see above)."
}

if [ "$BUILD_MODE" = docker ]; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    info "Using the $IMAGE image already on this machine (it will be kept)."
  else
    step "Pulling $IMAGE"
    PULLED=1
    docker pull --platform "$DOCKER_PLATFORM" "$IMAGE" >/dev/null
  fi
  if [ -d "$REPO" ]; then step "Building Tendril (local folder $REPO) inside the container"; else step "Building Tendril ($REF) inside the container"; fi
  info "npm ci → npm run compile → npm run build:$OS"
  info "This takes a few minutes."
  # Nothing is mounted: source and app are copied in and out with `docker cp`,
  # which works the same on every Docker setup (Docker Desktop, OrbStack, Colima, rootless, …).
  docker create --name "$CONTAINER" --platform "$DOCKER_PLATFORM" \
    -e REPO="$REPO" -e REF="$REF" -e OS="$OS" -e ARCH="$ARCH" -e SRC=/work -e OUT=/out -e ELECTRON_BUILDER_CACHE=/tmp/eb-cache \
    "$IMAGE" bash -c "$BUILD" >/dev/null
  if [ -d "$REPO" ]; then
    copy_local_source "$WORK/src"
    docker cp "$WORK/src" "$CONTAINER:/work" >/dev/null
  fi
  docker start -a "$CONTAINER" >"$LOG" 2>&1 || build_failed
  docker cp "$CONTAINER:/out/." "$WORK/" >/dev/null
else
  build_locally
fi

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
  # code, so sign it ad hoc for this machine. The terminal's native module and
  # its helper sit outside the bundle's code folders, where --deep does not look.
  # The helper must also be executable, or no shell can start.
  find "$target/Contents/Resources" -type f -name spawn-helper -exec chmod 755 {} \; 2>/dev/null || true
  find "$target/Contents/Resources" -type f \( -name '*.node' -o -name spawn-helper \) \
    -exec codesign --force --sign - {} \; >/dev/null 2>&1 || true
  codesign --force --deep --sign - "$target" >/dev/null 2>&1 || warn "ad-hoc signing failed; macOS may refuse to open the app."
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
}

# A fresh install (no settings yet) can start from a backup: the newest
# ~/tendril-backup-*.tendril, or a path given here or in TENDRIL_IMPORT.
offer_import() {
  [ -x "$APP_BIN" ] || return 0
  local file="${TENDRIL_IMPORT:-}" latest=""
  if [ -z "$file" ]; then
    [ -f "$CONFIG_DIR/settings.json" ] && return 0
    { : </dev/tty; } 2>/dev/null || return 0
    latest="$(ls -t "$HOME"/tendril-backup-*.tendril 2>/dev/null | head -n 1 || true)"
    if [ -n "$latest" ]; then
      ask "Import your Tendril backup $latest?" y && file="$latest"
    else
      printf 'Import a Tendril backup? Its path (Enter to skip): ' >/dev/tty
      read -r file </dev/tty || file=""
    fi
  fi
  [ -n "$file" ] || return 0
  file="${file/#\~/$HOME}"
  [ -f "$file" ] || { warn "no such file: $file"; return 0; }
  step "Importing $file"
  "$APP_BIN" --import "$file" 2>&1 | sed 's/^/    /' || warn "the import failed; try again later with: tendril --import \"$file\""
}

if [ "$OS" = linux ]; then
  install_linux
  offer_import
  printf '\n%sTendril is installed.%s\n' "$BOLD$GREEN" "$RESET"
  info "Start it from your app menu (search \"Tendril\"); right-click it there to add it to"
  info "favourites or pin it to the panel. From a terminal: tendril"
  case ":$PATH:" in *":$(dirname "$BIN_LINK"):"*) ;; *) info "(add $(dirname "$BIN_LINK") to your PATH for the tendril command)" ;; esac
else
  install_mac
  offer_import
  printf '\n%sTendril is installed.%s\n' "$BOLD$GREEN" "$RESET"
  info "Start it with:  open \"$INSTALL_DIR/Tendril.app\""
fi
info "To uninstall:   curl -fsSL https://raw.githubusercontent.com/csnakke/tendril/main/install.sh | bash -s -- --uninstall"

exit 0
}
