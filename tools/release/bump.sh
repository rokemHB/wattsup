#!/usr/bin/env bash
# Sets the version everywhere it is written and puts a heading for it under CHANGELOG.md's
# "Unreleased" section. Committing, tagging and pushing are left to you (docs/RELEASING.md).
# Usage: tools/release/bump.sh 1.2.3
set -euo pipefail
cd "$(dirname "$0")/../.."
v="${1:?usage: bump.sh X.Y.Z}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not a version: $v" >&2; exit 1; }
sed -i.bak "/^\[workspace.package\]/,/^\[/s/^version *= *\".*\"/version = \"$v\"/" Cargo.toml
rm Cargo.toml.bak
npm version "$v" --no-git-tag-version --allow-same-version > /dev/null
node -e '
  const fs = require("fs"), f = "src-tauri/tauri.conf.json";
  const s = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, s.replace(/("version":\s*)"[^"]*"/, `$1"${process.argv[1]}"`));
' "$v"
cargo update --workspace --offline > /dev/null 2>&1 || cargo update --workspace > /dev/null
if grep -q "^## \[$v\]" CHANGELOG.md; then
  echo "CHANGELOG.md already has a section for $v"
else
  today=$(date +%F)
  sed -i.bak "s/^## \[Unreleased\]\$/## [Unreleased]\n\n## [$v] - $today/" CHANGELOG.md
  rm CHANGELOG.md.bak
fi
tools/release/check-version.sh "v$v"
