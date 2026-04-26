-- Compensating decrement for `customer_profiles.lifetime_subscription_count`.
--
-- Background: `increment_customer_profile_lifetime_count` is called from
-- the Stripe webhook orchestrators (`runChangePlanFromCheckout`,
-- `runResubscribeFromCheckout`) BEFORE `orchestrateProvisioning`. If
-- provisioning fails afterwards, the orchestrator cancels the freshly
-- minted Stripe subscription, but historically it did NOT roll the
-- counter back. The effect was that transient provisioning failures
-- would permanently burn a lifetime slot off the 3-count cap even
-- though the customer never received service.
--
-- This function is the compensating action: subtract 1, floor at zero
-- so replays can never produce a negative count. It is ONLY called from
-- trusted server-side code (the webhook orchestrators) after a cap
-- slot was just consumed for a provisioning attempt that subsequently
-- failed; never from user-facing routes.

create or replace function public.decrement_customer_profile_lifetime_count(
  p_profile_id uuid
) returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_count integer;
begin
  update customer_profiles
    set lifetime_subscription_count = greatest(lifetime_subscription_count - 1, 0),
        updated_at = now()
    where id = p_profile_id
    returning lifetime_subscription_count into v_count;

  if v_count is null then
    raise exception 'decrement_customer_profile_lifetime_count: profile not found %', p_profile_id;
  end if;

  return v_count;
end;
$$;

revoke all on function public.decrement_customer_profile_lifetime_count(uuid) from public;
revoke all on function public.decrement_customer_profile_lifetime_count(uuid) from anon;
revoke all on function public.decrement_customer_profile_lifetime_count(uuid) from authenticated;
grant execute on function public.decrement_customer_profile_lifetime_count(uuid) to service_role;
