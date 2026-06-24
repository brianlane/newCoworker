-- Staff SMS mode.
--
-- Until now an inbound SMS from the business owner or a roster team member was
-- gated out of the customer AI path and silently forwarded to the owner's cell
-- (telnyx-sms-inbound respondTeamMemberGate). That mirrors how staff should be
-- distinguished from customers, but it left staff unable to actually interact
-- with the assistant over text the way they can in the dashboard chat.
--
-- These flags make staff a first-class interactive channel:
--   * staff_sms_assistant_reply_enabled — when true, a staff text gets an
--     internal-assistant reply (staff mode: no lead intake, no customer
--     profile) instead of a silent forward. Default TRUE — this is the new
--     product behavior ("reply, don't just forward").
--   * staff_sms_forward_to_owner_enabled — when true, ALSO relay the staff text
--     to the owner's cell (independent of the reply). Default FALSE — the old
--     unconditional forward is now opt-in.
alter table business_telnyx_settings
  add column if not exists staff_sms_assistant_reply_enabled boolean not null default true,
  add column if not exists staff_sms_forward_to_owner_enabled boolean not null default false;

comment on column business_telnyx_settings.staff_sms_assistant_reply_enabled is
  'When true, an inbound SMS from the owner or a team member gets an internal-assistant reply (staff mode) instead of being forwarded. Default true.';
comment on column business_telnyx_settings.staff_sms_forward_to_owner_enabled is
  'When true, relay an inbound staff SMS to the owner cell, independent of the assistant reply. Default false.';

-- Thread staff identity onto the queued job so the worker builds the staff
-- persona (no customer profile, no lead-intake script) instead of the
-- customer one. NULL = an ordinary customer job (the existing path, unchanged).
-- claim_sms_inbound_jobs returns `setof sms_inbound_jobs`, so the worker reads
-- these columns with no RPC change.
alter table sms_inbound_jobs
  add column if not exists staff_kind text,
  add column if not exists staff_name text;

alter table sms_inbound_jobs
  drop constraint if exists sms_inbound_jobs_staff_kind_chk;
alter table sms_inbound_jobs
  add constraint sms_inbound_jobs_staff_kind_chk
  check (staff_kind is null or staff_kind in ('owner', 'team'));
