---
name: heredoc-file-flag
description: "The Bash tool's snapshot-eval wrapper can mangle quoted heredocs; pass long git/gh text via files"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: af77febd-6e53-42ce-88ac-231b539f8a81
  modified: 2026-08-01T20:19:13.086Z
---

Long commit messages or PR bodies passed inline via `"$(cat <<'EOF' ... EOF)"` intermittently break in this harness: the shell-snapshot eval wrapper re-quotes the command and the heredoc's quoting is lost, so backticks execute ("vitest: command not found") or apostrophes produce "unexpected EOF while looking for matching quote", and `gh pr create` can hang waiting on stdin.

**Why:** the wrapper wraps the whole command in `eval '...'`, and nested quoted-heredoc escaping does not survive for some bodies (observed Aug 1 2026 on newCoworker PRs #1112 and #1115).

**How to apply:** write the text to a scratchpad file first, then `git commit -F <file>` and `gh pr create --body-file <file>`. Short single `-m` flags without backticks are fine inline. If a `gh` command times out into the background for no clear reason, check for a hung process (`pgrep -fl "gh pr"`) and whether the PR actually got created before retrying.
