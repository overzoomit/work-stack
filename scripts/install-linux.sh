#!/usr/bin/env bash
# Builds Work from this checkout and installs it for the current user:
# binary in ~/.local/bin, icons and a menu entry in ~/.local/share.
# Run it again after every update (git pull) to reinstall.
set -euo pipefail

if [ "$(uname)" != Linux ]; then
  echo "install-linux.sh: solo per Linux (su macOS usa il .dmg)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

BIN_DIR="$HOME/.local/bin"
SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"

echo "==> Dipendenze npm"
npm ci

echo "==> Build"
npx tauri build --no-bundle

echo "==> Installazione"
install -Dm755 src-tauri/target/release/work "$BIN_DIR/work"
install -Dm755 scripts/plane-cli.py "$BIN_DIR/plane"
install -Dm755 scripts/tmux-dogwatch.py "$BIN_DIR/dogwatch"
install -Dm755 scripts/telegram-pm.py "$BIN_DIR/telegram-pm"

# Compatibilità legacy per ambienti con script in ~/.claude/scripts
if [ -d "$HOME/.claude/scripts" ]; then
  ln -sf "$BIN_DIR/plane" "$HOME/.claude/scripts/plane_cli.py"
fi

# Configurazione iniziale e seed portatile
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/it.overzoom.work"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
mkdir -p "$CONFIG_DIR"

SEED_FILE=""
for arg in "$@"; do
  if [ -f "$arg" ]; then
    SEED_FILE="$arg"
    break
  fi
done
if [ -z "$SEED_FILE" ] && [ -f "$HOME/.work-seed.json" ]; then
  SEED_FILE="$HOME/.work-seed.json"
fi

if [ -n "$SEED_FILE" ] && [ -f "$SEED_FILE" ]; then
  echo "==> Applicazione seed configurazione da $SEED_FILE"
  cp "$SEED_FILE" "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
fi

for s in 32 48 64 128 256 512; do
  install -Dm644 "src-tauri/icons/${s}x${s}.png" "$SHARE_DIR/icons/hicolor/${s}x${s}/apps/work.png"
done
install -Dm644 assets/icon-linux.svg "$SHARE_DIR/icons/hicolor/scalable/apps/work.svg"

mkdir -p "$SHARE_DIR/applications"
cat > "$SHARE_DIR/applications/work.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Work
Comment=Terminali, git e agenti AI in un'unica dashboard
Exec="$BIN_DIR/work"
Icon=work
Terminal=false
Categories=Development;
StartupWMClass=work
EOF

update-desktop-database "$SHARE_DIR/applications" 2>/dev/null || true
gtk-update-icon-cache -f -t "$SHARE_DIR/icons/hicolor" 2>/dev/null || true
kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null || true

echo "==> Work $(node -p "require('./package.json').version") installato in $BIN_DIR/work"
echo "==> CLI installate: $BIN_DIR/plane, $BIN_DIR/dogwatch, $BIN_DIR/telegram-pm"
