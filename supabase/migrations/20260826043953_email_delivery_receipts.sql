-- email_log: keep the delivery receipt, not just the send.
--
-- Until now an outbound email's record ended at "we handed it to Resend".
-- `sendOwnerEmail` returns the provider message id and most callers threw it
-- away, and nothing anywhere consumed Resend's delivery webhooks, so a
-- bounced alert and a delivered one were byte-identical in our data. This is
-- the same blind spot WhatsApp had until 20260825071430, and it was found the
-- same way: a tenant whose owner had stopped receiving mail, with every one
-- of our own records saying the mail was sent.
--
-- It matters most for the alerts. A tenant whose owner has no working SMS and
-- no WhatsApp billing has email as the only channel that can reach them, and
-- an undetected bounce there means the coworker is shouting into a void while
-- the dashboard reports success.
--
-- Columns mirror messenger_messages so the two receipt paths read alike.
-- `delivery_status` is deliberately NOT a strict progression: see
-- src/lib/email/delivery.ts for the rank that orders out-of-order receipts,
-- and why `bounced` must never be masked by a late `sent`.

alter table public.email_log
  add column if not exists delivery_status text
    check (
      delivery_status in ('sent', 'delayed', 'delivered', 'complained', 'bounced', 'failed')
    ),
  add column if not exists delivery_error_code text,
  add column if not exists delivery_error_message text,
  add column if not exists delivery_updated_at timestamptz;

comment on column public.email_log.delivery_status is
  'Resend delivery receipt for an outbound row, keyed by provider_message_id. Null on inbound rows, on sends that predate 2026-08-26, and on sends whose provider returned no id.';
comment on column public.email_log.delivery_error_code is
  'Provider bounce classification (e.g. Suppressed, HardBounce) when delivery_status is a failure. Null otherwise.';
comment on column public.email_log.delivery_error_message is
  'Human-readable provider reason for a failed delivery. Null otherwise.';

-- The webhook's only lookup. Keyed on provider_message_id ALONE, not
-- (business_id, provider_message_id): a delivery receipt arrives with nothing
-- but its own message id, and discovering which tenant owns it is the whole
-- point of the query, so there is no business_id to lead with.
--
-- Deliberately NOT unique. It looks like it should be, and it is not: a scan
-- of live rows on 2026-08-26 found 7 duplicated ids in a 1000-row sample, all
-- Gmail-style hex ids from the owner-mailbox paths (the same provider id
-- recorded on more than one row). A unique index would simply fail to apply.
-- src/lib/email/delivery.ts takes the newest match rather than assuming one.
--
-- Partial, because inbound rows and pre-receipt sends carry no id and would
-- otherwise bloat it.
create index if not exists email_log_provider_message_idx
  on public.email_log (provider_message_id)
  where provider_message_id is not null;

-- The admin/ops question this feature exists to answer: "which mail did not
-- arrive, most recent first".
create index if not exists email_log_delivery_failed_idx
  on public.email_log (business_id, delivery_updated_at desc)
  where delivery_status in ('bounced', 'complained', 'failed');

-- Platform alert emails (notifications dispatch) had no email_log row at all,
-- so the one class of mail with no fallback channel was also the only class
-- with no record of the message itself. `notification` gives them one; the
-- dashboard Emails page filters them out, since that page is the coworker's
-- correspondence with customers, not the platform's mail to the owner.
-- Also repairs a live drift found while writing this. `slack_assistant` has
-- been a valid EmailLogSource in TypeScript since the Slack surface shipped
-- and src/lib/slack/worker.ts inserts it, but it was never added to this
-- constraint, so every email the coworker sent from Slack was REJECTED by the
-- check and lost. recordOutboundAssistantEmail swallows its insert error by
-- design (the mail is already gone, logging must not fail the send), so the
-- rows simply never appeared on the Emails page and nothing reported it.
alter table public.email_log drop constraint if exists email_log_source_check;
alter table public.email_log add constraint email_log_source_check
  check (
    source in (
      'ai_flow',
      'owner_mailbox',
      'email_trigger',
      'dashboard_chat',
      'sms_assistant',
      'voice_assistant',
      'slack_assistant',
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker',
      'booking_reminder',
      'notification'
    )
  );

-- grants: none (email_delivery_receipts): adds columns, an index and a check
-- constraint to public.email_log, which already carries its own grants from
-- 20260619000001_email_log.sql. No new object is created here.
