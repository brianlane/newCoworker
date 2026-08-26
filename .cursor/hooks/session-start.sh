#!/usr/bin/env bash
# Cursor sessionStart hook: copy docs/CONTEXT-PACK.md into this checkout, then
# inject the age line as additional_context.
#
# Cursor sends JSON on stdin; consume it so the pipe does not stall.
# The pack-sync script prints a one-line status to stdout; that line is what
# Claude Code used to inject, and what Cursor should see too.
set -euo pipefail
cat >/dev/null

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
msg=$(bash "$root/scripts/sync-context-pack.sh" 2>&1 || true)

python3 -c 'import json,sys; print(json.dumps({"additional_context": sys.stdin.read()}))' <<<"$msg"
