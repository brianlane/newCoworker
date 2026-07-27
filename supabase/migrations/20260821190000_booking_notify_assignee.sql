-- Text the assigned teammate when a page booking lands on them.
--
-- Round-robin and per-employee pages record WHO holds each booking, but the
-- member themselves only found out via the calendar invite (provider mode)
-- or the dashboard. This knob sends them a text the moment the booking is
-- theirs. Default ON: a person who must show up should hear about it; the
-- toggle exists for teams who prefer the calendar to carry it.

alter table public.booking_pages
  add column if not exists notify_assignee boolean not null default true;

-- grants: none (column on an existing table that already grants service_role).
