#!/usr/bin/env bash
# Bumps the MODULE version — package.json at the root and in packages/core +
# packages/module + packages/connector, kept in sync (one
# logical module, one version). After bumping,
# push it to the platform with scripts/register-module.sh (the Module Catalog
# is the source of truth for the deployed module version).
#
# Usage: scripts/bump-version.sh <major|minor|patch>
set -euo pipefail

PART="${1:?usage: bump-version.sh <major|minor|patch>}"
[[ "$PART" =~ ^(major|minor|patch)$ ]] \
  || { echo "ERROR: '$PART' — expected major, minor or patch"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

OLD=$(node -p "require('$ROOT/package.json').version")
for pkg in "$ROOT" "$ROOT/packages/core" "$ROOT/packages/module" "$ROOT/packages/connector"; do
  (cd "$pkg" && npm version "$PART" --no-git-tag-version >/dev/null)
done
NEW=$(node -p "require('$ROOT/package.json').version")

echo "module version: $OLD → $NEW (root + packages/{core,module,connector})"
echo "Next: re-register so the platform sees it — scripts/register-module.sh"
