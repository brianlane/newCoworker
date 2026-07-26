-- Who a public-page booking is FOR.
--
-- Until now every booking on the page was "the business", which is right for
-- a one-person shop and wrong for a team: two visitors could take the same
-- hour from the same person, and nobody could book a specific employee.

alter table public.booking_pages
  -- 'any'        : today's behavior, whole-business availability, no assignee.
  -- 'round_robin': spread across the active roster, availability is the union
  --                of their shifts, and each booking names who has it.
  -- 'fixed'      : one employee's page; availability is THEIR shift.
  add column if not exists assignment_mode text not null default 'any',
  -- The employee for 'fixed'. Set null on their deletion rather than
  -- cascading the page away: an owner losing their booking link because an
  -- employee left is a worse failure than a page that falls back to 'any'.
  add column if not exists employee_id uuid references public.team_members(id) on delete set null;

alter table public.booking_pages
  add constraint booking_pages_assignment_mode_chk
    check (assignment_mode in ('any', 'round_robin', 'fixed')) not valid;

alter table public.calendar_booking_dedupe
  -- Who holds this appointment. Null means unassigned (mode 'any', or a
  -- round-robin pass that found nobody on shift).
  add column if not exists assignee_member_id uuid
    references public.team_members(id) on delete set null;

-- Round robin reads each candidate's upcoming load.
create index if not exists idx_calendar_booking_dedupe_assignee_upcoming
  on public.calendar_booking_dedupe (business_id, assignee_member_id, start_at)
  where event_id is not null and assignee_member_id is not null;

-- grants: none (columns and indexes on existing tables that already grant
-- service_role; no new objects are created here).
