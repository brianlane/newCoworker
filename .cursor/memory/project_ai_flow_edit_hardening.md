---
name: project_ai_flow_edit_hardening
description: "The five-layer guard on AI edits to live AiFlows (snapshot/undo, confirm handshake, blast radius, per-turn cap, blocking questions, out-of-band notice), shipped Aug 18 2026"
metadata:
  type: project
---

Built Aug 18 2026 after tracing that a single SMS to the tenant's own number
could rewrite live AiFlows with no confirmation step. PRs #1446 (merged and
deployed), #1447, #1450, #1451.

**The root problem is not the prompt, it is that `edit_aiflow` REGENERATES.**
It does not patch a definition: `editAiFlowDefinition` sends the whole current
JSON plus the instruction to Gemini and takes back a whole new definition. So
(a) unrelated steps can drift, (b) running the same instruction twice gives
two different results, and (c) an unwanted edit cannot be reversed by
describing the opposite change, because that writes a THIRD version.

The layers, and the one-line reason each exists:

0. **`ai_flow_definition_versions` + trigger.** `updateAiFlow` overwrote in
   place with no history anywhere. A TRIGGER, not a helper, because dozens of
   `debug/` and `scripts/oneshot/` scripts write `ai_flows` straight through
   PostgREST. Undo is `undo_aiflow_edit` (inline) / `restore_flow_version`
   (MCP), and restores go through `updateAiFlow` so the undo is itself
   snapshotted.
1. **Two-call confirm.** Stage (writes nothing, returns diff + token), then
   apply by token. The COMPILED DEFINITION IS STORED, never recompiled on
   confirm, or the confirmation would describe different bytes than it applies.
2. **Blast radius** (`edit-diff.ts`): first index where the two FLATTENED id
   lists disagree, vs the furthest `current_step` among in-flight runs.
   Classes `none` / `wording` / `structural` / `in_flight`. Text surfaces
   (SMS, email) refuse anything past `wording`.
3. **One automation per turn** (`FLOW_CHANGES_PER_TURN`). Staging is uncapped;
   only calls that commit count.
4. **Blocking questions.** The edit compile returns `{definition, questions}`;
   a non-empty list refuses to stage AT ALL, so no token is issued.
5. **Out-of-band notice** (`change-notice.ts`): `system_log`
   `aiflow_changed_by_ai` plus an owner notification, for AI sources only.

**Attribution is a write-only carrier.** `ai_flows.edit_source` / `edit_actor`
are stamped in the same UPDATE, copied to the version row, then NULLED by the
trigger, so they always read back null. Persisting them would let the next
writer that forgot to stamp inherit the previous edit's source, and a false
attribution is worse than an absent one.

Related: [[project_flow_when_var_must_be_produced]],
[[feedback_live_flow_source_of_truth]], [[project_ok_true_is_not_a_commit]].
