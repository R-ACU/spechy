#!/usr/bin/env bash
# Build Spechy from source and install it for the current user (Linux, Hyprland).
#   scripts/install-linux.sh            build release and install
#   scripts/install-linux.sh --no-build only reinstall the last build
# Needs: webkit2gtk-4.1, gtk-layer-shell, wl-clipboard, pipewire (pw-play), pactl,
# Rust (rustup) and Node. Global shortcuts need the input group.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
export PATH="$HOME/.cargo/bin:$PATH"

missing=()
for pkg in webkit2gtk-4.1 gtk-layer-shell wl-clipboard; do
    pacman -Q "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if ((${#missing[@]})); then
    echo "Missing packages: ${missing[*]}"
    echo "  sudo pacman -S --needed ${missing[*]}"
    exit 1
fi
if ! id -nG | grep -qw input; then
    echo "Note: you are not in the input group yet, global shortcuts will not work."
    echo "  sudo usermod -aG input $USER   (then log out and in again)"
fi

if [[ "${1:-}" != "--no-build" ]]; then
    cd "$ROOT"
    if [[ ! -d node_modules ]]; then
        # pnpm without a lockfile: package-lock.json stays the source of truth for Windows.
        if command -v npm >/dev/null; then npm install; else pnpm install --no-lockfile; fi
    fi
    ./node_modules/.bin/vite build
    cd src-tauri
    # custom-protocol embeds dist/; without it the binary loads devUrl (127.0.0.1:1433)
    # and shows "Could not connect" whenever Vite is not running.
    cargo build --release --features tauri/custom-protocol
fi

install -Dm755 "$ROOT/src-tauri/target/release/spechy" "$BIN/spechy"
install -Dm644 "$ROOT/src-tauri/icons/128x128.png" "$ICONS/128x128/apps/spechy.png"
install -Dm644 "$ROOT/src-tauri/icons/32x32.png" "$ICONS/32x32/apps/spechy.png"
mkdir -p "$APPS"
cat >"$APPS/spechy.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Spechy
Comment=Voice dictation: hold a key, speak, text lands where you type
Exec=$BIN/spechy
Icon=spechy
Categories=Utility;Accessibility;
StartupWMClass=spechy
EOF

echo "Installed $BIN/spechy"
if pgrep -x spechy >/dev/null; then
    echo "Spechy is running; quit it from the tray and start it again to use the new build."
fi
