-- ---------------------------------------------------------------------------
-- Contact tags + employee ownership.
--
--   tags               - free-form per-business labels on a contact ("VIP",
--                        "spanish-speaking", "roof-2026", anything). Fully
--                        custom; the API normalizes (trim, de-dup
--                        case-insensitively) and caps at 25 per contact
--                        (abuse-safety, mirrored in the check below).
--   owner_employee_id  - the roster member (ai_flow_team_members) who "owns"
--                        this contact. Contacts start unowned; ownership is
--                        assigned when a teammate CLAIMS the lead via a
--                        route_to_team offer (only if currently unowned —
--                        never steals), or manually from the contact page.
--                        route_to_team's preferContactOwner offers the owner
--                        first on repeat leads. ON DELETE SET NULL: removing
--                        an employee releases their contacts back to unowned.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists tags text[] not null default '{}',
  add column if not exists owner_employee_id uuid
    references public.ai_flow_team_members(id) on delete set null;

alter table public.contacts
  drop constraint if exists contacts_tags_cap_chk;
alter table public.contacts
  add constraint contacts_tags_cap_chk check (cardinality(tags) <= 25);

-- Tag filtering ("show every contact tagged X") uses array containment,
-- served by GIN; queries always also filter business_id (btree) so the
-- planner ANDs both.
create index if not exists contacts_tags_gin_idx
  on public.contacts using gin (tags);

-- "Owned by" filtering + the employee page's "their contacts" lookup.
create index if not exists contacts_owner_employee_idx
  on public.contacts (business_id, owner_employee_id)
  where owner_employee_id is not null;

comment on column public.contacts.tags is
  'Free-form owner-defined labels (max 25). Normalized (trimmed, case-insensitively de-duped) by the dashboard API; filterable via GIN containment.';
comment on column public.contacts.owner_employee_id is
  'Roster member (ai_flow_team_members) who owns this contact. Null = unowned. Auto-assigned on first route_to_team claim (never reassigned automatically); also settable from the contact page. SET NULL when the employee is removed.';
