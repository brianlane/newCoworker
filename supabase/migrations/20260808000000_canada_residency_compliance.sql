-- Canada / BYOS PII compliance levers (Enterprise BYOS + Canada residency, PR 6).
--
-- Two per-tenant knobs for the "content at rest stays on the tenant's box"
-- story required by Canadian-residency (PIPEDA / Quebec Law 25) and
-- insurance/legal deals:
--
-- 1. businesses.residency_backup_destination — where the box's encrypted
--    residency dumps GO:
--      'central' (default) — ciphertext uploaded to central Supabase
--                            Storage (US). Content at rest in the US is
--                            ciphertext only; the AES key never leaves
--                            escrow. Today's behavior.
--      'onbox'             — dumps stay ON THE BOX (rotated locally, no
--                            upload). For Canadian tenants this keeps even
--                            ciphertext in-region; DR depends on the box
--                            (disclosed trade, per deal).
--
-- 2. residency_backup_keys.custody — who holds the AES passphrase:
--      'escrowed'      (default) — platform escrow; a dead box stays
--                                  restorable by support. Today's behavior.
--      'customer_held' — the platform DROPS the plaintext passphrase and
--                        keeps only its SHA-256 fingerprint. Platform-
--                        managed backups are uninstalled on the next
--                        deploy; the customer owns DR end-to-end. The
--                        platform can never decrypt or restore for them.
--
-- Both are code-gated to enterprise (the columns stay tier-agnostic, same
-- policy as data_residency_mode / vps_provider).

alter table public.businesses
  add column if not exists residency_backup_destination text not null default 'central';

alter table public.businesses
  drop constraint if exists businesses_residency_backup_destination_check;

alter table public.businesses
  add constraint businesses_residency_backup_destination_check
  check (residency_backup_destination in ('central', 'onbox'));

comment on column public.businesses.residency_backup_destination is
  'Where encrypted residency dumps go: central (ciphertext to central Storage, default) | onbox (dumps stay on the tenant box — in-region even for ciphertext).';

alter table public.residency_backup_keys
  add column if not exists custody text not null default 'escrowed';

alter table public.residency_backup_keys
  drop constraint if exists residency_backup_keys_custody_check;

alter table public.residency_backup_keys
  add constraint residency_backup_keys_custody_check
  check (custody in ('escrowed', 'customer_held'));

-- customer_held rows drop the plaintext and keep only a fingerprint.
alter table public.residency_backup_keys
  alter column passphrase drop not null;

alter table public.residency_backup_keys
  add column if not exists passphrase_sha256 text;

alter table public.residency_backup_keys
  drop constraint if exists residency_backup_keys_custody_shape_check;

-- Shape invariant: escrowed rows MUST carry the plaintext; customer_held
-- rows MUST NOT (fingerprint only).
alter table public.residency_backup_keys
  add constraint residency_backup_keys_custody_shape_check
  check (
    (custody = 'escrowed' and passphrase is not null)
    or (custody = 'customer_held' and passphrase is null)
  );

comment on column public.residency_backup_keys.custody is
  'escrowed (default: platform can restore a dead box) | customer_held (plaintext dropped, fingerprint only — customer owns DR; platform cannot decrypt).';
comment on column public.residency_backup_keys.passphrase_sha256 is
  'SHA-256 fingerprint of the (former) passphrase, retained for audit after a customer_held custody flip.';
