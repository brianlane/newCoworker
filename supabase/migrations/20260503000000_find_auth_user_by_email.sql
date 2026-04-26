-- Helper for the grace-sweep cron + admin delete/force-refund routes.
-- Returns the auth.users.id whose email (case-insensitively) matches
-- `p_email`, or NULL if none.
--
-- Rationale: the TypeScript fallback uses `auth.admin.listUsers({ page,
-- perPage })` which linearly scans the entire auth user directory on
-- every miss. For the grace-sweep cron that runs per-row, a nonexistent
-- email hammers the auth API up to `PAGE_CAP * batchSize` times per
-- tick. A SECURITY DEFINER lookup keyed on `auth.users.email` closes
-- that hot path with a single index scan.
--
-- SECURITY: the function is SECURITY DEFINER (runs as the migration
-- role) and limited to `service_role`, so no extra read privilege
-- leaks to anon/authenticated clients. It returns only the id; no
-- email/metadata exfiltration path.
create or replace function public.find_auth_user_id_by_email(
  p_email text
) returns uuid
  language sql
  security definer
  set search_path = public, auth
as $$
  select id
    from auth.users
    where lower(email) = lower(trim(p_email))
    limit 1;
$$;

revoke all on function public.find_auth_user_id_by_email(text) from public;
revoke all on function public.find_auth_user_id_by_email(text) from anon;
revoke all on function public.find_auth_user_id_by_email(text) from authenticated;
grant execute on function public.find_auth_user_id_by_email(text) to service_role;
