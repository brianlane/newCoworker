-- To-dos: assign it, see it overdue, check it off.
--
-- One row per to-do a business is tracking: a short piece of follow-up work,
-- optionally pinned to the contact it is about, the deal it advances, and
-- the roster member on the hook for it. Named `todos`, NOT `tasks`: the
-- Tasks board (/dashboard/tasks, /api/dashboard/tasks) already means "a lead
-- in motion", and reusing that word for checklist items would collide the
-- two concepts everywhere.
--
-- Linkages, all nullable and all detaching rather than cascading:
--   contact_id            - business_documents.contact_id pattern: NULL =
--                           not about one person; deleting the contact keeps
--                           the to-do as an unlinked record.
--   deal_id               - sibling pointer into deals (PR "fub-01");
--                           deleting the deal keeps the to-do.
--   assignee_employee_id  - contacts.owner_employee_id pattern: the roster
--                           member (ai_flow_team_members) who owns the work;
--                           removing an employee releases their to-dos back
--                           to unassigned.
--
-- Completion is a stamp pair (completed_at + completed_by), not a status
-- enum: "overdue" is DERIVED (due_at in the past and completed_at null) in
-- src/lib/todos/core.ts, so it can never go stale in storage.
--
-- Security posture: RLS on with NO policies, service-role only, identical to
-- deals / business_documents. Every access goes through the Next.js server
-- (dashboard routes) after its own auth checks.

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The contact this to-do is about; NULL = not linked to a person.
  contact_id uuid references public.contacts(id) on delete set null,
  -- The deal this to-do advances; NULL = not linked to a deal.
  deal_id uuid references public.deals(id) on delete set null,
  -- Short imperative label ("Send the disclosure packet"); app caps at 200.
  title text not null,
  -- Optional longer notes; app caps at 2000.
  details text,
  -- Roster member on the hook; NULL = unassigned.
  assignee_employee_id uuid references public.ai_flow_team_members(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  -- auth.users id of the dashboard user who checked it off; informational
  -- only (no FK: user deletion must not cascade into work history).
  completed_by uuid,
  -- auth.users id of the dashboard user who created it; same posture.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The list's exact read: one business's to-dos filtered on completion state
-- and ordered/ranged by due date.
create index idx_todos_business_state
  on public.todos (business_id, completed_at, due_at);

-- FK-covering single-column btrees (house rule from
-- 20260812000100_fk_covering_indexes.sql): Postgres does not auto-index the
-- referencing side, so deleting a contact / deal / roster member would
-- otherwise seq-scan todos per parent row inside the SET NULL trigger.
create index idx_todos_contact_id on public.todos (contact_id);
create index idx_todos_deal_id on public.todos (deal_id);
create index idx_todos_assignee_employee_id
  on public.todos (assignee_employee_id);

comment on table public.todos is
  'Business to-dos (assignable follow-up work), optionally linked to a contact, a deal, and a roster assignee. Overdue is derived (due_at past + completed_at null) in src/lib/todos/core.ts, never stored.';
comment on column public.todos.contact_id is
  'Contact this to-do is about (business_documents.contact_id pattern). NULL = unlinked. SET NULL when the contact is deleted.';
comment on column public.todos.deal_id is
  'Deal this to-do advances. NULL = unlinked. SET NULL when the deal is deleted.';
comment on column public.todos.assignee_employee_id is
  'Roster member (ai_flow_team_members) responsible. NULL = unassigned. SET NULL when the employee is removed.';

alter table public.todos enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
grant select, insert, update, delete on table public.todos to service_role;
