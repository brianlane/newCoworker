-- Allow 'owner_alert' as an sms_outbound_log source: urgent owner-alert
-- texts (needs-human pages, cap alerts, missed-call spikes, AiFlow failure
-- alerts) sent by the notifications Edge function and its Node mirror
-- (src/lib/notifications/dispatch.ts). These sends were metered but never
-- logged, so the owner's Messages thread could not show that they were
-- paged (observed live: the Jul 17 2026 Amy Laidlaw needs-human page was
-- Telnyx-accepted yet invisible on the dashboard). Same pattern as the
-- 'api' / 'voice_follow_up' / 'mcp' / 'dashboard_chat' additions — the
-- column's CHECK is the single enum-ish gate, extended in lockstep with
-- the OutboundLogSource type in src/lib/db/sms-history.ts.

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled', 'api', 'voice_follow_up', 'mcp', 'dashboard_chat', 'owner_alert'));

comment on column public.sms_outbound_log.source is
  'Where the send came from: ai_flow (send_sms step), agent_offer (route_to_team offer), owner_notify (approval/notify_owner/claim notice), owner_manual (owner-typed reply/compose from the dashboard SMS thread), owner_scheduled (scheduled template send), api (public API send), voice_follow_up (send_follow_up_sms during a voice call), mcp (Claude connector send_sms), dashboard_chat (dashboard coworker send_sms tool), or owner_alert (urgent owner alert from the notifications pipeline).';
