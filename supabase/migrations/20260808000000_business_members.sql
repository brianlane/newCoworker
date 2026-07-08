-- Team access (enterprise): additional logins per business with roles.
--
-- A row grants one email address a role on ONE business. The role lives on
-- this membership join table — NOT on the auth user — so a single person can
-- hold different roles across businesses (the multi-tenant agency shape).
-- `businesses.owner_email` remains the implicit root OWNER and never has a
-- row here; billing/cancel/API-key surfaces stay owner-only via the authz
-- policy matrix (src/lib/authz/policy.ts).
--
-- Lifecycle: invited → active (first login binds user_id by
-- case-insensitive email) → revoked (manager/owner removes access; the row
-- is kept for audit and can be re-invited, which flips it back to invited).
--
-- employee_id optionally links the login to the person-profile roster used
-- for AiFlow team routing (ai_flow_team_members) — the same person/login
-- separation bizblasts models with StaffMember.user_id.
create table if not exists public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Stored LOWERCASED (enforced) so the plain-column indexes below serve the
  -- app's `email = ?` lookups; the app normalizes before every write/read.
  email text not null check (char_length(email) between 3 and 320 and email = lower(email)),
  -- Supabase auth user id; null until the invitee's first login.
  user_id uuid,
  role text not null check (role in ('manager', 'staff')),
  status text not null default 'invited' check (status in ('invited', 'active', 'revoked')),
  -- Email of the owner/manager who sent the invite (audit trail).
  invited_by text not null,
  employee_id uuid references public.ai_flow_team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);

alter table public.business_members enable row level security;

drop policy if exists "Service role manages business_members" on public.business_members;
create policy "Service role manages business_members"
  on public.business_members for all
  using (auth.role() = 'service_role');

-- One membership per (business, email) regardless of status: a re-invite
-- flips the existing revoked row back to invited instead of stacking rows.
-- Plain columns (not lower(email) expressions) because the CHECK above
-- guarantees lowercase storage and the app queries `email = ?` — an
-- expression index would never match those predicates.
create unique index if not exists business_members_business_email_idx
  on public.business_members (business_id, email);

-- Login binding scans by email across businesses (runs on dashboard render).
create index if not exists business_members_email_idx
  on public.business_members (email);

create index if not exists business_members_user_idx
  on public.business_members (user_id)
  where user_id is not null;
