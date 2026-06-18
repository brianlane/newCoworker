-- Pin search_path on the remaining public functions flagged by the Supabase
-- advisor (0011_function_search_path_mutable). A mutable search_path on a
-- function lets a caller's session search_path influence name resolution
-- inside the function; pinning it to `pg_catalog, public` (the pattern used
-- by our already-hardened functions, e.g. telnyx_webhook_rate_check) removes
-- that vector. ALTER FUNCTION ... SET search_path changes only the config,
-- not the body, so this is non-breaking.
alter function public.nonenterprise_monthly_sms_cap(text) set search_path = pg_catalog, public;
alter function public.monthly_sms_cap_for_business(text, jsonb) set search_path = pg_catalog, public;
alter function public.tg_custom_integrations_touch_updated_at() set search_path = pg_catalog, public;
alter function public.increment_usage(uuid, text, integer) set search_path = pg_catalog, public;
alter function public.claim_ai_flow_runs(integer) set search_path = pg_catalog, public;
alter function public.reclaim_stale_ai_flow_runs(integer) set search_path = pg_catalog, public;
alter function public.tg_ai_flows_touch_updated_at() set search_path = pg_catalog, public;
alter function public.escalate_overdue_agent_offers() set search_path = pg_catalog, public;
alter function public.set_customer_memories_updated_at() set search_path = pg_catalog, public;
