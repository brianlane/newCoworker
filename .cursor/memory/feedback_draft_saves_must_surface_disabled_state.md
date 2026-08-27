---
name: draft-saves-must-surface-disabled-state
description: "AI-created flow drafts save DISABLED; the coworker and the UI must say so, and 'done' means verify enabled state, never assume live"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c1ecae5e-bc6b-43f1-aaac-f8d8cf7204e7
  modified: 2026-08-19T18:13:42.274Z
---

Brian, 2026-08-19, on the KYP review: James asked about three times for the
VFM booking aiflow; the chat AI created drafts, James saved them in the
builder, and the AI said "all set" while both flows sat `enabled=false`
under the default name "Adapted automation", with the older generic booking
flow still enabled. Nobody told him.

**Why:** a saved-but-disabled flow is indistinguishable from "done" to an
owner; the coworker confirming it makes the silence a lie. Same family as
[[ok-true-is-not-a-commit]]: a hand-off is not an outcome.

**How to apply:** the `create_aiflow` tool note and the chat draft card now
say drafts save switched OFF and must be enabled (shipped with the Aug 19
PR alongside the KYP one-shot). When an owner says "done" after a draft
hand-off, the coworker must check `list_aiflows` and report the actual
on/off state. When reviewing chat sessions, treat any "it's live/all set"
claim about a flow as unverified until the `enabled` bit is read. Also
watch the default name trap: multiple drafts saved as "Adapted automation"
are indistinguishable on the AiFlows page.
