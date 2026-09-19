#!/bin/bash
# Run unit tests that need better-sqlite3 under system node.
#
# Why this exists: the committed better_sqlite3.node binary targets Electron's
# Node ABI (postinstall runs electron-rebuild), which plain `node` (vitest)
# cannot load. This script rebuilds the module for system node, runs vitest,
# then restores the Electron binary — the restore runs on EXIT so the working
# tree is never left in a broken state, even when tests fail.
#
# Usage: npm run test:node [-- <vitest args>]
#   e.g. npm run test:node -- electron/services/__tests__/taskGroups.test.ts
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE_BIN="$REPO_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
BACKUP="$(mktemp /tmp/better_sqlite3.XXXXXX.node)"

restore() {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SQLITE_BIN"
    rm -f "$BACKUP"
  fi
}
trap restore EXIT

cp "$SQLITE_BIN" "$BACKUP"
(cd "$REPO_ROOT" && npm rebuild better-sqlite3 >/dev/null 2>&1)
cd "$REPO_ROOT" && ./node_modules/.bin/vitest run "$@"
