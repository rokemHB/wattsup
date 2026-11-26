#!/usr/bin/env bash
# Prints the release notes for one version: its section of CHANGELOG.md (without the heading)
# followed by the download help in downloads.md.
# Usage: tools/release/notes.sh 1.2.3
set -euo pipefail
cd "$(dirname "$0")/../.."
v="${1:?usage: notes.sh X.Y.Z}"
awk -v v="$v" '
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on && /^\[[^]]*\]: / { next }
  on { print }
' CHANGELOG.md | sed -e '/./,$!d'
echo
cat tools/release/downloads.md
