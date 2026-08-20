-- Bookings gain a fourth "Who bookings go to" mode: broadcast, claim by
-- replying "1".
--
-- Until now the setting had three modes and one door: only the public
-- booking page consulted it, and every appointment the AI coworker booked
-- in conversation landed assigned to nobody regardless of the choice. The
-- application half of this change makes BOTH doors run the same resolution
-- and adds `broadcast`: no single assignee is picked at booking time, every
-- eligible teammate is texted an invite, and the first to reply "1" becomes
-- the booking's assignee.
--
-- The DEFAULT flips to `broadcast` for NEW businesses only. Existing rows
-- keep their stored value (no backfill, decided with Brian on 2026-08-19):
-- flipping live multi-member tenants would start texting whole rosters on
-- every booking without them choosing it.

alter table public.booking_pages
  drop constraint booking_pages_assignment_mode_chk;
alter table public.booking_pages
  add constraint booking_pages_assignment_mode_chk
    check (assignment_mode in ('any', 'round_robin', 'fixed', 'broadcast')) not valid;
alter table public.booking_pages
  alter column assignment_mode set default 'broadcast';

alter table public.booking_meeting_types
  drop constraint booking_meeting_types_assignment_mode_chk;
alter table public.booking_meeting_types
  add constraint booking_meeting_types_assignment_mode_chk
    check (assignment_mode is null or assignment_mode in ('any', 'round_robin', 'fixed', 'broadcast'))
    not valid;

-- The claimable record a broadcast booking parks, mirroring
-- unowned_lead_alerts (20260822145251): one row per BOOKING, not per
-- recipient, because everyone invited is racing for the same claim, so the
-- claim must be a single compare-and-swap. The booking itself stays on
-- calendar_booking_dedupe; this row exists so a bare "1" reply has
-- something to attach to (the lesson the alerts table already recorded).
create table public.booking_claim_offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The booking this claim assigns, by its dedupe-ledger row. Cascade: a
  -- deleted booking takes its open claim with it.
  dedupe_claim_id uuid not null references public.calendar_booking_dedupe(id) on delete cascade,
  -- Snapshot for the reply copy ("It's yours: <summary> <start>"), so the
  -- webhook answers without a second read.
  event_summary text,
  start_local text,
  attendee_name text,
  -- The teammates invited, in E.164. A bare "1" is only honored from one of
  -- these: an invite is not an open offer to the whole roster.
  recipients text[] not null default '{}',
  -- Claim state; all three move together, guarded by `claimed_at is null`.
  claimed_by_member_id uuid references public.ai_flow_team_members(id) on delete set null,
  claimed_by_e164 text,
  claimed_at timestamptz,
  -- A "1" arriving long after the fact must not grab a stale booking. The
  -- writer sets this; the reader treats an expired row as gone. Nobody
  -- claiming is fine: the booking simply stays unassigned (the owner alert
  -- already fired at booking time), so there is no fallback ladder here.
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The reader's exact predicate: unclaimed, unexpired, addressed to this
-- sender, newest first.
create index booking_claim_offers_live_idx
  on public.booking_claim_offers (business_id, expires_at desc)
  where claimed_at is null;

-- `recipients @> array[...]` needs GIN to avoid a sequential scan.
create index booking_claim_offers_recipients_idx
  on public.booking_claim_offers using gin (recipients);

-- Service-role only: worker and Edge-function state, never read by a
-- browser. RLS on with zero policies is the repo's default posture.
alter table public.booking_claim_offers enable row level security;
grant select, insert, update, delete on table public.booking_claim_offers to service_role;
