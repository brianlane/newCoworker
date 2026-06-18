-- Per-tenant Rowboat/VPS gateway tokens.
--
-- Replaces the single platform-wide `ROWBOAT_GATEWAY_TOKEN` (shared by every
-- tenant VPS) with a distinct token per business, so a compromise of one VPS
-- cannot impersonate another tenant. The token is used two ways by the VPS:
--   1. Bearer auth on VPS -> app calls (/api/voice/tools/*, nango proxy,
--      custom credentials, aiflows send-owner-email, provisioning progress).
--   2. The HMAC secret Rowboat signs its tool-call JWT (x-signature-jwt) with.
--
-- (2) needs the symmetric secret in plaintext on BOTH sides, so we store the
-- plaintext token here. This is acceptable because:
--   * The row is service_role-only (RLS on, no policies) — anon/authenticated
--     get nothing, identical posture to vps_ssh_keys / integration secrets.
--   * Each VPS only ever holds its OWN token; the central app DB is the trusted
--     store and is never placed on a tenant box. So one VPS breach leaks only
--     that tenant's token, not the fleet's.
-- `token_sha256` is a lookup index for the bearer path (constant-time-ish O(1)
-- resolution token -> business without scanning plaintext).

create table if not exists vps_gateway_tokens (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  token text not null,
  token_sha256 text not null,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One active token per sha (rotations revoke the old row, insert a new one).
create unique index if not exists uq_vps_gateway_tokens_active_sha
  on vps_gateway_tokens (token_sha256)
  where revoked_at is null;

create index if not exists idx_vps_gateway_tokens_business_active
  on vps_gateway_tokens (business_id)
  where revoked_at is null;

alter table vps_gateway_tokens enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated have no access by design.
