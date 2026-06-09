-- Pending account-email changes (self-serve email change from the dashboard).
--
-- Businesses are keyed by `owner_email` (no stable owner_user_id column), so
-- changing the Supabase auth email would orphan the owner from their business
-- unless `businesses.owner_email` is updated in lockstep. We CANNOT update
-- owner_email at initiation time, because the auth email only actually flips
-- AFTER the user clicks the confirmation link Supabase emails them — updating
-- early would lock the owner out the moment they request a change but before
-- they confirm (or if they never confirm).
--
-- Flow:
--   1. /api/account/email records a pending row {user_id, old_email, new_email}
--      and calls supabase.auth.updateUser({ email }), which sends Supabase's
--      confirmation email(s). Auth email is unchanged until the link is clicked.
--   2. Once the live auth email == new_email (confirmed), reconciliation runs
--      from /api/auth/callback AND every dashboard render: it moves EVERY
--      business still keyed to `old_email` onto the new email, then deletes the
--      pending row. owner_email therefore only ever changes once the auth email
--      has genuinely changed — no lockout window.
--
-- One pending change per user (PK on user_id): requesting a new change replaces
-- any prior unconfirmed one. Reconciliation is keyed off `old_email` (not a
-- single business id) so an owner with multiple businesses under the same email
-- has all of them follow the new login — and so we avoid a business_id FK whose
-- ON DELETE CASCADE could wipe an in-flight change.
--
-- Service-role only: written/read exclusively by Next.js routes using the
-- service client. RLS is enabled with NO policies so the anon/authenticated
-- roles can never see another owner's in-flight email change.
create table if not exists public.pending_email_changes (
  user_id uuid primary key,
  old_email text not null,
  new_email text not null,
  created_at timestamptz not null default now()
);

-- Callback lookup is by user_id (the PK), so no extra index is required.

alter table public.pending_email_changes enable row level security;

comment on table public.pending_email_changes is
  'In-flight self-serve account email changes. Bridges Supabase auth email confirmation to businesses.owner_email so an email change never orphans the owner from their business. Service-role only (RLS enabled, no policies).';
