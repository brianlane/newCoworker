-- Shared "NewCoworker" calendar: time-off visibility mirror plumbing.
--
-- Time off added on the Employees page is mirrored as an all-day event on
-- the shared NewCoworker calendar (display only — routing always reads the
-- DB). The created provider event id is stored here so removing the time
-- off can also remove the mirror event. Null = never mirrored (no shared
-- calendar yet, or the best-effort push failed).
--
-- The shared calendar's own id lives in workspace_oauth_connections.metadata
-- (shared_calendar_id / shared_calendar_acl) — no schema change needed there.

alter table public.employee_time_off
  add column if not exists calendar_event_id text;

comment on column public.employee_time_off.calendar_event_id is
  'Provider event id of the all-day "out of office" mirror on the shared NewCoworker calendar. Best-effort: null when the mirror was skipped or failed. Used to delete the event when the time off is removed.';
