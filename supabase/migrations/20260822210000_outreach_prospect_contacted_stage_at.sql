-- Which emailed prospects the board has already been told about.
--
-- The reconcile phase moves an emailed prospect to the Contacted stage, and it
-- has to run on a LATER pass than the send: the board is keyed on contacts, and
-- the outreach flow files a cold-emailed prospect about a minute after the mail
-- leaves, so there is nothing to tag at send time.
--
-- Without a marker that phase can only read "recently emailed", which is a
-- window it cannot drain. A tenant sending near the 200/day ceiling has more
-- prospects in the window than one pass may read, the same newest rows come
-- back every time, and everything behind them ages out still sitting in New
-- Lead: exactly the board lie the phase exists to fix.
--
-- Null means "not told yet". Stamped once the contact is at or past Contacted,
-- so a prospect whose contact does not exist yet stays null and is retried on
-- the next pass, while the ones already handled stop being read at all.
alter table public.outreach_prospects
  add column if not exists contacted_stage_at timestamptz;

comment on column public.outreach_prospects.contacted_stage_at is
  'When the pipeline board was moved to Contacted for this emailed prospect. Null means the move has not landed yet.';

-- The reconcile phase reads exactly this shape every sweep pass, so it gets an
-- index rather than a scan that grows with the ledger.
create index if not exists idx_outreach_prospects_awaiting_contacted_stage
  on public.outreach_prospects (business_id, sent_at)
  where contacted_stage_at is null and sent_at is not null;

-- grants: none (outreach_prospects): existing table, already granted; this adds
-- a column and an index, not an object.
