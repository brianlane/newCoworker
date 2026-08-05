-- Drop booking_pages.title: the page-level heading, finally.
--
-- It was added in 20260820101000 as "optional public event title shown on the
-- page's left panel". Two PRs then took it apart without finishing the job:
--
--   #971 cut its public render (BookingSurface now reads the MEETING's name,
--        so a page-level heading had nowhere left to appear), and
--   #985 cut the dashboard field, the write path, the API schema key, and the
--        i18n copy, leaving the column behind on purpose.
--
-- What was left behind was not inert. ensureDefaultMeetingType still read it
-- to NAME the meeting it provisions, and that name does render publicly (the
-- event title, the meeting picker, the calendar event summary). Since the
-- Bookings dashboard provisions on any load where a page has zero meetings,
-- an owner who deleted their last meeting got a new one named from a field
-- they could no longer see or edit. HQ's row said "**Header&&", left over
-- from testing, and it was one delete away from being a public event title.
--
-- Fleet audit before dropping: 4 booking_pages, exactly 1 with a non-empty
-- title (HQ's junk string), and the single page with zero meeting types had a
-- null title. No tenant heading is lost here.

alter table public.booking_pages
  drop column if exists title;
