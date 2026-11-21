#!/usr/bin/env bash
# Build a GTK/WebKit "sysroot" under ~/doftar-sysroot without sudo, so
# `cargo`/`tauri build` can resolve pkg-config deps and link.
# Prefer `sudo apt install ...-dev` when you can; see LINUX.md.
set -euo pipefail

ROOT="$HOME/doftar-sysroot"
PCDIR="$ROOT/usr/lib/x86_64-linux-gnu/pkgconfig"
mkdir -p "$ROOT"
cd "$ROOT"

PKGS=(
  libwebkit2gtk-4.1-dev libgtk-3-dev libglib2.0-dev libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev libgdk-pixbuf-2.0-dev libpango1.0-dev
  libatk1.0-dev libcairo2-dev libayatana-appindicator3-dev librsvg2-dev
  libharfbuzz-dev libepoxy-dev libdbus-1-dev libglib2.0-dev-bin
)
apt-get download "${PKGS[@]}"

for f in *.deb; do dpkg -x "$f" .; done

# Dev .so symlinks point at libfoo.so.0, which lives in the runtime packages
# under /lib — repoint dangling links there.
cd "$ROOT/usr/lib/x86_64-linux-gnu"
for f in lib*.so; do
  t=$(readlink "$f" || true)
  [ -e "$f" ] || [ -z "$t" ] || ln -sfn "/lib/x86_64-linux-gnu/$t" "$f"
done

# Stub .pc files for transitive leaf deps. Shared linking resolves them via
# the top-level libs, so empty Libs/Cflags are fine.
export PKG_CONFIG_PATH="$PCDIR:$ROOT/usr/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$ROOT"
for _ in 1 2 3 4 5 6; do
  missing=$(pkg-config --print-errors --exists gtk+-3.0 webkit2gtk-4.1 \
    javascriptcoregtk-4.1 libsoup-3.0 ayatana-appindicator3-0.1 dbus-1 2>&1 \
    | grep -oP "Package '\K[^']+" | sort -u)
  [ -z "$missing" ] && break
  for m in $missing; do
    printf 'Name: %s\nDescription: stub\nVersion: 99.0\nLibs:\nCflags:\n' "$m" > "$PCDIR/$m.pc"
  done
done

pkg-config --exists gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 \
  libsoup-3.0 ayatana-appindicator3-0.1 dbus-1
echo "sysroot ready at $ROOT — export the vars shown in LINUX.md"
