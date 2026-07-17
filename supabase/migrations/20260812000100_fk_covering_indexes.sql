-- Foreign-key covering indexes (Supabase performance advisor
-- `unindexed_foreign_keys`, 27 findings) + removal of provably-redundant
-- duplicate indexes (subset of the `unused_index` findings).
--
-- Postgres does NOT auto-index the referencing side of a foreign key.
-- Every DELETE (or PK UPDATE) on the referenced table makes the FK trigger
-- scan the child table for matching rows — without an index that is a full
-- table scan per parent row. The paths that hurt here are exactly the
-- platform's bulk-delete surfaces: business deletion (admin delete-user /
-- account wipe cascades), the daily data-retention sweep, and privacy
-- erasure (src/lib/privacy/deletion.ts), all of which delete parents with
-- many children (businesses, contacts, dashboard_chat_messages,
-- voice_reservations, ...).
--
-- Plain single-column btrees, named idx_<table>_<column>. Sizes are trivial
-- at current row counts; the win is turning O(child-table) FK checks into
-- O(log n) lookups forever.

create index if not exists idx_agent_runs_input_document_id
  on public.agent_runs (input_document_id);
create index if not exists idx_ai_flow_library_downloads_business_id
  on public.ai_flow_library_downloads (business_id);
create index if not exists idx_ai_flow_run_steps_business_id
  on public.ai_flow_run_steps (business_id);
create index if not exists idx_applied_oneshots_business_id
  on public.applied_oneshots (business_id);
create index if not exists idx_business_documents_assigned_employee_id
  on public.business_documents (assigned_employee_id);
-- idx_business_documents_contact exists but keys (business_id, contact_id):
-- useless for the FK trigger's contact_id-only lookup.
create index if not exists idx_business_documents_contact_id
  on public.business_documents (contact_id);
create index if not exists idx_business_members_employee_id
  on public.business_members (employee_id);
-- contacts_owner_employee_idx exists but keys (business_id, owner_employee_id):
-- useless for the FK trigger's owner_employee_id-only lookup.
create index if not exists idx_contacts_owner_employee_id
  on public.contacts (owner_employee_id);
create index if not exists idx_coworker_logs_business_id
  on public.coworker_logs (business_id);
create index if not exists idx_dashboard_chat_jobs_business_id
  on public.dashboard_chat_jobs (business_id);
create index if not exists idx_dashboard_chat_jobs_user_message_id
  on public.dashboard_chat_jobs (user_message_id);
create index if not exists idx_dashboard_chat_jobs_assistant_message_id
  on public.dashboard_chat_jobs (assistant_message_id);
create index if not exists idx_email_campaign_recipients_business_id
  on public.email_campaign_recipients (business_id);
create index if not exists idx_employee_time_off_member_id
  on public.employee_time_off (member_id);
create index if not exists idx_messenger_jobs_business_id
  on public.messenger_jobs (business_id);
create index if not exists idx_messenger_jobs_user_message_id
  on public.messenger_jobs (user_message_id);
create index if not exists idx_sessions_business_id
  on public.sessions (business_id);
create index if not exists idx_voice_call_transcripts_reservation_id
  on public.voice_call_transcripts (reservation_id);
create index if not exists idx_voice_settlements_reservation_id
  on public.voice_settlements (reservation_id);
create index if not exists idx_voice_settlements_business_id
  on public.voice_settlements (business_id);
create index if not exists idx_vps_inventory_assigned_business_id
  on public.vps_inventory (assigned_business_id);
create index if not exists idx_webchat_jobs_business_id
  on public.webchat_jobs (business_id);
create index if not exists idx_webchat_jobs_user_message_id
  on public.webchat_jobs (user_message_id);
create index if not exists idx_webchat_jobs_assistant_message_id
  on public.webchat_jobs (assistant_message_id);
create index if not exists idx_webhook_subscriptions_api_key_id
  on public.webhook_subscriptions (api_key_id);
create index if not exists idx_white_glove_intakes_business_id
  on public.white_glove_intakes (business_id);
create index if not exists idx_white_glove_intakes_applied_flow_id
  on public.white_glove_intakes (applied_flow_id);

-- ── Redundant duplicates ────────────────────────────────────────────────
-- Only indexes whose key columns are an EXACT duplicate of — or a strict
-- leading prefix of — another index on the same table are dropped; every
-- query (and FK check) the dropped index could serve is served by the
-- surviving index's prefix. Verified against live pg_index definitions:
--
--   idx_daily_usage_biz_date            = (business_id, usage_date)
--     duplicate of unique daily_usage_business_id_usage_date_key
--   ai_flow_run_steps_run_id_idx        = (run_id, step_index)
--     duplicate of unique ai_flow_run_steps_run_step_idx
--   integrations_business_id_idx        = (business_id)
--     prefix of unique integrations_business_id_provider_key
--   custom_integrations_business_id_idx = (business_id)
--     prefix of unique custom_integrations_business_id_label_key
--   workspace_oauth_connections_business_id_idx = (business_id)
--     prefix of unique ..._business_provider_connection_key
--   idx_sms_opt_outs_business           = (business_id)
--     prefix of pkey (business_id, sender_e164)
--
-- The remaining zero-scan indexes from the advisor's `unused_index` list
-- are deliberately KEPT: they serve rare-but-real paths (prune sweeps,
-- birthday/renewal scans, recently-shipped features) where "0 scans since
-- stats began" reflects the feature's age or tiny table sizes, not
-- uselessness — and dropping a needed index costs far more than carrying a
-- few 16 kB ones.

drop index if exists public.idx_daily_usage_biz_date;
drop index if exists public.ai_flow_run_steps_run_id_idx;
drop index if exists public.integrations_business_id_idx;
drop index if exists public.custom_integrations_business_id_idx;
drop index if exists public.workspace_oauth_connections_business_id_idx;
drop index if exists public.idx_sms_opt_outs_business;
