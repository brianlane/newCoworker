-- Meta's two required app callbacks: Deauthorize, and Data Deletion Request.
-- Both POST a `signed_request` whose only handle on the person is an
-- APP-SCOPED user id (ASID). We stored no such id anywhere, so a callback had
-- nothing to join on: this adds the join key, plus a ledger for the deletion
-- requests (Meta requires we hand back a confirmation code and a URL where
-- the person can read the status of their request).

-- ── the join key ────────────────────────────────────────────────────────
alter table public.meta_connections
  add column if not exists meta_user_id text;

comment on column public.meta_connections.meta_user_id is
  'App-scoped id (ASID) of the Facebook user who authorized this connection, captured from /me at connect and backfillable from debug_token on the page token. The ONLY handle Meta''s deauthorize and data-deletion callbacks give us, so without it those callbacks cannot tell which tenant they concern.';

-- The callbacks look up strictly by this id. Not unique: one person can
-- legitimately connect several businesses, and every one of them must be
-- severed when they remove the app.
create index if not exists idx_meta_connections_meta_user_id
  on public.meta_connections (meta_user_id)
  where meta_user_id is not null;

-- ── the deletion-request ledger ─────────────────────────────────────────
create table if not exists public.meta_data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  -- Handed back to Meta and shown to the person; they quote it to us.
  confirmation_code text not null unique,
  -- Who asked. App-scoped, so it is meaningless outside this app.
  meta_user_id text not null,
  -- What we severed. Null when the ASID matched no connection we hold,
  -- which is a legitimate outcome and NOT an error: someone can remove an
  -- app they authorized before we started recording the id, or never
  -- finished connecting at all.
  connections_cleared integer not null default 0,
  status text not null default 'completed'
    check (status in ('completed', 'no_data', 'failed')),
  detail text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.meta_data_deletion_requests is
  'One row per Data Deletion Request callback from Meta. Deliberately holds NO personal data beyond the app-scoped id: the request is satisfied by destroying the Meta connection (tokens, page and IG identifiers, account name), and a tenant''s own CRM is never touched, since those are the business''s records about its customers and not data Facebook gave us about the requester.';

comment on column public.meta_data_deletion_requests.confirmation_code is
  'Alphanumeric code returned to Meta and quoted by the person on the status page. Unique so the status lookup can never be ambiguous.';

-- Service-role only (RLS on, zero policies): the status page reads through
-- the Next.js server after resolving the code, never from the browser.
alter table public.meta_data_deletion_requests enable row level security;
grant select, insert, update, delete
  on table public.meta_data_deletion_requests to service_role;

-- Status lookups arrive by code (already unique-indexed); this covers the
-- "everything this person ever asked for" read used by support.
create index if not exists idx_meta_deletion_requests_user
  on public.meta_data_deletion_requests (meta_user_id, requested_at desc);
