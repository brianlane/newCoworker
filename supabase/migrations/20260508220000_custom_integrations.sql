-- Per-business custom HTTP integrations.
--
-- Lets the owner register `(label, base_url, auth_scheme, secret)` triples
-- for arbitrary REST APIs. The Rowboat agent calls the platform's
-- `/api/integrations/custom/call` proxy with `(businessId, label, method,
-- path, body)` and the platform decrypts the secret server-side, injects
-- it according to `auth_scheme`, and forwards the request. This keeps the
-- credential off the VPS / Rowboat / model context entirely — the agent
-- only ever sees the label.
--
-- Why a separate table from `public.integrations`:
--   - `integrations` has UNIQUE (business_id, provider) baked in, which
--     blocks owners from registering two flavors of the same provider
--     (dev + prod, two CRMs, etc.).
--   - `integrations.provider` is a fixed-shape text used for OAuth /
--     workspace-style connections; we don't want every fresh API key the
--     owner adds to mint a new global enum value.
--   - Different audit semantics: `custom_integrations` is a freeform
--     credential store with a tightly bounded per-row schema, not an
--     account-linkage row.

create table if not exists public.custom_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Owner-chosen human label. The agent picks a custom integration by
  -- this string, so it must be unique within a business and short enough
  -- that the model can refer to it without copy-paste errors.
  label text not null check (
    length(trim(label)) between 1 and 80
    and label !~ '[\u0000-\u001f]'
  ),
  -- Always https. The check is enforced again in app code; keeping a
  -- DB-level guardrail makes it impossible to accidentally degrade to
  -- http through a buggy upsert path.
  base_url text not null check (base_url ~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$'),
  -- How the proxy injects the secret on every outbound call.
  --   bearer  -> Authorization: Bearer <secret>
  --   header  -> <header_name>: <secret>
  --   basic   -> Authorization: Basic base64(<secret>) where secret = "user:pass"
  --   query   -> append ?<header_name>=<urlencode(secret)>
  --   none    -> no auth (public APIs)
  auth_scheme text not null check (
    auth_scheme in ('bearer', 'header', 'basic', 'query', 'none')
  ),
  -- Required when auth_scheme in ('header', 'query'); ignored otherwise.
  -- App code enforces the conditional. Header names per RFC 7230 are
  -- token = 1*tchar; the regex below intentionally errs on the strict
  -- side ("looks like X-Api-Key" rather than "any byte string").
  header_name text check (
    header_name is null
    or (length(header_name) between 1 and 128 and header_name ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]+$')
  ),
  -- AES-256-GCM ciphertext (encryptIntegrationSecret format
  -- `enc:v1:<iv>:<tag>:<ct>`). Null only for auth_scheme='none'.
  secret_encrypted text,
  -- Owner-facing description; surfaced in UI + agent's tool listing
  -- ("Use the 'Acme CRM' integration to look up a contact by email.").
  description text check (length(coalesce(description, '')) <= 500),
  -- Soft-disable flag: the row stays around (so historical audit logs
  -- still resolve a label to a row) but the proxy refuses calls.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One label per business. Two businesses can both have an "Acme" row.
  unique (business_id, label)
);

create index if not exists custom_integrations_business_id_idx
  on public.custom_integrations (business_id);

-- Hot path on the proxy: resolve (business_id, lower(label)) to a row.
-- The unique constraint above is case-sensitive on label; we rely on
-- app-side lower() at lookup time so "Acme" and "acme" do not silently
-- collide here, but a partial functional index keeps the lookup O(1).
create index if not exists custom_integrations_business_label_lower_idx
  on public.custom_integrations (business_id, lower(label))
  where is_active = true;

-- updated_at maintenance.
create or replace function public.tg_custom_integrations_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists custom_integrations_touch_updated_at on public.custom_integrations;
create trigger custom_integrations_touch_updated_at
  before update on public.custom_integrations
  for each row execute function public.tg_custom_integrations_touch_updated_at();

-- RLS: owner-scoped, mirrors the pattern on `integrations`.
alter table public.custom_integrations enable row level security;

drop policy if exists "Owner reads own custom integrations" on public.custom_integrations;
create policy "Owner reads own custom integrations"
  on public.custom_integrations for select
  using (
    business_id in (
      select id from public.businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner inserts own custom integrations" on public.custom_integrations;
create policy "Owner inserts own custom integrations"
  on public.custom_integrations for insert
  with check (
    business_id in (
      select id from public.businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates own custom integrations" on public.custom_integrations;
create policy "Owner updates own custom integrations"
  on public.custom_integrations for update
  using (
    business_id in (
      select id from public.businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner deletes own custom integrations" on public.custom_integrations;
create policy "Owner deletes own custom integrations"
  on public.custom_integrations for delete
  using (
    business_id in (
      select id from public.businesses where owner_email = auth.email()
    )
  );

comment on table public.custom_integrations is
  'Owner-managed (label, base_url, auth_scheme, secret) triples used by the Rowboat agent http_api_call tool. Secrets stored AES-256-GCM via @/lib/integrations/secrets, never returned to the browser or the model. Resolution is by lower(label) within a business_id.';
comment on column public.custom_integrations.label is
  'Agent-visible identifier the model uses to pick this integration. Unique within a business.';
comment on column public.custom_integrations.base_url is
  'Required https origin + optional path prefix. Every call MUST resolve to this host; the proxy rejects anything else.';
comment on column public.custom_integrations.auth_scheme is
  'How the proxy injects the secret: bearer | header | basic | query | none.';
comment on column public.custom_integrations.header_name is
  'Required when auth_scheme is header or query (the header / query-param name).';
comment on column public.custom_integrations.secret_encrypted is
  'AES-256-GCM ciphertext via @/lib/integrations/secrets (enc:v1:...). Null only when auth_scheme=none.';
