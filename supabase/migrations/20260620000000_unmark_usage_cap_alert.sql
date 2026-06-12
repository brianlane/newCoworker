-- Cap-alert delivery fix (Cursor Bugbot, PR #143 "Failed alert blocks retries"):
-- sendCapAlertOnce claims the once-per-period guard row BEFORE posting to the
-- notifications function. If the POST then fails, the row stayed claimed and
-- every later cap hit returned already_alerted — the owner never got the
-- urgent notification for that period. The worker now rolls the claim back on
-- a failed post via this RPC so the next cap hit retries the alert.
create or replace function public.unmark_usage_cap_alert(
  p_business_id uuid,
  p_cap_kind text,
  p_period_key text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.usage_cap_alerts
  where business_id = p_business_id
    and cap_kind = p_cap_kind
    and period_key = p_period_key;
end;
$$;

revoke execute on function public.unmark_usage_cap_alert(uuid, text, text) from public;
grant execute on function public.unmark_usage_cap_alert(uuid, text, text) to service_role;
