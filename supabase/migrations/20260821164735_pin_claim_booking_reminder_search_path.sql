-- Pin search_path on claim_booking_reminder (Supabase advisor 0011,
-- function_search_path_mutable).
--
-- 20260821013000_booking_reminders.sql created the function without the
-- `set search_path = pg_catalog, public` every other public function carries,
-- so the production advisor started reporting a WARN. A mutable search_path
-- lets a caller's session search_path influence name resolution inside the
-- function; the body here is fully schema-qualified and the function is
-- service_role-only, so the practical risk is low, but "the advisor is clean
-- on our side of the fence" is a posture we state to buyers (README
-- "Security standards & posture"), and an unexplained WARN devalues it.
--
-- ALTER FUNCTION ... SET search_path changes only the config, not the body,
-- so this is non-breaking. The original migration is left untouched: it is
-- already recorded in the production ledger, and the repo does not rewrite
-- applied migrations.
alter function public.claim_booking_reminder(uuid, text)
  set search_path = pg_catalog, public;
