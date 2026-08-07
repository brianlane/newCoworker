# Alpha sender (NEWCOWORKER) rollout runbook

One-way international SMS for OWNER alerts via a registered alphanumeric
sender, the only supported Telnyx path after ticket #557577's verdict that
US/CA long codes are domestic-only. Everything below the "Activation"
heading waits for Telnyx; everything above it is already done.

## Already in place (Aug 7 2026)

- **Registration email sent** to alpha_sender_id@telnyx.com (Brian, Aug 7
  2026): sender NEWCOWORKER, Hong Kong first, business registration
  attached, citing ticket #557577. The email asks three gating questions:
  explicit one-time/recurring fees, per-destination registration scope,
  and HK lead time.
- **Dedicated messaging profile created and verified**:
  "New Coworker International Alerts", id
  `40019fdc-dd03-4114-91f4-af8dc211cbd8`, `alpha_sender=NEWCOWORKER`
  confirmed by readback (the messaging_product 200-and-ignore trap makes
  readback mandatory), 223-country whitelist, **no numbers attached**.
  Converge/recreate any time with
  `scripts/oneshot/create-intl-alpha-profile.ts`.
- **Dormant routing code shipped** behind `TELNYX_INTL_ALPHA_PROFILE_ID`
  (unset everywhere; unset = behavior byte-identical to today):
  - `_shared/alpha_sender.ts` + `src/lib/telnyx/alpha-sender.ts`
    (lockstep, parity-tested): eligibility is OWNER alerts to non-US/CA
    destinations only, and every alpha text carries the no-reply line.
  - Edge `notifications` function SMS leg, Node `dispatch.ts` SMS leg,
    and the ai-flow-worker `notify_owner` international branch (alpha
    attempt first, the #1222 email fallback second, so an owner never
    gets less than today).
- **Smoke test**: `debug/alpha-sender-smoke.ts` refuses domestic
  destinations and FAILS unless the accepted message reads back with the
  alpha identity as its sender (the RCS lesson: a fallback-capable
  channel makes tests lie).

## Design constraints (from the RCS record, do not relitigate casually)

- Platform-branded shared senders carry PLATFORM-authored traffic only:
  owner alerts, never customer-facing messages. Tenant-branded senders
  would be an Enterprise line item, like RCS agents.
- No inbound path exists, so the no-reply line is mandatory on every
  message (`ALPHA_NO_REPLY_LINE`); the owner-reply relay never engages.
- Mexico strips alpha senders to random local numbers (Telnyx support
  article 6531664): alerts to +52 may deliver but unbranded, and MX
  customer messaging stays WhatsApp-only regardless.

## Gate 1: fees in writing

The RCS Standard rollout died on an unverified "no fee" assumption that
turned out to be $600 + $100/mo per agent. **Do not activate until
Telnyx's reply states the alpha sender's one-time and recurring charges
explicitly.** If a recurring fee exists, Brian prices it before any
tenant depends on the channel.

## Gate 2: registration approved

Telnyx confirms NEWCOWORKER is registered for Hong Kong (and lists any
other destinations covered without further paperwork).

## Activation (after both gates, ~15 minutes)

1. Set the secret in all three places, value
   `40019fdc-dd03-4114-91f4-af8dc211cbd8`:
   - repo-root `.env`: `TELNYX_INTL_ALPHA_PROFILE_ID=...`
   - Edge functions: `supabase secrets set TELNYX_INTL_ALPHA_PROFILE_ID=...`
     (functions pick it up on their next cold start)
   - Vercel: project env var for production + preview (applies on the
     NEXT deployment; trigger one if none is pending)
2. Smoke it against a real registered-destination number (James's +852
   once he shares it, or any team number in an approved country):
   `npx tsx debug/alpha-sender-smoke.ts --to +852... --apply`
   The script fails unless the sender reads back as NEWCOWORKER.
3. Read the smoke message's cost once materialized (the script prints
   it): this settles per-message vs per-part international billing and
   whether the destination multiplier table needs re-deriving.
4. Follow-up sweep in one PR:
   - Deliverability copy: `src/lib/phone/deliverability.ts` strings and
     the `dashboard.phoneDeliverability` catalog entries currently say
     SMS "will not reach" international numbers; soften to "alerts
     arrive one-way from NEWCOWORKER; replies by text are not received"
     for the alert-phone surfaces.
   - README "International reachability" section: alpha bullet moves
     from "pending" to live, with the profile id and env var.
   - `docs/tenants/kyp-ads.md`: James's channel stack gains one-way SMS
     alerts.
   - Memory: close the alpha thread in `project_weighted_sms_metering`.

## Known limitations at activation

- One-way only, forever: conversations stay on WhatsApp/domestic SMS.
- The operational meter counts alpha alerts at plain text units (no
  destination multiplier on `meterOperationalSms`); at owner-alert
  volume this rounding is noise, but note it if alert volume grows.
- Countries outside the registration refuse or strip the sender;
  the notify_owner path falls back to email automatically, the
  dispatcher legs record the failure row as they do today.
