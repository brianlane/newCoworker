-- At most one ACTIVE ai_flow_run per (flow, trigger URL).
--
-- HomeLight (2026-09-13, Sonia R.) sends the alert and the hmlt.co URL 35ms
-- apart. Persist-before-eval lets both webhooks match once both inbound jobs
-- exist. findActiveRunWithTriggerUrl then insert is not atomic, and
-- dedupe_key is the per-SMS event id, so both can enqueue. This unique
-- partial index is the atomic close: the second insert hits 23505, which
-- enqueue already treats as queued (the sibling of THIS referral, not a
-- later lead). A later lead whose newest window URL is different is a
-- different key and is not blocked.
--
-- Finished rows (done / failed / canceled) are excluded so a later lead can
-- reuse a URL. Empty URLs never unique-key: those flows have nothing unique
-- to pin on. Do NOT fold the URL into dedupe_key: that unique index is
-- forever, including done, and would block a later run of the same URL.
--
-- Status list must stay in lockstep with ACTIVE_TRIGGER_URL_RUN_STATUSES
-- in supabase/functions/_shared/ai_flows/trigger_url_dedupe.ts
-- (tests/ai-flows-trigger-url-dedupe.test.ts pins both).
--
-- Cancel newer duplicate active runs FIRST so CREATE UNIQUE INDEX cannot
-- fail the deploy. Keep the oldest row per (flow_id, trigger.url). Two
-- active runs of the same URL are the sibling race this index prevents,
-- not two distinct leads. Production had zero such duplicates when this
-- shipped; the UPDATE is a deploy backstop.

with ranked as (
  select
    id,
    row_number() over (
      partition by flow_id, (context -> 'trigger' ->> 'url')
      order by created_at asc, id asc
    ) as rn
  from public.ai_flow_runs
  where status in (
    'queued',
    'running',
    'awaiting_approval',
    'awaiting_agent',
    'awaiting_reply',
    'awaiting_call'
  )
    and coalesce(context -> 'trigger' ->> 'url', '') <> ''
)
update public.ai_flow_runs r
set
  status = 'canceled',
  last_error = 'duplicate active trigger.url; kept older run so unique index can apply'
from ranked
where r.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists ai_flow_runs_active_trigger_url_idx
  on public.ai_flow_runs (flow_id, ((context -> 'trigger' ->> 'url')))
  where status in (
    'queued',
    'running',
    'awaiting_approval',
    'awaiting_agent',
    'awaiting_reply',
    'awaiting_call'
  )
  and coalesce(context -> 'trigger' ->> 'url', '') <> '';

comment on index public.ai_flow_runs_active_trigger_url_idx is
  'At most one active run per (flow, trigger URL). Closes the sibling-webhook race the lookup-then-insert skip cannot. Finished rows are excluded so a later lead can reuse a URL. Empty URLs never unique-key.';
