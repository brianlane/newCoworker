-- Backfill customer_memories.email from AiFlow lead-intake run data.
--
-- Lead-intake flows (ReferralExchange, Clever) capture the lead's email AND
-- phone in ai_flow_runs.context->'vars' (lead_email / lead_phone), but the
-- customer profile was only ever keyed by lead_phone — the email was never
-- written onto it. This connects the existing leads so their SMS/voice history
-- (and any future email) roll up to one cross-channel profile, matching the new
-- going-forward capture in the ai-flow-worker.
--
-- Safe + idempotent: only fills profiles whose email is still NULL, only uses
-- the most recent run per (business, phone), and only accepts addresses that
-- pass a basic shape check. Re-running is a no-op.

with lead_pairs as (
  select distinct on (business_id, phone)
    business_id,
    context->'vars'->>'lead_phone' as phone,
    trim(lower(context->'vars'->>'lead_email')) as email,
    nullif(trim(context->'vars'->>'lead_name'), '') as name
  from ai_flow_runs
  where context->'vars'->>'lead_phone' is not null
    -- Validity check lives INSIDE the subquery so DISTINCT ON keeps the most
    -- recent run with a *valid* email; otherwise a newer run carrying a
    -- malformed/empty address would win and then be filtered out, skipping a
    -- customer an older valid run could have linked.
    and trim(lower(context->'vars'->>'lead_email'))
        ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  order by business_id, phone, created_at desc
)
update customer_memories cm
set email = lp.email,
    display_name = coalesce(cm.display_name, lp.name),
    updated_at = now()
from lead_pairs lp
where cm.business_id = lp.business_id
  and cm.customer_e164 = lp.phone
  and cm.email is null;
