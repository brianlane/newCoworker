-- Clickwrap acceptance ledger for the public legal documents (Terms of
-- Service + Privacy Policy). One row per explicit "I agree" click:
--
--   * source 'signup': the account-creation forms (the create-password step
--     on /onboard/success via /api/onboard/set-password, and the standalone
--     /signup form's pre-session evidence row).
--   * source 'gate': the dashboard re-acceptance gate (first sign-in for
--     OAuth/passkey/magic-link users and accounts predating this ledger,
--     and everyone again when a version in src/lib/legal/versions.ts bumps).
--
-- The version columns pin the effective-date strings rendered on /terms and
-- /privacy at click time, so "which text did this person accept" is a
-- lookup, not an inference. Insert-only by design: rows are evidence and
-- are never updated; the email-keyed signup row (user_id null while email
-- confirmation is pending) stands as corroboration beside the user-linked
-- rows rather than being merged into them.
create table if not exists public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  business_id uuid,
  terms_version text not null,
  privacy_version text not null,
  source text not null check (source in ('signup', 'gate')),
  accepted_at timestamptz not null default now(),
  -- Evidence fields, same shape and caps as document_signature_requests.
  ip text,
  user_agent text,
  -- Every row must identify someone: a user id, or the pre-session email.
  constraint terms_acceptances_identity check (user_id is not null or email is not null)
);

-- The dashboard gate's read: newest acceptance per user.
create index if not exists idx_terms_acceptances_user
  on public.terms_acceptances (user_id, accepted_at desc);
-- Pre-session signup evidence lookup by email.
create index if not exists idx_terms_acceptances_email
  on public.terms_acceptances (email);

alter table public.terms_acceptances enable row level security;
-- RLS on with zero policies: service-role only. The gate reads through the
-- server's service client; browsers never touch this table directly.
grant select, insert on table public.terms_acceptances to service_role;
