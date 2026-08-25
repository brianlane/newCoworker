-- ---------------------------------------------------------------------
-- WhatsApp delivery receipts on the transcript row.
--
-- Meta sends a status webhook (sent -> delivered -> read, or failed with
-- an error code) for every message we send. The webhook parser discarded
-- all of it, and the outbound send never stored its wamid, so a message
-- Meta ACCEPTED and then dropped was indistinguishable from a delivered
-- one, permanently. That is how KYP Ads ran for two weeks unable to start
-- a single WhatsApp conversation with nothing anywhere to show it: the
-- send call returned ok, and ok is not delivery.
--
-- No new object here, so no new Data API grants: these are columns on an
-- existing service-role-only table.
-- ---------------------------------------------------------------------

alter table public.messenger_messages
  add column if not exists delivery_status text
    check (delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column if not exists delivery_error_code text,
  add column if not exists delivery_error_title text,
  add column if not exists delivery_updated_at timestamptz;

comment on column public.messenger_messages.delivery_status is
  'Latest Meta receipt for an outbound message: sent, delivered, read, or failed. Null means no receipt yet (or a channel that sends none). Never downgrades: a late "sent" cannot overwrite "delivered".';

comment on column public.messenger_messages.delivery_error_code is
  'Meta error code from a failed receipt, e.g. 131049 (message not delivered to maintain quality) or 131047 (re-engagement outside the 24h window).';

-- Failed sends are the reason this exists, and they are rare next to the
-- delivered ones. A partial index keeps "what did not arrive" cheap without
-- carrying every read receipt.
create index if not exists idx_messenger_messages_delivery_failed
  on public.messenger_messages (business_id, delivery_updated_at desc)
  where delivery_status = 'failed';
