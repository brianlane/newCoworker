-- Allow 'dashboard_chat' as an sms_outbound_log source: outbound texts the
-- dashboard-chat assistant sends through its send_sms tool (both the inline
-- executor in src/lib/dashboard-chat/action-tools.ts and the Rowboat
-- webhook dispatch). These sends were metered but never logged — the KYP
-- Ads test texts were invisible on the Texts page — and the first logging
-- attempt would have violated this CHECK on every insert (errors swallowed
-- by design). Same pattern as the 'api' / 'voice_follow_up' / 'mcp'
-- additions — the column's CHECK is the single enum-ish gate, extended in
-- lockstep with the OutboundLogSource type in src/lib/db/sms-history.ts.

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled', 'api', 'voice_follow_up', 'mcp', 'dashboard_chat'));
