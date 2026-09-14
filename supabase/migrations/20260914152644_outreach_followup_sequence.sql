-- Two follow-ups replace the single day-5 nudge.
--
-- Until now outreach_prospects.nudged_at was the one follow-up a silent
-- prospect ever got, five days after sent_at, reusing the first-touch
-- subject. Outbound Prospecting's next step is a three-touch cadence:
-- first pitch (already live, no booking link by default), a day-3 bump
-- with a new angle and a unique subject (still no booking link), then a
-- day-10 last bump that offers the calendar when the tenant has one.
--
-- Two new stamps, independently claimable so overlapping sweeps cannot send
-- the same step twice:
--   followup_1_at  the day-3 send (or the migrated old day-5 send)
--   followup_2_at  the day-10 send
--
-- Existing rows with nudged_at set already received the old "one follow-up"
-- slot. Copy that timestamp onto followup_1_at so they are not mailed that
-- slot again. Day-10 remains available until they go stale (21 days after
-- sent_at). nudged_at stays as "last follow-up sent": the daily cap counts
-- it, and each new follow-up send refreshes it.

alter table public.outreach_prospects
  add column if not exists followup_1_at timestamptz,
  add column if not exists followup_2_at timestamptz;

update public.outreach_prospects
  set followup_1_at = nudged_at
  where nudged_at is not null
    and followup_1_at is null;

comment on column public.outreach_prospects.followup_1_at is
  'When the day-3 follow-up was sent. Existing nudged_at rows were copied here so the old one-follow-up slot is not mailed twice.';

comment on column public.outreach_prospects.followup_2_at is
  'When the day-10 follow-up was sent. Independent of followup_1_at so a prospect who already had the old day-5 nudge can still get this later touch.';

comment on column public.outreach_prospects.nudged_at is
  'Last follow-up sent. The daily cap counts this. Per-step truth is followup_1_at / followup_2_at.';

-- The due scans are oldest-first inside a sent_at window, filtered to
-- silent sent rows missing that step. Partial indexes keep those scans
-- off the rest of the ledger.
create index if not exists idx_outreach_prospects_followup_1
  on public.outreach_prospects (business_id, sent_at)
  where status = 'sent' and followup_1_at is null and replied_at is null;

create index if not exists idx_outreach_prospects_followup_2
  on public.outreach_prospects (business_id, sent_at)
  where status = 'sent' and followup_2_at is null and replied_at is null;

-- grants: none (outreach_prospects): existing table, already granted; this
-- adds columns and indexes, not objects.
