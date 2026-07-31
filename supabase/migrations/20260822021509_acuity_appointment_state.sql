-- What we have already observed on each merchant's Acuity book.
--
-- WHY THIS EXISTS: an Acuity appointment carries `dateCreated` but NO
-- last-modified timestamp, and the appointment object has no `canceled`
-- boolean at all (cancellation is signalled by which listing a row came
-- from). The AiFlow calendar poller's event_canceled mode gates on the
-- moment a change happened (CalendarEventInput.updatedIso), so on Acuity
-- there is nothing to gate on.
--
-- Rather than ship degraded cancellation and reschedule triggers, we
-- synthesize that timestamp from our own observation: the first time we see
-- an appointment flip to canceled, or see its start move, THAT moment is the
-- modification time. It is a timestamp we control, so unlike a provider
-- field it is guaranteed stable and monotonic, which is exactly what
-- eventCanceledDue's lookback needs. Re-stamping it on every poll would make
-- a cancellation perpetually "due" and it would never age out.
--
-- The webhook receiver writes here too, using the delivery moment, so the
-- real-time and polling paths agree and their shared `cal:` dedupe keys
-- collapse to a single flow run.
--
-- Service-role only, matching every other integration table: RLS on with no
-- policies. Nothing here is secret, but nothing here is client-readable
-- either.

create table if not exists public.acuity_appointment_state (
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Acuity's appointment id, as text (an opaque identifier, never arithmetic).
  appointment_id text not null,
  -- The start we last observed, so a move is detectable at all.
  start_at timestamptz not null,
  canceled boolean not null default false,
  -- When we FIRST saw it canceled. Never re-stamped: see the note above.
  first_seen_canceled_at timestamptz,
  -- When we last saw its start change.
  start_changed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id, appointment_id)
);

-- The retention sweep deletes by (business, start_at).
create index if not exists idx_acuity_appointment_state_start
  on public.acuity_appointment_state (business_id, start_at);

alter table public.acuity_appointment_state enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Data API grants are NOT automatic since
-- 20260820100400_revoke_default_data_api_grants.sql; without this every
-- supabase-js read fails at runtime even under the service-role key.
grant select, insert, update, delete on table public.acuity_appointment_state to service_role;
