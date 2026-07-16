-- ---------------------------------------------------------------------------
-- Email campaigns: owner-reviewed bulk email to a tag-filtered audience.
--
--   email_campaigns           - one row per campaign: subject + markdown
--                               body, the audience (a contact tag, or ''
--                               for every customer with an email), a
--                               draft → scheduled → sending → sent
--                               lifecycle, and outcome counters.
--   email_campaign_recipients - the audience SNAPSHOT taken when a campaign
--                               starts sending: one row per contact, claimed
--                               in batches by the per-minute sweep so a
--                               deploy/restart can never double-send or lose
--                               track of who got the mail.
--   contacts.marketing_unsubscribed_at
--                             - the marketing suppression stamp. Set by the
--                               public one-click unsubscribe route; checked
--                               when the snapshot is taken. Distinct from
--                               notification_preferences (owner alerts) —
--                               this is the CUSTOMER's own opt-out.
--
-- Security posture: RLS on with NO policies on both tables — service-role
-- only, identical to business_documents. Every access goes through the
-- Next.js server after its own auth checks.
--
-- Call chain for sending:
--   pg_cron (per minute) → Edge `email-campaign-sweep`
--                        → Next.js POST /api/internal/email-campaign-sweep
--                        → src/lib/campaigns/send.ts (Resend, batched)
-- ---------------------------------------------------------------------------

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subject text not null,
  body_md text not null,
  -- '' = every customer contact with an email; otherwise contacts carrying
  -- this tag (Smart-List-style narrowing rides tags already).
  audience_tag text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  send_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  recipients_total integer not null default 0,
  recipients_sent integer not null default 0,
  recipients_failed integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_campaigns_business
  on public.email_campaigns (business_id, created_at desc);

-- The sweep's due-scan: scheduled campaigns whose send time has passed,
-- plus campaigns mid-send.
create index if not exists idx_email_campaigns_due
  on public.email_campaigns (status, send_at);

alter table public.email_campaigns enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null,
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  error_detail text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- One row per contact per campaign — the snapshot insert is idempotent.
  unique (campaign_id, contact_id)
);

create index if not exists idx_email_campaign_recipients_pending
  on public.email_campaign_recipients (campaign_id, status);

alter table public.email_campaign_recipients enable row level security;
-- No policies: service_role only, same posture as email_campaigns.

alter table public.contacts
  add column if not exists marketing_unsubscribed_at timestamptz;

comment on table public.email_campaigns is
  'Owner-composed bulk email campaigns to a tag-filtered contact audience. draft → scheduled → sending → sent lifecycle; the per-minute email-campaign-sweep promotes due campaigns, snapshots recipients, and sends in batches via Resend from the tenant AI mailbox.';
comment on table public.email_campaign_recipients is
  'Audience snapshot per sending campaign: one row per contact, claimed in batches so restarts never double-send. Suppressed (marketing_unsubscribed_at) and email-less contacts are never snapshotted.';
comment on column public.contacts.marketing_unsubscribed_at is
  'Customer marketing opt-out (campaign email). Set by the public one-click unsubscribe route; campaign snapshots exclude stamped contacts. Never blocks transactional/conversational mail.';

-- ---------------------------------------------------------------------------
-- Schedule the sweep (mirrors 20260711221501_schedule_document_expiration_sweep):
-- per minute — campaigns send in bounded batches, so cadence is the pace.
-- ---------------------------------------------------------------------------

do $unschedule$
begin
  perform cron.unschedule('edge-email-campaign-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-email-campaign-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-email-campaign-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/email-campaign-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
