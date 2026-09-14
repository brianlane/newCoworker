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
-- Status list on the INDEX must stay in lockstep with
-- ACTIVE_TRIGGER_URL_RUN_STATUSES in
-- supabase/functions/_shared/ai_flows/trigger_url_dedupe.ts
-- (tests/ai-flows-trigger-url-dedupe.test.ts pins both).
--
-- Backstop before CREATE UNIQUE INDEX: cancel extra QUEUED rows of the
-- same URL. Those are the 35ms sibling inserts that have not been claimed,
-- or a queued insert that lost to an already-parked run. Do not touch
-- running / awaiting_* rows. db push runs BEFORE the edge functions that
-- switch to lastUrlInText, so two live HomeLight leads in one 15-minute
-- window can already share the older URL while both stay parked. Canceling
-- the newer of those would drop the later lead mid-offer or mid-call, and
-- a raw status flip is not the worker cancel path. If two parked runs
-- share a URL, CREATE UNIQUE INDEX fails loudly. Wait those runs out.

update public.ai_flow_runs r
set
  status = 'canceled',
  last_error = 'duplicate queued trigger.url; kept the older or already-parked run'
where r.status = 'queued'
  and coalesce(r.context -> 'trigger' ->> 'url', '') <> ''
  and exists (
    select 1
    from public.ai_flow_runs o
    where o.flow_id = r.flow_id
      and o.id <> r.id
      and coalesce(o.context -> 'trigger' ->> 'url', '')
        = (r.context -> 'trigger' ->> 'url')
      and o.status in (
        'queued',
        'running',
        'awaiting_approval',
        'awaiting_agent',
        'awaiting_reply',
        'awaiting_call'
      )
      and (
        o.status <> 'queued'
        or o.created_at < r.created_at
        or (o.created_at = r.created_at and o.id < r.id)
      )
  );

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
