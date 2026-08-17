-- Google Meet links on booked appointments.
--
-- A Meet link is not created by a separate service the way a Zoom meeting is.
-- It is created BY the Google Calendar event: the booking core sends
-- `conferenceData.createRequest` with `conferenceDataVersion=1` on the event
-- insert and Google returns a `hangoutLink`. So there is no connection table,
-- no OAuth app and no token pair here, only a switch and a place to keep the
-- resulting URL.
--
-- No object is CREATED in this file (both statements are `alter table`), so
-- there is nothing to grant: the Data API grants on `businesses` and
-- `calendar_booking_dedupe` already cover the new columns.

-- Per-tenant switch, default OFF on purpose.
--
-- Zoom's off switch is "do not connect Zoom". Google is already connected for
-- mail and calendar by tenants who never asked for video, so defaulting this
-- on would silently start attaching a join link to in-person appointments for
-- every Google tenant on deploy. Owners opt in from
-- Dashboard -> Integrations -> Google.
alter table public.businesses
  add column if not exists google_meet_enabled boolean not null default false;

comment on column public.businesses.google_meet_enabled is
  'Owner opt-in: attach a Google Meet link to appointments booked onto a connected Google Calendar. Zoom takes priority when a zoom_connections row is active, so this only decides the no-Zoom case. Ignored for Microsoft, CalDAV, and platform-mode bookings, which have no Google event to carry a conference.';

-- The booking's Meet join URL, stored rather than re-read.
--
-- Deliberately NOT a provider-neutral `video_join_url` shared with Zoom. The
-- two hold different kinds of thing and must not be merged:
--
--   * `zoom_meeting_id` is a LIFECYCLE HANDLE. Reschedule PATCHes it, cancel
--     DELETEs it, and getZoomJoinUrl re-reads the live URL through it,
--     because a Zoom URL rebuilt from the id alone drops the `?pwd=` a
--     password-protected meeting needs. Persisting Zoom's URL here instead
--     would serve a stale link the moment a meeting's password changes.
--   * `meet_join_url` is a TERMINAL VALUE. A Meet link has no lifecycle at
--     all: it is a property of the calendar event, so a reschedule leaves it
--     alone and a cancel deletes it along with the event, and it carries no
--     password parameter to go stale.
--
-- Keeping them apart is also what makes the invariant structural rather than
-- a review promise: nine call sites branch on `zoom_meeting_id` and
-- immediately call the Zoom API, and none of them can ever be handed a Meet
-- URL if a Meet URL cannot physically enter that column.
alter table public.calendar_booking_dedupe
  add column if not exists meet_join_url text;

comment on column public.calendar_booking_dedupe.meet_join_url is
  'Google Meet join URL (hangoutLink) for this booking, or null. Terminal value with no lifecycle: the conference belongs to the calendar event, so reschedule preserves it and cancel deletes it with the event. Never holds a Zoom URL, which stays behind zoom_meeting_id so getZoomJoinUrl can re-read the live ?pwd=.';
