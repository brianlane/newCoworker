-- BYON: track platform activation of a ported number separately from the
-- owner-alert claim (notified_status).
--
-- Activation used to piggyback on the ported milestone claim: if the worker
-- died after claiming the alert but before wiring the number, later Telnyx
-- redeliveries looked like no-ops and the number was never activated. Now
-- every delivery that sees status='ported' with activated_at IS NULL
-- re-attempts the (idempotent) activation, and activated_at records success.

alter table public.number_port_requests
  add column if not exists activated_at timestamptz;

comment on column public.number_port_requests.activated_at is
  'When the ported number was wired into platform routing (voice routes + messaging + 10DLC attach); null until activation succeeds.';

-- First activation failure recorded for this request. Doubles as the dedupe
-- claim for the "we're connecting your number" owner alert: the delivery
-- that swaps NULL -> error sends the alert, redeliveries that keep failing
-- only log. Cleared when activation eventually succeeds.
alter table public.number_port_requests
  add column if not exists activation_error text;

comment on column public.number_port_requests.activation_error is
  'First activation failure (also the alert-once claim); null when never failed or after activation succeeds.';
