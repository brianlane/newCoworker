-- Track whether a per-tenant gateway token has actually been confirmed on the VPS.
--
-- A token row is INSERTED (deployed_at NULL = "pending") BEFORE deploy-client.sh
-- runs, so in-deploy /api/provisioning/progress callbacks can authenticate via the
-- inbound bearer binding. But the app keeps using the PREVIOUS secret for OUTBOUND
-- calls (app -> Rowboat summarizers) and for EXCLUSIVE tool-call JWT verification
-- until the box confirms the token (deployed_at set after a successful deploy).
-- This prevents the DB token from getting "ahead" of the VPS on a failed/partial
-- deploy (which would otherwise break summarizers + tool webhooks).
alter table vps_gateway_tokens
  add column if not exists deployed_at timestamptz;

-- Backfill: any pre-existing non-revoked rows were issued under the old
-- "active == live" model, so treat them as already deployed.
update vps_gateway_tokens
  set deployed_at = created_at
  where deployed_at is null and revoked_at is null;

-- The "one active token per business" guarantee now applies to CONFIRMED tokens:
-- a pending (not-yet-deployed) token may briefly coexist with the current
-- confirmed one during a rotation, but there is at most one DEPLOYED token per
-- business at any time.
drop index if exists uq_vps_gateway_tokens_active_business;

create unique index if not exists uq_vps_gateway_tokens_deployed_business
  on vps_gateway_tokens (business_id)
  where revoked_at is null and deployed_at is not null;
