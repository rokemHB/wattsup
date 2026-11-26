#!/usr/bin/env bash
# Checks that a release tag (v1.2.3) agrees with every place the version is written:
# the Cargo workspace, Cargo.lock, package.json, package-lock.json, tauri.conf.json, and that
# CHANGELOG.md has a section for it.
# Usage: tools/release/check-version.sh v1.2.3
set -euo pipefail
cd "$(dirname "$0")/../.."
tag="${1:?usage: check-version.sh vX.Y.Z}"
want="${tag#v}"
fail=0
check() {
  if [ "$2" != "$want" ]; then
    echo "$1 says '$2', the tag says '$want'" >&2
    fail=1
  fi
}
check Cargo.toml "$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p;}' Cargo.toml)"
check Cargo.lock "$(awk '/^name = "wattsup"$/{getline; gsub(/version = |"/, ""); print; exit}' Cargo.lock)"
check package.json "$(node -p 'require("./package.json").version')"
check package-lock.json "$(node -p 'require("./package-lock.json").version')"
check src-tauri/tauri.conf.json "$(node -p 'require("./src-tauri/tauri.conf.json").version')"
grep -q "^## \[$want\]" CHANGELOG.md || { echo "CHANGELOG.md has no section '## [$want]'" >&2; fail=1; }
[ "$fail" = 0 ] && echo "version $want everywhere"
exit "$fail"
