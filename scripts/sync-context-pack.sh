#!/usr/bin/env bash
# Session-start hook: put docs/CONTEXT-PACK.md in this checkout before the
# session goes looking for it, warn if CLAUDE.md is no longer import-only,
# and (Claude Code only) pin auto-memory at this checkout's .cursor/memory/.
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
else
  # Age from mtime: the file is generated, never hand-edited, and the copy
  # above preserves timestamps. stat -f is macOS, stat -c the GNU fallback.
  mtime=$(stat -f %m "$root/$rel" 2>/dev/null || stat -c %Y "$root/$rel" 2>/dev/null || echo 0)
  age_h=$(( ($(date +%s) - mtime) / 3600 ))
  if [ "$age_h" -ge 24 ]; then
    echo "Context pack: $rel is ${age_h}h old. Regenerate it before leaning on it: npx tsx scripts/context-pack.ts (works from this checkout; refreshes every checkout, this one included)."
  else
    echo "Context pack: $rel is ready (generated ${age_h}h ago)."
  fi
fi

# CLAUDE.md must stay @ imports of .cursor/rules and MEMORY.md. /init and
# /import copy rule text into it; say so here so a local session notices
# before CI does.
if [ -f "$root/CLAUDE.md" ]; then
  python3 - "$root/CLAUDE.md" <<'PY' || true
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
ok = re.compile(r"^@\.cursor/(rules/[A-Za-z0-9._-]+\.mdc|memory/MEMORY\.md)$")
bad = [ln for ln in lines if not ok.match(ln)]
if bad:
    print(
        "CLAUDE.md is not import-only. Restore it to @ imports of "
        ".cursor/rules/*.mdc and .cursor/memory/MEMORY.md. "
        "Do not run /init or /import; they copy. "
        "Do not use this session's working agreements until that file is restored."
    )
    for ln in bad[:8]:
        print(f"  unexpected: {ln[:120]}")
PY
fi

# Claude Code only: pin auto-memory writes at this checkout's .cursor/memory/.
# settings.local.json is gitignored; the path must be absolute. Cursor sessions
# do not set CLAUDE_PROJECT_DIR, so they skip this.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  python3 - "$root" <<'PY' || true
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
mem = str(root / ".cursor" / "memory")
path = root / ".claude" / "settings.local.json"
data = {}
if path.exists():
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        data = {}
if data.get("autoMemoryDirectory") != mem:
    data["autoMemoryDirectory"] = mem
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(
    "Claude auto-memory is pinned to .cursor/memory/ in this checkout. "
    "When saving a project memory, write it there and update MEMORY.md. "
    "Do not write under ~/.claude/projects/."
)
PY
fi
