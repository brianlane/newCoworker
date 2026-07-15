-- Allow 'mcp' as an sms_outbound_log source: outbound texts sent through
-- the Claude connector's MCP send_sms tool (src/lib/mcp/tools/sms.ts).
-- Same pattern as the 'api' (Zapier) and 'voice_follow_up' additions —
-- the column's CHECK is the single enum-ish gate, extended in lockstep
-- with the OutboundLogSource type in src/lib/db/sms-history.ts.

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled', 'api', 'voice_follow_up', 'mcp'));
