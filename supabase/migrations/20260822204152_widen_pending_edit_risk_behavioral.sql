-- Allow the 'behavioral' risk class on a staged AiFlow edit.
--
-- classifyEditRisk gained a class between 'wording' and 'structural' for an
-- edit that changes what a step DOES on a page we do not control (a
-- browse_action / browse_extract field) or whether a step runs at all (a
-- `when` guard). Those leave the step id list identical, so they used to
-- classify as 'wording' and were approvable from a single text message.
--
-- Without this widening the new class is a runtime failure rather than a
-- policy: the text surfaces refuse such an edit before staging, but a RICH
-- surface (dashboard chat, MCP) stages it, and the insert would be rejected
-- by this constraint, so the owner would be told nothing could be saved.
--
-- The ordering is carried in TypeScript, not here; this constraint only
-- pins the vocabulary. tests/ai-flow-pending-edit-risk-lockstep.test.ts
-- binds the two together so a future class cannot reach the code without
-- reaching the column.
alter table public.ai_flow_pending_edits
  drop constraint if exists ai_flow_pending_edits_risk_check;

alter table public.ai_flow_pending_edits
  add constraint ai_flow_pending_edits_risk_check
  check (risk in ('wording', 'behavioral', 'structural', 'in_flight'));

comment on column public.ai_flow_pending_edits.risk is
  '''wording'' | ''behavioral'' | ''structural'' | ''in_flight'': how far the edit reaches. See src/lib/ai-flows/edit-diff.ts.';

-- grants: none (no object is created here; the table's existing service_role
-- grants are unchanged by widening a check constraint).
