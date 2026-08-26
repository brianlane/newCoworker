#!/usr/bin/env bash
# Session-start hook: put docs/CONTEXT-PACK.md in this checkout before the
# session goes looking for it.
#
# The pack is generated and gitignored, and a fresh worktree (Cursor
# `newCoworker-wt-<name>`, or Claude Code under .claude/worktrees/) is
# populated with tracked files only. Without this copy, every worktree
# session opens with a failed read and re-buys the orientation the pack
# exists to provide. The generator (scripts/context-pack.ts) mirrors into
# every checkout that exists when it runs; this hook covers worktrees created
# after the last regeneration. Wired from .cursor/hooks.json and from
# .claude/settings.json.
#
# Copy, not symlink: the generator replaces the main copy by rename, and a
# symlinked pack could change or vanish under a session that already read it.
# Stdout lands in the session's context, so the messages below talk to the
# agent.
set -euo pipefail

rel="docs/CONTEXT-PACK.md"
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
main=$(dirname "$common")

if [ "$root" != "$main" ] && [ -f "$main/$rel" ]; then
  if [ ! -f "$root/$rel" ] || [ "$main/$rel" -nt "$root/$rel" ]; then
    mkdir -p "$root/docs"
    # -p preserves mtime, so the age reported below stays the generation age.
    cp -p "$main/$rel" "$root/$rel"
  fi
fi

if [ ! -f "$root/$rel" ]; then
  echo "Context pack: $rel is missing. Generate it with: npx tsx scripts/context-pack.ts (works from this checkout; writes the pack into every checkout, this one included)."
  exit 0
fi

# Age from mtime: the file is generated, never hand-edited, and the copy
# above preserves timestamps. stat -f is macOS, stat -c the GNU fallback.
mtime=$(stat -f %m "$root/$rel" 2>/dev/null || stat -c %Y "$root/$rel" 2>/dev/null || echo 0)
age_h=$(( ($(date +%s) - mtime) / 3600 ))
if [ "$age_h" -ge 24 ]; then
  echo "Context pack: $rel is ${age_h}h old. Regenerate it before leaning on it: npx tsx scripts/context-pack.ts (works from this checkout; refreshes every checkout, this one included)."
else
  echo "Context pack: $rel is ready (generated ${age_h}h ago)."
fi
