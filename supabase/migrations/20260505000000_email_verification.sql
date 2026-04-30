-- Track user-initiated email verification on customer_profiles.
--
-- Distinct from `auth.users.email_confirmed_at`, which the
-- `/api/onboard/set-password` route deliberately stamps via
-- `auth.admin.createUser({ email_confirm: true })` so the post-payment
-- `signInWithPassword` works without a Supabase confirmation roundtrip
-- (the original 494 REQUEST_HEADER_TOO_LARGE failure surface — see that
-- route's docstring). That admin flag means "Supabase considers the
-- email valid for sign-in"; it does NOT mean "the human pressed a
-- confirmation link in their inbox". We need that second signal too,
-- both for an "is this email reachable?" trust check and so the
-- dashboard can surface a "confirm your email" banner with a Resend
-- button.
--
-- The HMAC-signed token in `src/lib/email/verification-token.ts` carries
-- the email + issued-at; on a successful click the verify-email route
-- stamps this column. Once non-null, the dashboard banner stops
-- rendering. The banner's resend control regenerates a fresh token —
-- this column is the only persisted state.
--
-- Backfill: every existing profile is set to NOW() so customers who
-- onboarded before this feature don't suddenly see an unactionable
-- "confirm your email" banner on their dashboard. Going forward, new
-- profiles default to NULL and must verify.

alter table customer_profiles
  add column if not exists email_verified_at timestamptz;

update customer_profiles
  set email_verified_at = now()
  where email_verified_at is null;
