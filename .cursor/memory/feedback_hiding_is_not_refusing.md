---
name: hiding-is-not-refusing
description: filtering something out of what a surface RENDERS leaves the write path wide open; gate both
metadata:
  type: feedback
---

When something must be invisible to a class of caller, filtering it out of the
read/render path is only half the job. The write path usually resolves the
same object by key and never consults the filter.

Concretely, on PR #1593 a `platformOnly` tool was filtered from
`resolveAgentTools` (which renders Settings) and from the MCP tool vocabulary,
and I stopped there. Both write paths still resolved it through
`findAgentToolDefinition` and would upsert, so **knowing the key was enough to
toggle a platform tool, including switching it off for the one business that
needed it.** Bugbot caught it.

**Why:** invisibility is a UI property; refusal is a security property. A
reviewer reading only the render filter will believe the second follows from
the first, and it does not.

**How to apply:** for every "hidden from X" requirement, enumerate the
surfaces: render, list/vocabulary, read-one, and write. Gate the write beside
the existing capability check (here, next to `configurable`), so the two rules
sit together and cannot drift apart.

Related: [[agent-tool-parity-four-way]], [[removing-a-gate-means-auditing-identities]].
