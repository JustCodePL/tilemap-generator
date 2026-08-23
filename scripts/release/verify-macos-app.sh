#!/bin/bash

set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 APP_PATH RELEASE_VERSION BUNDLE_VERSION BUILD_NUMBER TEAM_ID" >&2
  exit 2
fi

app_path=$1
release_version=$2
bundle_version=$3
build_number=$4
team_id=$5
info_plist="$app_path/Contents/Info.plist"
asar_path="$app_path/Contents/Resources/app.asar"
executable="$app_path/Contents/MacOS/tilemap-generator"
unpacked_modules="$app_path/Contents/Resources/app.asar.unpacked/node_modules/@img"

[[ -d "$app_path" ]] || { echo "Brak aplikacji: $app_path" >&2; exit 1; }
[[ -f "$info_plist" ]] || { echo "Brak Info.plist w paczce." >&2; exit 1; }
[[ -x "$executable" ]] || { echo "Brak wykonywalnego pliku aplikacji." >&2; exit 1; }
[[ -f "$asar_path" ]] || { echo "Brak app.asar w paczce." >&2; exit 1; }

actual_bundle_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")
actual_build_number=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info_plist")
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")

[[ "$bundle_id" == 'ac.justcode.tilemap-generator' ]] || {
  echo "Nieprawidłowy bundle ID: $bundle_id" >&2
  exit 1
}
[[ "$actual_bundle_version" == "$bundle_version" ]] || {
  echo "CFBundleShortVersionString=$actual_bundle_version, oczekiwano $bundle_version" >&2
  exit 1
}
[[ "$actual_build_number" == "$build_number" ]] || {
  echo "CFBundleVersion=$actual_build_number, oczekiwano $build_number" >&2
  exit 1
}

packaged_version=$(node - "$asar_path" <<'NODE'
const asar = require('@electron/asar');
const archive = process.argv[2];
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
process.stdout.write(String(manifest.version));
NODE
)
[[ "$packaged_version" == "$release_version" ]] || {
  echo "Wersja package.json w ASAR=$packaged_version, oczekiwano $release_version" >&2
  exit 1
}

codesign --verify --deep --strict --verbose=2 "$app_path"
signature_details=$(codesign -dvvv "$app_path" 2>&1)
grep -Fq "Identifier=ac.justcode.tilemap-generator" <<<"$signature_details"
grep -Fq "TeamIdentifier=$team_id" <<<"$signature_details"
grep -Eq 'flags=.*\(runtime\)' <<<"$signature_details"
main_entitlements=$(codesign -d --entitlements :- "$executable" 2>/dev/null)
allow_jit=$(plutil -extract 'com\.apple\.security\.cs\.allow-jit' raw -o - - <<<"$main_entitlements")
[[ "$allow_jit" == 'true' ]] || {
  echo 'Główny executable nie ma wymaganego entitlementu allow-jit.' >&2
  exit 1
}
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"

fuses=$(NO_COLOR=1 ./node_modules/.bin/electron-fuses read --app "$app_path")
for expected_fuse in \
  'RunAsNode is Disabled' \
  'EnableCookieEncryption is Disabled' \
  'EnableNodeOptionsEnvironmentVariable is Disabled' \
  'EnableNodeCliInspectArguments is Disabled' \
  'EnableEmbeddedAsarIntegrityValidation is Enabled' \
  'OnlyLoadAppFromAsar is Enabled'; do
  grep -Fq "$expected_fuse" <<<"$fuses" || {
    echo "Nieprawidłowy fuse: $expected_fuse" >&2
    exit 1
  }
done

sharp_node=$(find "$unpacked_modules" -type f -path '*/sharp-darwin-arm64/lib/sharp-darwin-arm64-*.node' -print)
libvips=$(find "$unpacked_modules" -type f -path '*/sharp-libvips-darwin-arm64/lib/libvips-cpp*.dylib' -print)
[[ -n "$sharp_node" && $(wc -l <<<"$sharp_node" | tr -d ' ') -eq 1 ]] || {
  echo "Oczekiwano jednego sharp-darwin-arm64*.node." >&2
  exit 1
}
[[ -n "$libvips" && $(wc -l <<<"$libvips" | tr -d ' ') -eq 1 ]] || {
  echo "Oczekiwano jednego libvips-cpp*.dylib dla arm64." >&2
  exit 1
}
file "$sharp_node" | grep -q 'arm64'
file "$libvips" | grep -q 'arm64'
codesign --verify --strict --verbose=2 "$sharp_node"
codesign --verify --strict --verbose=2 "$libvips"
otool -L "$sharp_node" | grep -Fq "@rpath/$(basename "$libvips")"
otool -l "$sharp_node" \
  | grep -A3 LC_RPATH \
  | grep -Fq '@loader_path/../../sharp-libvips-darwin-arm64/lib'

[[ -f "$app_path/Contents/Resources/mcp/server.mjs" ]] || {
  echo "Brak MCP server.mjs w paczce." >&2
  exit 1
}

if [[ ${TILEMAP_VERIFY_SMOKE:-0} == '1' ]]; then
  smoke_root=$(mktemp -d "${RUNNER_TEMP:-/tmp}/tilemap-release-smoke.XXXXXX")
  TILEMAP_SMOKE_AUTO_QUIT_MS=3000 "$executable" --user-data-dir="$smoke_root" &
  smoke_pid=$!
  for _ in {1..20}; do
    if ! kill -0 "$smoke_pid" 2>/dev/null; then
      wait "$smoke_pid"
      smoke_pid=''
      break
    fi
    sleep 1
  done
  if [[ -n "$smoke_pid" ]]; then
    kill -TERM "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
    echo 'Aplikacja nie zakończyła smoke testu w ciągu 20 sekund.' >&2
    exit 1
  fi
fi
