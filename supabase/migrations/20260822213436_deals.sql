-- Deals: a lead can carry a deal (value, close date, commission).
--
-- One row per deal a business is working: the money view of a lead. A deal
-- points at the contact it belongs to through the same linkage pattern as
-- business_documents.contact_id (nullable, SET NULL on contact delete, so a
-- deleted contact keeps the deal as an unlinked record). Status is a small
-- fixed funnel (open -> under_contract -> won/lost, direct open -> won/lost
-- allowed); won_at / lost_at stamp the terminal move and are cleared by a
-- reopen. Transition rules live in src/lib/deals/core.ts, the DB stores the
-- outcome.
--
-- Money is integer cents (value_cents) with an ISO currency code, and the
-- commission is basis points (commission_bps, 100 bps = 1%), so nothing here
-- ever does floating-point money math.
--
-- Security posture: RLS on with NO policies, service-role only, identical to
-- business_documents / unowned_lead_alerts. Every access goes through the
-- Next.js server (owner/manager dashboard routes) after its own auth checks.

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The contact this deal belongs to, business_documents.contact_id pattern:
  -- NULL = not linked yet; deleting the contact keeps the deal.
  contact_id uuid references public.contacts(id) on delete set null,
  -- Short human label ("123 Main St listing"); the app caps it at 200 chars.
  title text not null,
  -- Expected/actual deal value in integer cents; NULL = not sized yet.
  value_cents bigint,
  currency text not null default 'USD',
  -- Commission in basis points (250 = 2.5%); NULL = not set.
  commission_bps integer,
  expected_close_date date,
  status text not null default 'open'
    check (status in ('open', 'under_contract', 'won', 'lost')),
  won_at timestamptz,
  lost_at timestamptz,
  -- auth.users id of the dashboard user who created the deal; informational
  -- only (no FK: user deletion must not cascade into deal history).
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The board's exact read: one business's deals bucketed by status column.
create index idx_deals_business_status
  on public.deals (business_id, status);

-- Contact profile "deals on file" lookup + the analytics join, same partial
-- index shape as idx_business_documents_contact.
create index idx_deals_contact
  on public.deals (business_id, contact_id)
  where contact_id is not null;

comment on table public.deals is
  'Deals attached to leads (value, close date, commission). Status funnel open -> under_contract -> won/lost with won_at/lost_at stamps; transition rules enforced in src/lib/deals/core.ts.';
comment on column public.deals.contact_id is
  'Contact this deal belongs to (business_documents.contact_id pattern). NULL = unlinked. SET NULL when the contact is deleted.';
comment on column public.deals.value_cents is
  'Deal value in integer cents in `currency`; NULL = not sized yet.';
comment on column public.deals.commission_bps is
  'Commission in basis points (100 bps = 1%); NULL = not set.';

alter table public.deals enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
grant select, insert, update, delete on table public.deals to service_role;
