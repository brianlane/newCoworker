-- Supabase security-advisor cleanup (security review G8): clear the two
-- `extension_in_public` WARNs by re-homing pg_net and citext out of `public`.
--
-- Why this is safe (verified against the live project before writing this):
--
-- pg_net (v0.20, extrelocatable = false → must drop/recreate):
--   pg_net's install SQL hardcodes EVERY object it owns into its own `net`
--   schema (`create schema if not exists net; create function net.http_post
--   …`) — the extension's registered schema (pg_extension.extnamespace) is
--   pure metadata for it. Re-registering under `extensions` therefore
--   changes nothing callers see: all pg_cron jobs keep calling
--   net.http_post(...) exactly as before. The drop discards only pg_net's
--   UNLOGGED transient queue tables (net.http_request_queue,
--   net._http_response), which hold in-flight HTTP requests for seconds.
--   Quiet-window note: a cron tick firing in the instant between drop and
--   create errors once and self-heals on its next schedule.
--
-- citext (v1.6, extrelocatable = true → plain ALTER):
--   Used by tenant_mailboxes.local_part (case-insensitive unique index).
--   The unique index and the column bind citext's type/operators by OID,
--   not by name, so relocation cannot break them. Name-based resolution
--   (PostgREST `eq` filters, ad-hoc SQL) keeps working because the
--   database default search_path is `"$user", public, extensions` — the
--   destination schema is already searched. The repo's pinned-search_path
--   functions (search_path = pg_catalog, public) were audited: none touch
--   citext columns or operators.

create schema if not exists extensions;

do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on e.extnamespace = n.oid
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) then
    drop extension pg_net;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    create extension pg_net schema extensions;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'citext') then
    create extension citext schema extensions;
  elsif exists (
    select 1
    from pg_extension e
    join pg_namespace n on e.extnamespace = n.oid
    where e.extname = 'citext' and n.nspname = 'public'
  ) then
    alter extension citext set schema extensions;
  end if;
end
$$;
