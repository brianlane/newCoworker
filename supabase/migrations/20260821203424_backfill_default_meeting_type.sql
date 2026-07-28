-- Every booking page gets its first meeting.
--
-- Meeting types are now the ONLY way a visitor books: the page carries the
-- shared policy (hours, notice, buffer, caps, reminders, waitlist) and each
-- meeting carries what is actually being booked. The dashboard used to
-- offer both, which read as two competing ways to define the same thing.
--
-- This backfills one meeting per existing page, carrying the page's own
-- identity across so nothing changes for a visitor: the page's title
-- becomes the meeting name, its description and questions come along, and
-- its first offered duration becomes the meeting's length.
--
-- The page's questions are then cleared, because a SECOND meeting created
-- later inherits null questions from the page, and inheriting a list the
-- owner can no longer see would be a surprise. The first meeting keeps its
-- own explicit copy.

insert into public.booking_meeting_types (
  business_id,
  name,
  slug,
  description,
  duration_minutes,
  intake_questions,
  enabled,
  hidden,
  sort_order
)
select
  p.business_id,
  -- The title visitors already saw, else the same default the public page
  -- renders when no title is set.
  coalesce(nullif(btrim(p.title), ''), 'Book a call'),
  -- A constant slug is safe precisely because this only fires for pages
  -- with NO meetings, so it cannot collide; owners rename it freely.
  'book-a-call',
  p.description,
  -- The shortest offered duration is the one the page's picker selected by
  -- default, so it is what visitors were most likely booking.
  coalesce((select min(d) from unnest(p.allowed_durations) as d), 30),
  coalesce(p.intake_questions, '[]'::jsonb),
  true,
  false,
  0
from public.booking_pages p
where not exists (
  select 1
  from public.booking_meeting_types m
  where m.business_id = p.business_id
);

-- Questions now live on the meeting that inherited them.
update public.booking_pages
   set intake_questions = '[]'::jsonb
 where intake_questions is not null
   and intake_questions <> '[]'::jsonb;

-- grants: none (backfill_default_meeting_type): no objects created; the
-- tables written here already grant service_role.
