-- A Meta page token can stop working without anyone touching New Coworker:
-- the owner changes their Facebook password, loses their Page admin role, or
-- removes the app. Every call then fails with Meta error code 190, and until
-- now NOTHING noticed: the constant META_ERROR_CODE_BAD_TOKEN had zero call
-- sites, so leads, DMs, comment replies, IG publishing, and CAPI uploads all
-- failed silently while the dashboard kept saying "Connected".
--
-- `token_invalid_at` is that missing signal.
--
-- Deliberately a NEW column rather than reusing `is_active`. That flag is the
-- OWNER'S PAUSE SWITCH (PATCH /api/integrations/meta), it renders as "paused"
-- on the integrations card, and both the publish sweep and the CAPI drain
-- read it as "defer, do not fail". Overloading it would tell an owner who
-- paused their own connection that their token died, and would make a dead
-- token look like a deliberate pause to two sweeps.

alter table public.meta_connections
  add column if not exists token_invalid_at timestamptz;

comment on column public.meta_connections.token_invalid_at is
  'When Meta first answered error code 190 (token expired/invalidated) for this connection. Null while the token is believed good, and cleared on every successful reconnect. Distinct from is_active, which is the owner''s own pause switch: this one means "your credential died", not "I turned this off".';

-- The health sweep and the owner-alert dedupe both scan for connections that
-- are live but flagged, which is a tiny slice of the table.
create index if not exists idx_meta_connections_token_invalid
  on public.meta_connections (token_invalid_at)
  where token_invalid_at is not null;
