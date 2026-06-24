-- Owner-sent manual SMS visibility.
--
-- The dashboard SMS thread now lets the owner reply verbatim into a thread
-- (e.g. typing "CONFIRM" to a lead-source short code) and compose brand-new
-- messages. Those sends are logged to sms_outbound_log so they render inline
-- with the rest of the conversation, just like AiFlow/worker sends.
--
-- Add 'owner_manual' to the source check constraint. The original constraint
-- was created inline (auto-named sms_outbound_log_source_check); drop-if-exists
-- then re-add so this migration is safe regardless of the auto-generated name
-- matching on every environment.

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual'));

comment on column public.sms_outbound_log.source is
  'Where the send came from: ai_flow (send_sms step), agent_offer (route_to_team offer), owner_notify (approval/notify_owner/claim notice), or owner_manual (owner-typed reply/compose from the dashboard SMS thread).';
