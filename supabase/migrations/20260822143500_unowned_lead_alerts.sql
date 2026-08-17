-- Claimable unowned-lead alerts.
--
-- The claim machinery understands exactly one thing: a parked `route_to_team`
-- run, matched through `ai_flow_runs.context.routing`. That is why a teammate
-- who replied "1" to an unowned-lead ALERT had it resolve against an
-- unrelated older offer instead (Amy Laidlaw, 2026-08-15): the alert she was
-- answering had no run, so there was nothing for the digit to attach to.
--
-- The AiFlow no-phone guards were converted into real offers in PR #1399, but
-- the urgent-alert dispatcher's `notify_team` alerts cannot be: they are sent
-- from the SMS worker, outside any flow run, so there is nothing to park.
-- This table is the record those alerts attach to.
--
-- One row per ALERT (not per recipient): every teammate texted about the same
-- lead is racing for the same claim, exactly like a broadcast offer, so the
-- claim has to be a single compare-and-swap rather than one row each.
create table public.unowned_lead_alerts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The LEAD this alert is about, in E.164. Not unique: the same lead can be
  -- alerted about more than once (a second reply days later is a new alert).
  lead_e164 text not null,
  -- Display name for the ack and for the "which lead did you mean" question.
  lead_label text,
  -- The teammates texted, in E.164. A bare "1" is only honored from one of
  -- these: an alert is not an open invitation to the whole roster.
  recipients text[] not null default '{}',
  -- Claim state. All three move together, guarded by `claimed_at is null` so
  -- two teammates racing cannot both win.
  claimed_by_member_id uuid references public.ai_flow_team_members(id) on delete set null,
  claimed_by_e164 text,
  claimed_at timestamptz,
  -- A digit arriving long after the fact must not assign a stale lead. The
  -- writer sets this; the reader treats an expired row as gone.
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The reader's exact predicate: unclaimed, unexpired, addressed to this
-- sender, newest first.
create index unowned_lead_alerts_live_idx
  on public.unowned_lead_alerts (business_id, expires_at desc)
  where claimed_at is null;

-- `recipients @> array[...]` needs GIN to avoid a sequential scan as the
-- table grows.
create index unowned_lead_alerts_recipients_idx
  on public.unowned_lead_alerts using gin (recipients);

-- Service-role only: this is worker and Edge-function state, never read by a
-- browser. RLS on with zero policies is the repo's default posture.
alter table public.unowned_lead_alerts enable row level security;
grant select, insert, update, delete on table public.unowned_lead_alerts to service_role;
