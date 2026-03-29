-- Atomic increment for daily usage counters.
-- Replaces the non-atomic read-then-write pattern in the application layer
-- with a single SQL upsert, eliminating the race condition where concurrent
-- requests could both read the same stale value and undercount usage.

create or replace function increment_usage(
  p_business_id uuid,
  p_field       text,
  p_amount      integer
) returns void language plpgsql security definer as $$
begin
  if p_field not in ('voice_minutes_used', 'sms_sent', 'calls_made', 'peak_concurrent_calls') then
    raise exception 'increment_usage: invalid field %', p_field;
  end if;

  insert into daily_usage (business_id, usage_date, voice_minutes_used, sms_sent, calls_made, peak_concurrent_calls, updated_at)
  values (
    p_business_id,
    current_date,
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

grant execute on function increment_usage(uuid, text, integer) to service_role;
