-- Who queued a scheduled text: the owner's composer, or the texting coworker.
--
-- schedule_text (the texting coworker's send-later tool) holds ONE pending row
-- per contact and MOVES it rather than stacking. Without this column that "one
-- row" is any pending row for that number, so a customer asking for a reminder
-- would cancel and overwrite a text the OWNER had queued from the Text history
-- composer (a birthday message, a promo) and silently replace its body and
-- time. The agent may only ever see, move, or cancel rows it created.
--
-- The dispatch log keeps a single source ('owner_scheduled', meaning "came
-- from this queue"); provenance is recoverable by joining
-- sms_outbound_log.scheduled_sms_id back to this column, so no new source
-- value and no widened check constraint.
alter table public.scheduled_sms
  add column if not exists created_by text not null default 'owner';

alter table public.scheduled_sms
  drop constraint if exists scheduled_sms_created_by_chk;
alter table public.scheduled_sms
  add constraint scheduled_sms_created_by_chk
    check (created_by in ('owner', 'sms_coworker')) not valid;

comment on column public.scheduled_sms.created_by is
  'owner = queued from the dashboard composer; sms_coworker = queued by the texting coworker via schedule_text. The agent only ever reads and cancels its own rows.';

-- The agent's pending-row lookup, which runs on every schedule_text call.
create index if not exists scheduled_sms_agent_pending_idx
  on public.scheduled_sms (business_id, to_e164, status, created_by);
