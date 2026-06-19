-- Enforce ONE active per-tenant gateway token per business.
--
-- The app's exclusive verification (a business with a per-tenant token rejects
-- the shared token, and Rowboat's tool-call JWT is verified ONLY against the
-- per-tenant secret) assumes a single live token per business. A concurrent
-- double-mint (two provision/rotate runs racing) could otherwise leave two
-- active rows and make verification non-deterministic.
--
-- Replace the non-unique active-business index with a partial UNIQUE index so a
-- second concurrent insert fails loudly instead of creating a duplicate. The
-- existing per-sha unique index still guards token collisions.
drop index if exists idx_vps_gateway_tokens_business_active;

create unique index if not exists uq_vps_gateway_tokens_active_business
  on vps_gateway_tokens (business_id)
  where revoked_at is null;
