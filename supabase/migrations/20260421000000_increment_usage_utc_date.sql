-- Align `increment_usage` with UTC calendar date to match the rest of the usage /
-- SMS-cap pipeline.
--
-- Previously this function used `current_date`, which is the session-local date. All
-- monthly-cap logic — `try_reserve_sms_outbound_slot` (20260420100000), the
-- `daily_usage` month-start aggregation, and `getCalendarMonthUsageTotals` in
-- `src/lib/db/usage.ts` — keys on UTC. A non-UTC DB session calling
-- `increment_usage` near midnight could therefore land a write into a
-- `daily_usage` row keyed to a date the UTC monthly-cap aggregator skips over,
-- letting a business slip past the cap on day-boundary writes.
--
-- This migration rewrites the function to stamp `(now() at time zone 'utc')::date`
-- and adds the standard `revoke execute from public` + service-role grant that
-- the rest of the platform uses on SECURITY DEFINER helpers. Scope intentionally
-- does not overlap with `20260420100000_voice_telnyx_platform.sql` — that file
-- defines the voice/telnyx surface and handles its own REVOKEs inline; this one
-- targets `increment_usage`, which originated in
-- `20260328000001_atomic_increment_usage.sql` and was last amended by
-- `20260328225603_fix_increment_usage_peak_concurrency.sql`.

create or replace function increment_usage(
  p_business_id uuid,
  p_field       text,
  p_amount      integer
) returns void language plpgsql security definer as $$
declare
  v_today_utc date := (now() at time zone 'utc')::date;
begin
  if p_field not in ('voice_minutes_used', 'sms_sent', 'calls_made', 'peak_concurrent_calls') then
    raise exception 'increment_usage: invalid field %', p_field;
  end if;

  insert into daily_usage (business_id, usage_date, voice_minutes_used, sms_sent, calls_made, peak_concurrent_calls, updated_at)
  values (
    p_business_id,
    v_today_utc,
    case when p_field = 'voice_minutes_used'     then p_amount else 0 end,
    case when p_field = 'sms_sent'               then p_amount else 0 end,
    case when p_field = 'calls_made'             then p_amount else 0 end,
    case when p_field = 'peak_concurrent_calls'  then p_amount else 0 end,
    now()
  )
  on conflict (business_id, usage_date) do update set
    voice_minutes_used    = daily_usage.voice_minutes_used    + case when p_field = 'voice_minutes_used'    then p_amount else 0 end,
    sms_sent              = daily_usage.sms_sent              + case when p_field = 'sms_sent'              then p_amount else 0 end,
    calls_made            = daily_usage.calls_made            + case when p_field = 'calls_made'            then p_amount else 0 end,
    peak_concurrent_calls = CASE WHEN p_field = 'peak_concurrent_calls' THEN GREATEST(daily_usage.peak_concurrent_calls, p_amount) ELSE daily_usage.peak_concurrent_calls END,
    updated_at            = now();
end;
$$;

revoke execute on function increment_usage(uuid, text, integer) from public;
grant execute on function increment_usage(uuid, text, integer) to service_role;
