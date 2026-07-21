-- Team-first human handoff (Employees page toggle): when ON, a needs-human
-- escalation offers the whole active roster first (broadcastAll
-- route_to_team, 10-minute shared deadline) and pages the owner only as the
-- fallback. Default OFF preserves the page-the-owner-immediately behavior.
alter table public.businesses
  add column if not exists needs_human_team_first boolean not null default false;
