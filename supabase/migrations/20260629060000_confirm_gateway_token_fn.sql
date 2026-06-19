-- Atomic confirm for a per-tenant gateway token.
--
-- markGatewayTokenDeployed must revoke every OTHER active token for the business
-- and stamp deployed_at on the just-deployed one as a single unit. Doing it as
-- two separate UPDATEs from app code leaves a crash window where the old token is
-- revoked but the new one isn't confirmed yet (no live secret). A plpgsql
-- function runs both statements in one transaction: if the confirm fails, the
-- revoke rolls back, so the business is never left without a confirmed token.
create or replace function confirm_gateway_token(p_business_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
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

-- service_role-only (matches the table's posture); the fn_grants_lockdown event
-- trigger also revokes anon/authenticated/public, but be explicit here too.
revoke all on function confirm_gateway_token(uuid, text) from public;
grant execute on function confirm_gateway_token(uuid, text) to service_role;
