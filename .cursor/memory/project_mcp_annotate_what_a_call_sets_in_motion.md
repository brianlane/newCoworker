---
name: project-mcp-annotate-what-a-call-sets-in-motion
description: "MCP tool annotations must describe what a call STARTS, not what its function body touches; create_contact fires automations that text customers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 829c625c-bcb6-4c1a-8235-98fab892df47
  modified: 2026-08-12T00:04:16.799Z
---

Review caught me annotating MCP tools by what their own code touches. That is
wrong in the reassuring direction, which is the worst direction.

- `create_contact` looks like a row insert, but fires `contact_created`, which
  enqueues AiFlows that can text or email the person. **Open-world.**
- `update_contact` same, on tag and owner changes, plus it replaces the tag set.
- `trigger_flow` / `run_flow` start owner-authored flows whose `update_contact`
  step can carry `removeTags` (`src/lib/ai-flows/schema.ts`). **Destructive**,
  even though the call looks purely additive.

The boundary that stops this swallowing everything: a tool answers for what
**this call** sets going. `set_flow_enabled` only changes eligibility for runs
a later independent trigger causes, so it stays local.

Pinned by name in `tests/mcp-tool-metadata-guard.test.ts`, because no static
check can see "what a call sets in motion" and the natural future edit is to
tidy `create_contact` back to `writeLocal`.

Related: [[feedback-assert-the-producer-not-the-fixture]].
