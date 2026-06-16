-- Per-tenant AI coworker mailboxes.
--
-- Each business gets ONE dedicated inbound/outbound address at the platform
-- email domain (default `<business uuid>@<EMAIL_DOMAIN>`; standard/enterprise
-- tiers may personalize the local-part). The address is the AI coworker's own
-- mailbox — separate from both the platform team inbox and the owner's
-- Nango-connected Gmail/Outlook.
--
-- Inbound mail is caught by Cloudflare Email Routing's catch-all -> Email
-- Worker -> /api/email/inbound, which resolves the tenant by local-part here.
-- Outbound flow sends use this address as the Resend `from`.
--
-- citext gives case-insensitive uniqueness so `Amy@` and `amy@` can never both
-- be claimed; the app also lowercases on write as defense in depth.

create extension if not exists citext;

create table if not exists public.tenant_mailboxes (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- Local-part only (the bit before "@"); the domain is configured per env.
  -- Lowercased by the app; citext makes the unique index case-insensitive.
  local_part citext not null unique
    check (length(local_part::text) between 1 and 64
           and local_part::text ~ '^[a-z0-9][a-z0-9._-]*$'),
  -- True once an owner has chosen a custom handle (vs. the UUID default).
  personalized boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenant_mailboxes is
  'Per-business AI coworker email address (local-part). Default is the business UUID; standard/enterprise tiers may personalize. Resolved by the inbound email webhook and used as the outbound Resend From.';

-- Service-role writes/reads only (provisioning + inbound webhook + dashboard
-- route all use the service client); RLS enabled with no policies so anon /
-- authenticated clients can never enumerate another tenant's address.
alter table public.tenant_mailboxes enable row level security;
