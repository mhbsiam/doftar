#!/usr/bin/env bash
# Builds the universal (Apple Silicon + Intel), ad-hoc signed Doftar DMG, the
# same way on every Mac. Usage: npm run dmg [-- --install]
#   --install  also replace /Applications/Doftar.app with the new build
set -euo pipefail

cd "$(dirname "$0")/.."

# Apple's codesign must win over others on PATH (Anaconda ships one that
# rejects --options and breaks signing).
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

install=false
for arg in "$@"; do
  case "$arg" in
    --install) install=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

target=universal-apple-darwin
bundle="src-tauri/target/$target/release/bundle"
version=$(node -p "require('./src-tauri/tauri.conf.json').version")

# rust-toolchain.toml pins the compiler and lists both targets; this covers
# a rustup that predates auto-installing them.
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

[ -d node_modules ] || npm ci --ignore-scripts

# A failed earlier run can leave its scratch image mounted, which makes the
# next DMG step fail with "Resource busy".
for img in "$bundle"/macos/rw.*.dmg; do
  [ -e "$img" ] || continue
  hdiutil info | awk -v img="$PWD/$img" '
    $1 == "image-path" { found = (substr($0, index($0, ":") + 2) == img) }
    found && $1 ~ /^\/dev\/disk[0-9]+$/ { print $1; found = 0 }
  ' | while read -r dev; do hdiutil detach "$dev" -force >/dev/null || true; done
  rm -f "$img"
done

./node_modules/.bin/tauri build --target "$target" --bundles app --bundles dmg

app="$bundle/macos/Doftar.app"
dmg="$bundle/dmg/Doftar_${version}_universal.dmg"

codesign --verify --deep --strict "$app"
lipo -archs "$app/Contents/MacOS/Doftar"
hdiutil verify "$dmg" >/dev/null
(cd "$bundle/dmg" && shasum -a 256 "$(basename "$dmg")" > SHA256SUMS)

if $install; then
  osascript -e 'tell application "Doftar" to quit' 2>/dev/null || true
  # Move the old copy to the Trash rather than deleting it.
  if [ -d /Applications/Doftar.app ]; then
    mv /Applications/Doftar.app "$HOME/.Trash/Doftar $(date +%Y%m%d-%H%M%S).app"
  fi
  mnt=$(mktemp -d)
  hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mnt" >/dev/null
  ditto "$mnt/Doftar.app" /Applications/Doftar.app
  hdiutil detach "$mnt" >/dev/null
  rmdir "$mnt"
  echo "Installed /Applications/Doftar.app"
fi

echo
echo "DMG:       $PWD/$dmg"
echo "Checksums: $PWD/$bundle/dmg/SHA256SUMS"
