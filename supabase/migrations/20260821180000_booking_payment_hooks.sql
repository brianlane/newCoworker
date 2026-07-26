-- Payment hooks for the public booking page: SCHEMA ONLY.
--
-- Collection (Stripe checkout at booking time) is a later phase. These
-- columns exist now so that phase is a feature, not a migration, and so
-- the submit path can already enforce the one invariant that must never
-- break: a page marked as requiring payment must not hand out free
-- appointments before collection exists.

alter table public.booking_pages
  -- When true, the public submit REFUSES bookings until collection ships
  -- (src/lib/booking-page/service.ts). Deliberately not exposed in the
  -- dashboard yet; a row edited by hand still cannot give work away free.
  add column if not exists payment_required boolean not null default false,
  -- Price of the appointment when payment_required, in the smallest unit.
  add column if not exists payment_amount_cents integer,
  add column if not exists payment_currency text not null default 'usd';

alter table public.booking_pages
  add constraint booking_pages_payment_amount_chk
    check (payment_amount_cents is null or payment_amount_cents between 50 and 5000000)
    not valid,
  add constraint booking_pages_payment_currency_chk
    check (payment_currency in ('usd', 'cad', 'mxn', 'eur', 'gbp')) not valid;

alter table public.calendar_booking_dedupe
  -- Payment state of one booking. Null = the page did not require payment
  -- (every booking today). The lifecycle when collection ships:
  -- 'unpaid' -> 'paid' | 'waived' | 'refunded'.
  add column if not exists payment_status text;

alter table public.calendar_booking_dedupe
  add constraint calendar_booking_dedupe_payment_status_chk
    check (
      payment_status is null
      or payment_status in ('unpaid', 'paid', 'waived', 'refunded')
    ) not valid;

-- grants: none (columns on existing tables that already grant service_role).
