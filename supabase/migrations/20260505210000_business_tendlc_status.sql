-- Per-business 10DLC (A2P SMS) carrier-registration status.
--
-- Why: US carriers (Verizon/AT&T/T-Mobile) silently drop A2P traffic from
-- numbers that aren't attached to an approved 10DLC campaign. Each Telnyx
-- DID we provision needs to be:
--   1. Attached to a messaging profile (already covered by the orchestrator).
--   2. Attached to OUR shared 10DLC campaign — POST /10dlc/phoneNumberCampaign
--      on Telnyx's side, which can only succeed once both:
--        - The shared campaign is in `ACTIVE` status (carrier vetting done).
--        - The DID is fully reachable on Telnyx (`status = 'active'`).
--
-- Until BOTH preconditions are met the attach will fail. We track the per-
-- DID lifecycle here so the dashboard can render a "your number is being
-- registered with US carriers (typically 1-2 business days)" banner instead
-- of letting the customer assume SMS is broken.
--
-- Status values (intentionally narrow — keep semantics obvious to operators):
--   pending      – attach has not yet succeeded (initial state for any new
--                  DID, including the one our existing single-customer
--                  business is sitting on today).
--   registered   – Telnyx confirmed POST /phoneNumberCampaign returned 200.
--                  Outbound SMS to US carriers should clear from this point.
--   rejected     – Telnyx returned a hard error (campaign suspended, brand
--                  rejected, etc). Surfaced verbatim in last_error.
--   unregistered – future use: number was previously registered and we
--                  detached it (e.g. rotation). Treated like 'pending'.
--
-- Last-error column lets us debug attach loops without scraping logs (the
-- Telnyx API is famously inconsistent about which 4xx you'll see when the
-- campaign is mid-vetting vs the brand is unverified vs the DID hasn't
-- finished propagating).

alter table business_telnyx_settings
  add column if not exists telnyx_messaging_campaign_id text,
  add column if not exists telnyx_messaging_campaign_status text not null default 'pending',
  add column if not exists telnyx_messaging_campaign_last_error text,
  add column if not exists telnyx_messaging_campaign_attached_at timestamptz,
  add column if not exists telnyx_messaging_campaign_last_attempt_at timestamptz;

alter table business_telnyx_settings
  drop constraint if exists business_telnyx_settings_campaign_status_chk;

alter table business_telnyx_settings
  add constraint business_telnyx_settings_campaign_status_chk
  check (
    telnyx_messaging_campaign_status in (
      'pending', 'registered', 'rejected', 'unregistered'
    )
  );

comment on column business_telnyx_settings.telnyx_messaging_campaign_id is
  '10DLC campaign id (Telnyx UUID, NOT the TCR id) that this DID is registered to. '
  'When NULL the DID is either pending registration or has been detached.';

comment on column business_telnyx_settings.telnyx_messaging_campaign_status is
  'pending | registered | rejected | unregistered. See migration header for semantics.';

create index if not exists idx_business_telnyx_settings_campaign_pending
  on business_telnyx_settings (telnyx_messaging_campaign_status, updated_at)
  where telnyx_messaging_campaign_status in ('pending', 'rejected');
