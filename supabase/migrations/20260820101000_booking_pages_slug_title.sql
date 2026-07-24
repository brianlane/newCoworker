-- Booking page customization: vanity URL slug + owner-editable public title.
--
-- slug: optional friendly link (/book/<slug>) alongside the capability
-- token URL, first-come-first-served across businesses (Calendly-style).
-- Shape is app-validated (lowercase kebab, 3-60 chars, never matching the
-- ncb_ token pattern); the unique index is the collision arbiter.
--
-- title: optional public event title shown on the page's left panel;
-- null falls back to the localized "Book a call with {business}".

alter table public.booking_pages
  add column if not exists slug text,
  add column if not exists title text;

create unique index if not exists uq_booking_pages_slug
  on public.booking_pages (slug)
  where slug is not null;
