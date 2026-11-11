#!/usr/bin/env bash
# Builds the Apple silicon, ad-hoc signed Doftar DMG, the same on every Mac. Usage: npm run dmg [-- --install]
#   --install  also replace /Applications/Doftar.app with the new build
set -euo pipefail

cd "$(dirname "$0")/.."

# Use Apple's codesign. Anaconda's codesign is earlier on PATH and rejects --options.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

install=false
for arg in "$@"; do
  case "$arg" in
    --install) install=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

target=aarch64-apple-darwin
bundle="src-tauri/target/$target/release/bundle"
version=$(node -p "require('./src-tauri/tauri.conf.json').version")

# rust-toolchain.toml pins the compiler and the target. This adds it for a rustup that does not install it automatically.
rustup target add "$target" >/dev/null

[ -d node_modules ] || npm ci --ignore-scripts

# A failed earlier run can leave its scratch image mounted. The next DMG step then fails with "Resource busy".
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
# Tauri names it Doftar_<version>_aarch64.dmg. Rename it to the release name.
dmg="$bundle/dmg/doftar_v${version}_stable_macos.dmg"
mv "$bundle/dmg/Doftar_${version}_aarch64.dmg" "$dmg"

codesign --verify --deep --strict "$app"
lipo -archs "$app/Contents/MacOS/Doftar"
hdiutil verify "$dmg" >/dev/null
(cd "$bundle/dmg" && shasum -a 256 "$(basename "$dmg")" > SHA256SUMS)

if $install; then
  osascript -e 'tell application "Doftar" to quit' 2>/dev/null || true
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
