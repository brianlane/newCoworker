-- Allow 'mcp_chatgpt' as an sms_outbound_log source.
--
-- Follows the same drop-and-re-add shape as every other source migration here
-- (each one restates the whole allowed set, so this list is the current truth).
--
-- Why a second MCP value rather than reusing 'mcp': the dashboard thread view
-- renders 'mcp' as "Claude connector", so a text sent from ChatGPT was
-- attributed to Claude in the owner's own history. Existing rows genuinely
-- ARE Claude sends, so 'mcp' keeps its meaning and ChatGPT gets its own value
-- rather than the rows being rewritten.
--
-- grants: none (sms_outbound_log): pre-existing table, unchanged access

alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled', 'api', 'voice_follow_up', 'mcp', 'mcp_chatgpt', 'dashboard_chat', 'owner_alert'));
