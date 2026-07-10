-- Voice follow-up SMS visibility.
--
-- The voice tool `/api/voice/tools/sms` (Gemini Live's `send_follow_up_sms`)
-- sent customer texts through the metered Telnyx helper but never wrote a
-- `sms_outbound_log` row, so those messages were invisible in the dashboard
-- Text history / conversation threads — the only record lived in Telnyx.
-- The route now logs every successful send with source 'voice_follow_up';
-- this migration allows that value.

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled', 'api', 'voice_follow_up'));

comment on column public.sms_outbound_log.source is
  'Where the send came from: ai_flow (send_sms step), agent_offer (route_to_team offer), owner_notify (approval/notify_owner/claim notice), owner_manual (owner-typed reply/compose from the dashboard SMS thread), owner_scheduled (scheduled template send), api (public API send), or voice_follow_up (send_follow_up_sms during a voice call).';
