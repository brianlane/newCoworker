-- ---------------------------------------------------------------------------
-- Bring-your-own-number: per-business port-in request tracking.
--
-- One row per Telnyx porting order a tenant starts from the BYON wizard.
-- The dashboard reads these rows for the status card; the porting webhook
-- (porting_order.status_changed) updates status/status_detail/foc_at as the
-- losing carrier processes the port; on `ported` the activation step wires
-- the DID (telnyx_voice_routes + business_telnyx_settings + 10DLC attach).
-- ---------------------------------------------------------------------------

create table if not exists public.number_port_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Telnyx porting order id. Null only for the brief moment between wizard
  -- submit and order creation failing; rows without one are dead drafts.
  telnyx_order_id text,
  -- Raw Telnyx status value (draft, in-process, submitted, exception,
  -- foc-date-confirmed, ported, cancelled, cancel-pending). Deliberately NOT
  -- an enum check: Telnyx can add statuses and the webhook writer must never
  -- be rejected by a stale constraint.
  status text not null default 'draft',
  -- Latest status.details[] from Telnyx — actionable exception codes like
  -- ACCOUNT_NUMBER_MISMATCH that the UI maps to plain-language fixes.
  status_detail jsonb,
  -- Firm Order Commitment: when the losing carrier will activate the port.
  foc_at timestamptz,
  -- Telnyx support reference (sr_…) for humans escalating a stuck port.
  support_key text,
  -- Documents attached to the order (Telnyx Documents service ids).
  loa_document_id text,
  invoice_document_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dashboard status card: a business's requests, newest first.
create index if not exists number_port_requests_business_idx
  on public.number_port_requests (business_id, created_at desc);

-- Webhook hot path: resolve the row from the Telnyx order id.
create index if not exists number_port_requests_order_idx
  on public.number_port_requests (telnyx_order_id)
  where telnyx_order_id is not null;

alter table public.number_port_requests enable row level security;

drop policy if exists "Owner reads own number_port_requests" on public.number_port_requests;
create policy "Owner reads own number_port_requests"
  on public.number_port_requests for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner inserts own number_port_requests" on public.number_port_requests;
create policy "Owner inserts own number_port_requests"
  on public.number_port_requests for insert
  with check (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner updates own number_port_requests" on public.number_port_requests;
create policy "Owner updates own number_port_requests"
  on public.number_port_requests for update
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner deletes own number_port_requests" on public.number_port_requests;
create policy "Owner deletes own number_port_requests"
  on public.number_port_requests for delete
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.number_port_requests is
  'Bring-your-own-number port-in requests: one row per Telnyx porting order started from the BYON wizard. status mirrors the raw Telnyx porting-order status; status_detail carries the exception codes the UI turns into plain-language fixes; foc_at is the confirmed activation date.';
comment on column public.number_port_requests.telnyx_order_id is
  'Telnyx porting order id — the key the porting_order.status_changed webhook resolves rows by.';
comment on column public.number_port_requests.status is
  'Raw Telnyx status (draft/in-process/submitted/exception/foc-date-confirmed/ported/cancelled/cancel-pending). No enum check on purpose: Telnyx may add values and webhook writes must not bounce.';
