#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mapfile -t appimages < <(find "$script_dir" -maxdepth 1 -type f -name '*.AppImage' -print | sort)

if (( ${#appimages[@]} != 1 )); then
  printf 'Expected exactly one AppImage beside this launcher, found %d.\n' "${#appimages[@]}" >&2
  exit 1
fi

appimage="${appimages[0]}"
artifact_hash="$(sha256sum "$appimage" | cut -d ' ' -f 1)"
cache_base="${XDG_CACHE_HOME:-${HOME:?HOME is required}/.cache}/t3code-browser/$artifact_hash"
extract_root="$cache_base/squashfs-root"
electron_binary="$extract_root/t3code"
app_asar="$extract_root/resources/app.asar"
server_entry="$app_asar/apps/server/dist/bin.mjs"

if [[ ! -x "$electron_binary" || ! -f "$app_asar" ]]; then
  rm -rf -- "$cache_base"
  mkdir -p -- "$cache_base"
  (
    cd -- "$cache_base"
    chmod +x -- "$appimage"
    "$appimage" --appimage-extract >/dev/null
  )
fi

if [[ ! -x "$electron_binary" || ! -f "$app_asar" ]]; then
  printf 'The AppImage did not contain the expected packaged T3 runtime.\n' >&2
  exit 1
fi

exec env ELECTRON_RUN_AS_NODE=1 \
  "$electron_binary" \
  "$server_entry" \
  start \
  --mode web \
  --host 127.0.0.1 \
  "$@"
