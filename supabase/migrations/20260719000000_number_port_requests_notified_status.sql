-- BYON: track which status milestone was last alerted to the owner.
--
-- Webhook deliveries write the status row first and notify second; if a
-- worker dies in between, Telnyx's retry used to look like a benign
-- redelivery and the alert was skipped forever. `notified_status` records
-- the last status an alert (and the ported activation signal) was claimed
-- for: any later delivery that sees status != notified_status claims the
-- milestone via compare-and-swap and sends the missing alert exactly once.

alter table public.number_port_requests
  add column if not exists notified_status text;

comment on column public.number_port_requests.notified_status is
  'Last status for which the owner alert / ported signal was claimed; null until the first milestone alert.';
