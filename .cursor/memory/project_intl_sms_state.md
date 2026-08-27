---
name: intl-sms-state
description: international SMS reality: Mexico rollout on US DIDs, Telnyx number-level origination block, non-US/CA flow skip
metadata:
  type: project
---

## mexico-v1-rollout

Mexico v1 shipped Aug 1-2 2026 (PRs #1125, #1127, #1129, #1133, #1136, plus
#1137). Shape: **MX tenants keep a US +1 DID**, no +52 number purchase, no
Telnyx regulatory-document plumbing. WhatsApp is the intended volume channel
for Mexican customer traffic because Meta bills it to the tenant's own WABA.

What a Mexico signup now gets: +1/+52 selector on the signup phone field
(prefix persisted in the draft), Spanish dashboard + verification email +
`default_customer_language='es'`, a flat **$9.99/mo Mexican messaging
surcharge**, the $19.50 US 10DLC carrier fee **waived**, and customer-facing
SMS **capped at 100/month** on every non-enterprise tier.

Country resolution is `resolveBusinessCountry` (src/lib/plans/business-country.ts):
+52-shaped phone authoritative, then NANP NPA (never falls through to
timezone), then the CA/MX timezone sets. Deliberately NO `businesses.country`
column: checkout's draft-phone reconciliation requires fee, messaging profile,
and DID country to classify from the same values. Three lockstep copies exist
(src TS, supabase/functions/_shared/business_country.ts, and the SQL
`business_phone_country` used inside `try_reserve_sms_outbound_slot`); a
worker-integration fixture test asserts they agree.

Live Telnyx config: messaging profile "New Coworker SMS (US+CA+MX)"
`40019fc0-0431-4c98-a9dd-7edbcfe8d478` (env `TELNYX_MESSAGING_PROFILE_ID_MX`,
set in Vercel prod+preview and local .env); outbound voice profile
`2937323607140861695` widened to US+CA+MX (it was US+CA, which would have
blocked calls to a +52 owner).

**Why:** the cost model drove every decision. Telnyx list price to MX is
$0.091/SMS part (~5.7x the US blend, and accented Spanish is UCS-2 so a
typical message is 2+ parts) and ~$0.020/min to MX mobile. No flat fee can
cover the standard tier's 3,000-message cap at that rate, so the 100-message
clamp is the real exposure bound and the surcharge just covers the rest.

**How to apply:** the $0.091/part and $0.018/min figures are Telnyx PUBLIC
list prices read off their pricing pages, never confirmed against our account
rate deck. Telnyx exposes no rate API (only detail_records of actual usage),
so this needs a human in Mission Control. Re-check it once real MX traffic
exists, and revisit the fee if the deck differs.

**UPDATE Aug 5-6 2026: the SMS half of v1 has never worked and cannot on
long codes.** Telnyx support confirmed (Aug 6 2026) our long-code numbers
cannot originate non-NANP SMS at all (see [[telnyx-number-level-sms-block]]),
and the account MDRs contain zero +52 sends ever. Voice to +52 is separately
plumbed (voice profile whitelists) and not known to be blocked. The 100-msg
cap and surcharge price traffic that currently cannot be sent; revisit if a
number type with international outbound (Telnyx suggests toll-free) ships.

**UPDATE Aug 6 2026: the alpha sender does NOT rescue Mexico.** Telnyx's
Mexico SMS guidelines (support article 6531664): "All Alphanumeric Sender
IDs will be overwritten to either a random Local Long Code or Short Code to
ensure delivery." So even a registered NEWCOWORKER sender shows Mexican
recipients a random local number. Combined with alpha being one-way, this
means: (a) no branded identity in MX, (b) replies go to a random
Telnyx-owned number and are lost, so customer-facing MX flows (especially
missed-call autotext, which invites a reply) must NEVER ride the alpha
sender; at most it could carry clearly-worded no-reply owner alerts to a
+52 owner phone. The alpha-sender work (HK et al.) therefore leaves the MX
pricing problem untouched: the $9.99 surcharge and 100-unit clamp still
price SMS traffic that cannot exist, and the real MX cost variable is
WhatsApp conversation fees. Pricing review still owed before any MX tenant
goes live.

**V2 RESEARCH (Aug 6 2026), every MX messaging path priced:**
- Telnyx MX 2-way SMS numbers: a Mar 2024 release note announces them, but
  LIVE account inventory shows zero (local = voice/fax/emergency $5/mo,
  toll-free = voice/fax $20/mo, national/mobile empty). And even if
  provisioned, Mexican domestic long codes allow A2P for OTP ONLY with
  randomized sender and "best-effort" delivery, and carriers block
  automated traffic on P2P mobile numbers immediately (Twilio MX
  guidelines). An AI coworker IS automated traffic: regulatory dead end,
  not just inventory.
- MX short code: the ONLY branded two-way A2P route. $500-$1,000+/mo,
  2-3+ month carrier lead time, promotional-material approval. Enterprise
  line item economics (same shape as RCS agents), never Standard.
- Registered MX alphanumeric: A2P allowed, brand preserved on
  Telcel/Movistar (+AT&T domestic), ~3-week registration, but one-way by
  nature, and Telnyx overwrites ALL alpha to MX (their support article),
  so it would need a second provider. Marginal value only.
- WhatsApp: THE answer. Meta bills the tenant's own WABA (zero platform
  cost); service conversations (customer texts first, 24h window) are
  free; utility templates ~$0.008 base, marketing ~$0.044. Dominant
  consumer channel in Mexico anyway.
- Voice to +52 already works (profile widened Aug 2026).
AUG 6 2026 FOLLOW-ON WORK (see [[weighted-sms-metering]] for the CA
outage): notify_owner email fallback shipped as PR #1222 (blame follows
fault: unreachable number = fix-it copy, carrier rejection = neutral copy,
no phone = invitation; SMS leg suppressed on fallback records); generic
scripts/oneshot/requeue-failed-flow-run.ts re-enqueues a failed run from
its original trigger (applied for KYP's H Eve run, where the booking
precheck then correctly sent NOTHING: the lead had already booked via
Calendly, so the outage cost KYP zero conversions, only James's alerts).
RECOMMENDED V2 SHAPE: WhatsApp-first officially: require WhatsApp connect
in MX onboarding, keep the US DID for voice + forwarding, disable
customer-facing SMS for MX tenants entirely (drop the fiction the 100-unit
clamp maintains), and reprice the $9.99 surcharge around its REAL residual
costs (Spanish surface + waived-10DLC discount + voice forwarding
~$0.02/min), since the $0.091/part SMS basis is gone. Short code = future
Enterprise option. Related: [[telnyx-billing-model-traps]].

## telnyx-number-level-sms-block

Since `scripts/oneshot/widen-telnyx-destinations.ts` ran (Aug 2026), ALL
messaging profiles (US default, CA, MX) whitelist 222 countries, so a
tenant's messaging profile id predicts nothing about SMS deliverability.
The real gate is per NUMBER: Telnyx support confirmed (Aug 6 2026) that our
long-code +1 numbers cannot originate international (non-NANP) SMS at all;
every DID reports `features.sms.international_outbound: false` and no
profile change flips it. Hong Kong (+852) additionally requires a registered
alphanumeric sender, which is one-way only, so not a fix (replies needed).
NANP (+1) destinations, Canada and Caribbean included, originate fine.

Verified empirically: account detail records contain zero +52 and zero +852
messages ever (checked Aug 5 2026). The outbound VOICE profiles were also
widened by the same one-shot, so international calls are not known to be
blocked; only SMS is.

**Why:** the app-side Phase 2 machinery (multipliers, default-closed gate,
velocity brake) and Mexico v1 pricing all assume international sends are
possible; they are not, on the current number type. PR #1204 realigned
`ownerPhoneDeliverabilityWarning` to this (any +1 passes, everything else
warns, profile ids dropped).

**How to apply:** never reason about SMS reach from messaging-profile
identity. If international SMS is needed, the path Telnyx suggested is a
number type with international outbound (e.g. toll-free); if that ships,
re-add a real condition to the deliverability helper and revisit
[[mexico-v1-rollout]]. Related: [[telnyx-billing-model-traps]].

## intl-sms-flow-skip

Since PR #1334 (2026-08-12), the AiFlow worker skips any 1:1 `send_sms` whose destination is outside US/CA while `TELNYX_INTL_GATEWAY_E164` is unset: step result `international_sms_no_gateway`, an actions_taken note, and a warn event `ai_flow_sms_international_skipped` in the tenant log tail. The run continues. Covers lead sends AND roster sends (a +852 teammate no longer kills a run). Trigger incident: KYP/VFM run f17c6e0f died at the greeting on a real Indian lead number (Telnyx 409/40306), discarding 13 steps.

Layer map that already existed (do not re-add): international MMS skips (`international_mms_unsupported`), reserve RPC refuses denylist/velocity/unknown-prefix, `notify_owner` falls back alpha-then-email, `telnyxSendSms` swaps from-number to the gateway when the env is set.

Still open (product call, not shipped): a real-but-untextable number does NOT take the flows' bad-phone intake arm (that arm keys on lead_phone = "none"; blanking a real number at extract would strip it from the contact and alerts). So an international lead gets no automated outreach: only the FYI email and, ~2 days later, a "no reply to 3 messages" flag that overstates what was sent. Related: [[vfm-second-brand-kyp]], [[telnyx-number-level-sms-block]].
