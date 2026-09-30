#!/usr/bin/env bash
# Builds Work from this checkout and installs it for the current user:
# binary in ~/.local/bin, icons and a menu entry in ~/.local/share.
# Run it again after every update (git pull) to reinstall.
set -euo pipefail

cd "$(dirname "$0")/.."

BIN_DIR="$HOME/.local/bin"
SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"

echo "==> Dipendenze npm"
npm ci

echo "==> Toolchain Rust"
if command -v rustup >/dev/null; then
  rustup update stable --no-self-update
fi

echo "==> Build"
npx tauri build --no-bundle

echo "==> Installazione"
install -Dm755 src-tauri/target/release/work "$BIN_DIR/work"
install -Dm644 src-tauri/icons/32x32.png "$SHARE_DIR/icons/hicolor/32x32/apps/work.png"
install -Dm644 src-tauri/icons/128x128.png "$SHARE_DIR/icons/hicolor/128x128/apps/work.png"
install -Dm644 src-tauri/icons/128x128@2x.png "$SHARE_DIR/icons/hicolor/256x256/apps/work.png"

mkdir -p "$SHARE_DIR/applications"
cat > "$SHARE_DIR/applications/work.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Work
Comment=Terminali, git e agenti AI in un'unica dashboard
Exec=$BIN_DIR/work
Icon=work
Terminal=false
Categories=Development;
StartupWMClass=work
EOF

update-desktop-database "$SHARE_DIR/applications" 2>/dev/null || true
gtk-update-icon-cache -f -t "$SHARE_DIR/icons/hicolor" 2>/dev/null || true

echo "==> Work $(node -p "require('./package.json').version") installato in $BIN_DIR/work"
