-- Per-business overrides for enterprise tier (merged with TIER_LIMITS.enterprise in app + Edge).
alter table public.businesses
  add column if not exists enterprise_limits jsonb;

comment on column public.businesses.enterprise_limits is
  'Optional JSON overrides for enterprise TierLimits keys: voiceMinutesPerDay, voiceIncludedSecondsPerStripePeriod, smsPerDay, callsPerDay, maxConcurrentCalls, smsThrottled. Omitted keys use code defaults.';
