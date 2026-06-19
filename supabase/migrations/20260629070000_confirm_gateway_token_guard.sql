-- Harden confirm_gateway_token: only revoke the other active tokens once we know
-- p_token actually matches a LIVE (non-revoked) row for the business.
--
-- The previous version revoked every other active token first and THEN stamped
-- deployed_at on p_token. If p_token was wrong/missing, the revoke wiped the only
-- confirmed secret while the stamp touched zero rows, stranding the tenant with no
-- active gateway token. Guarding first (and raising when there's no match, which
-- rolls back the whole transaction) makes a bad call a no-op instead of a footgun.
create or replace function confirm_gateway_token(p_business_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Refuse to touch anything unless the target token is a live row for this
  -- business. Raising rolls back atomically, so no revoke happens on a bad call.
  if not exists (
    select 1
    from vps_gateway_tokens
    where business_id = p_business_id
      and token = p_token
      and revoked_at is null
  ) then
    raise exception
      'confirm_gateway_token: no live token for business % matches the supplied token',
      p_business_id;
  end if;

  -- Revoke any other still-active tokens FIRST so the one-confirmed-token unique
  -- index is never violated when we set deployed_at below.
  update vps_gateway_tokens
    set revoked_at = now()
    where business_id = p_business_id
      and revoked_at is null
      and token <> p_token;

  update vps_gateway_tokens
    set deployed_at = now()
    where business_id = p_business_id
      and token = p_token
      and revoked_at is null;
end;
$$;

revoke all on function confirm_gateway_token(uuid, text) from public;
grant execute on function confirm_gateway_token(uuid, text) to service_role;
