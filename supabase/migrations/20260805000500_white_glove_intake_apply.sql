-- White-glove intake → tenant apply tracking.
--
-- `applied_at` stamps when an admin last applied a COMPLETED intake's answers
-- to a tenant (vault blocks + business hours + the follow-up flow), and
-- `applied_flow_id` remembers the installed flow so a re-apply UPDATES the
-- same flow instead of installing a duplicate. The flow reference is
-- SET NULL on flow deletion — an owner deleting the flow simply means the
-- next apply installs a fresh one.
--
-- `apply_started_at` is a short apply LEASE: the claim update stamps it
-- atomically and refuses while a fresh stamp exists, so two overlapping
-- applies (same tenant or different tenants) can never both run the write
-- phase. Cleared on success; a crashed apply's lease simply expires.
alter table public.white_glove_intakes
  add column if not exists applied_at timestamptz,
  add column if not exists applied_flow_id uuid references public.ai_flows(id) on delete set null,
  add column if not exists apply_started_at timestamptz;
