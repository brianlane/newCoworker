---
name: project_weighted_sms_metering
description: "SHIPPED Aug 5 2026 (PR #1189) - SMS caps enforce text UNITS (parts; MMS=2.2) on daily_usage.sms_text_units; caps 150/5000; what Phase 2 still needs"
metadata: 
  node_type: memory
  type: project
  originSessionId: 46ad72a5-e807-4776-bb30-fce3b421c36b
  modified: 2026-08-07T16:35:27.591Z
---

Weighted SMS metering shipped Aug 5 2026 (PR #1189, merge 58e3bd96). The
monthly cap now enforces on `daily_usage.sms_text_units` (one unit per
carrier part: GSM 160/153, UCS-2 70/67; MMS flat 2.2), while `sms_sent`
stays a MESSAGE count feeding analytics. Caps re-denominated: starter 150
units, standard 5,000 units, MX clamp still 100 (now units, ~40 avg
messages, deliberate). The three RPCs (`try_reserve_sms_outbound_slot`,
`meter_sms_operational_send`, `release_sms_outbound_slot`) take
`p_text_units` (numeric, default 1); bonus grants consume/refund
round(units). Group MMS reserves recipients x 2.2 in ONE atomic call.

Calculator: `smsTextUnits()` in src/lib/sms/segment-info.ts, lockstep Deno
copy in supabase/functions/_shared/sms_text_units.ts, parity-tested.

**Why:** Telnyx bills per part; fleet averaged 2.512 parts/msg with 3.8% at
the 10-part ceiling, so the message cap admitted ~5x the priced spend
(standard worst case $255 vs the $47.70 the tier-economics canvas assumes).
Caps chosen to reproduce the canvas dollars exactly (Brian's hard
constraint: never worse than previously planned): 150 = $1.32, 5,000 =
$43.94 at measured $0.008787/part. MMS measured $0.0192/msg regardless of
media size, hence 2.2. Brian explicitly chose 150 over 180/200.

**Traps for later work:**
- Any test/one-shot that seeds fake over-cap usage MUST set BOTH sms_sent
  and sms_text_units; units=0 reads as under-cap (broke 15 itests in CI).
- RCS sends deliberately charge the SMS-fallback part bound (channel is
  decided per handset after accept; RCS is enterprise-only where the cap is
  Infinity). Bugbot flagged both directions; under-metering was fixed
  (resolve RCS agent BEFORE the reserve, meter the 3072 fallback slice),
  over-metering on RCS-reject accepted as safe-direction.
- Phase 2 SHIPPED Aug 5 2026 (PR #1197 + widen-telnyx-destinations.ts
  --apply run same day): destination multipliers (18 above-floor countries,
  DK 18.3x .. CN/TH 3.5x; MX deliberately excluded, its clamp+surcharge
  already price it), default-closed gate in try_reserve (p_destination_e164;
  denylist CU/KP/SO/SL/GN/GW/ST; satellite/premium prefixes refuse as
  destination_unknown; 20/rolling-hour per-country velocity for non-US/CA;
  first-country warn written to system_logs from inside the reserve, only on
  SUCCESS - plpgsql normal returns COMMIT, so recording before the cap check
  was a Bugbot-caught bug), sms_outbound_log.destination_country via
  trigger. All four Telnyx profiles (3 SMS + voice) whitelist 222 countries.
- STILL OPEN after Phase 2: (a) SETTLED Aug 5 2026 (Brian's portal
  screenshots): per-DID international_outbound=false is a REAL block, not
  cosmetic. Telnyx portal copy: the allowed-destinations whitelist "can only
  be used with Alphanumeric Sender ID or numbers capable of sending traffic
  internationally", and the Outbound tab has "Alpha sender (required for
  international destination)". Our 5 long-code DIDs cannot originate
  international; Telnyx support CANNOT enable it (confirmed Aug 6 2026).
  Research findings: HK requires a REGISTERED alphanumeric sender (Telnyx
  rejects unregistered senders to HK outright; register via
  alpha_sender_id@telnyx.com with business docs), Telnyx sells NO
  SMS-capable HK numbers (inventory checked live: voice/fax toll-free
  only), HK absent from their 2-way SMS markets. Two-way SMS to HK over
  Telnyx is unachievable, full stop. VOICE to HK works (profile widened,
  standard termination). The shared outbound voice profile
  (2937323607140861695) carries a FLEET-WIDE daily spend limit, raised
  $10 to $25 on Aug 6 2026 (Brian) ahead of possible HK call forwarding
  (~$0.02-0.05/min ballpark, exact rate unpublished; settle from the
  first forwarded call's MDR). One tenant's marathon international call
  can still exhaust it and block ALL tenants' outbound legs until
  midnight; revisit per-tenant guards if it ever trips. Practical HK owner channel: WhatsApp (platform
  already supports it; HQ pilot connected Jul 20) + voice + email, with
  optional one-way alpha-sender SMS later. Telnyx's own compliance guide
  DOES list long code as a supported sender type to UK/DE/FR/ES/AU/BR/MX,
  so the Mexico-v1 assumption (US DID texting +52) is SUSPECT but not
  dead; still needs one live +52 test. (b) per-message vs per-part billing still needs the
  first real international MDR once (a) is resolved. (c) MX clamp rework:
  US tenant texting +52 still meters at 1x (documented gap).
- CA-WHITELIST OUTAGE (Aug 6 2026): the widen one-shot's allowlist came
  from Object.values(SMS_DIAL_CODES), and bare +1 maps to US, so CANADA
  (no prefix of its own) silently dropped from every profile whitelist
  when the script REPLACED the lists on Aug 5. All Canadian SMS failed
  with Telnyx 40309 "Invalid destination region 'CA'" until re-patched
  Aug 6 ~20:30 UTC (all 5 profiles now 223 countries, CA verified). Only
  KYP was hit: 22 errors Aug 6 15:03-19:51 UTC (notify_owner to James
  +1514, lead follow-up to H Eve +14168489229, never sent). Voice profile
  had the same hole, no CA call attempted. Fix PR #1221: pure allowlist
  module (widen-telnyx-allowlist.ts) adds CA explicitly, guard refuses a
  list missing US/CA/MX, script PATCHes the UNION so widening is
  monotone. LESSON: a Telnyx whitelist PATCH REPLACES; never derive a
  region list from the dial table alone; KYP is the fleet's Canadian
  canary.
- TELNYX PROFILE TRAP (Aug 5 2026): the account has FOUR messaging
  profiles, not three; per-tenant custom profiles exist (Truly Insurance
  has "New Coworker SMS - Truly Insurance (US+CA)", id 40019f45-...).
  Never enumerate profiles from the three platform env ids; use
  GET /v2/messaging_profiles (widen-telnyx-destinations.ts does since
  PR #1200). All four verified at 222 countries Aug 5 2026.
- INTERNATIONAL GATEWAY SHIPPED Aug 6 2026 (PR #1205, merge 289b1479):
  dedicated P2P long code +16028384497 ($1/mo, id 3020175004303099415)
  substitutes as from-number for non-US/CA destinations at every sender
  (Node sendTelnyxSms, edge telnyxSendSms, 4 raw-fetch sites). Env
  TELNYX_INTL_GATEWAY_E164; unset = old behavior. International+media
  refuses PRE-reserve (P2P is text-only); group MMS partitions intl
  recipients out (drops recorded on success results too); RCS disabled
  intl. Inbound AT the gateway resolves tenant by sender (owner columns,
  then recent outbound, else park + system_log). REFUND RULE (Brian):
  units refund ONLY on provable non-charge; telnyxAccepted flag set at
  the 2xx boundary BEFORE body parsing; cap-blocked owner ack now a
  metered operational send (was "exempt"). P2P eligibility is a property
  of the NUMBER'S COUNTRY (US eligible, CA never), not the profile; the
  messaging_product field is PORTAL-ONLY (API PATCH returns 200 and
  silently ignores it). STILL PENDING to go live: portal Traffic-Type
  flip to P2P on the gateway number (Brian), Vercel env var (Brian);
  Supabase function secret SET Aug 6. Then one live +852 send verifies
  end-to-end and settles per-message vs per-part.
- OWNER-PHONE ENV FIX (Aug 6 2026): TELNYX_OWNER_PHONE had been the stray
  number +16029226392 (in NO tenant data; received only 2 texts ever, incl.
  one misdirected Jul 16 provisioning notice). Brian's real ops number is
  +16026866672 (HQ prefs/forwarding/roster all had it right; only the env
  fallback was wrong). Fixed in local .env, Supabase secrets, and Vercel
  (via the VERCEL_TOKEN in .env; Vercel env edits apply on the NEXT
  deployment). Gateway P2P flip: BLOCKED on Telnyx traffic-pattern
  monitoring, not the SPID (eligible_messaging_products includes P2P; both
  the portal toggle and PATCH /v2/messaging_phone_numbers/{id} stay inert
  on a zero-traffic number per their docs: "after Telnyx monitors your
  traffic pattern... check back later"). Seeding conversational history:
  gateway texted Brian's real number Aug 6; retry the flip after traffic
  ages.
- P2P FLIP DEAD-ENDS SELF-SERVE (Aug 6 2026, Brian's portal screenshot):
  the current portal's number Messaging tab has NO Traffic Type control at
  all (the traffic-type doc describes an older portal), and both API
  endpoints (messaging_phone_numbers/{id} and phone_numbers/{id}/messaging)
  return 200 and silently ignore messaging_product. The portal's
  Deliverability panel names the real per-number capability: "International
  Reach Outbound" (shows X for the gateway). Only Telnyx support can grant
  it; the concrete ask is "enable International Reach Outbound / P2P on
  +16028384497". Seeding history exists (2 conversations, 6+ delivered
  intra-Telnyx messages) if they cite traffic monitoring.
- TELNYX TICKET #557577 (Aug 6 2026): support CONFIRMED the diagnosis
  (number eligible, profile+whitelist correct, both API PATCHes no-op, no
  portal control) and stated International Reach Outbound / A2P-to-P2P
  "requires backend configuration" they cannot perform at frontline;
  escalated to their support queue for manual account-level enablement.
  Nothing pending on our side. When granted: verify
  features.sms.international_outbound=true on +16028384497, send the
  Verizon test text to Brian (+16026866672), then the first +852 send
  (settles per-message vs per-part for the multiplier table). 10DLC brand
  vetting (Brian asked) is ORTHOGONAL: it only raises US domestic A2P
  throughput tiers (~$40 via TCR), irrelevant to international/P2P; skip
  until domestic volume ~10x or T-Mobile daily-cap errors appear.
- FINAL VERDICT (Aug 7 2026, ticket #557577 second reply): "US long codes
  are for domestic traffic only." CATEGORICAL: no backend enablement, no
  P2P path, the traffic-type doc does not apply to US long codes on this
  account. The gateway number can never send international SMS. Two-way
  international SMS from Telnyx: impossible for HK (no SMS-capable HK
  inventory); for countries with local SMS-capable Telnyx inventory,
  per-country local numbers would be the only route. Alpha sender = the
  supported one-way option (per-country registration via
  alpha_sender_id@telnyx.com). MEXICO IMPLICATION: Mexico v1's US-DID-to-
  +52 SMS assumption is now definitively dead on this account; MX customer
  traffic is WhatsApp-only, and the $9.99 surcharge pricing rationale needs
  Brian's review before any MX tenant goes live. The gateway CODE stays
  (env-gated, future-proof for any capable sender number); the gateway
  NUMBER (+16028384497, $1/mo) has no remaining purpose (pending Brian:
  release + unset TELNYX_INTL_GATEWAY_E164, or keep as spare). James's
  channel stack: WhatsApp (two-way, primary) + voice forwarding (works) +
  email (works) + optional one-way alpha-sender alerts.
- GATEWAY RETIRED (Aug 6 2026, Brian's call): +16028384497 released
  (DELETE /v2/phone_numbers/3020175004303099415, account verified empty);
  TELNYX_INTL_GATEWAY_E164 removed from .env, Supabase secrets, and Vercel.
  PR #1205 code stays merged and dormant (env unset = old behavior).
- SHIPPED AND CLOSED (Aug 7 2026): PRs #1220 (reachability docs +
  as-you-type warnings), #1221 (CA-whitelist guard + requeue one-shot),
  #1222 (notify_owner email fallback) merged by the Investigation session
  in its 9-PR batch (03:37 UTC), deployed green. It also shipped #1223
  fixing MY ordering gap in #1222 (unreachable-number check now ABOVE the
  `!cfg` guard; my itest hadn't seeded a messaging profile so it passed
  without reaching the logic; see [[itest-no-global-telnyx-profile]]) and
  #1224 (debug scripts refuse the transaction pooler). Branches deleted,
  Vercel envs verified free of us-east-1/DATABASE_URL values.
  Deliberately still open: a REACHABLE number with no messaging profile
  keeps the silent notified:null (commented in code, revisit on
  telemetry).
- ALPHA SENDER STAGED (Aug 7 2026): Brian SENT the registration email.
  Dedicated profile "New Coworker International Alerts" id
  40019fdc-dd03-4114-91f4-af8dc211cbd8 created with
  alpha_sender=NEWCOWORKER verified by readback, no numbers attached
  (create-intl-alpha-profile.ts, ledgered). Dormant routing behind
  TELNYX_INTL_ALPHA_PROFILE_ID (unset everywhere) at the edge
  notifications SMS leg, Node dispatch SMS leg, and notify_owner
  (alpha first, #1222 email fallback second): PR #1229.
  debug/alpha-sender-smoke.ts fail-fasts unless the sender reads back
  as the alpha identity and prints cost to settle per-message vs
  per-part. ACTIVATION runbook: PRDs/alpha-sender-rollout.md, gated on
  approval AND fees in writing (RCS lesson). Do not set the env var
  before both gates. MERGED Aug 7 2026 (PR #1229, main run green,
  production 200). Bugbot caught a real seam bug pre-merge: with gateway
  AND alpha envs both set, the shared senders' gateway substitution
  stamped a P2P from-number over the alpha identity; fixed at the seam
  in BOTH senders (alpha-profile sends omit from entirely), regression
  tests pin both directions. Everything now waits on Telnyx's reply.
- ALPHA SENDER PREP (Aug 6 2026): registration email drafted at
  /Users/brianlane/newCoworker/telnyx-alpha-sender-application.md (send to
  alpha_sender_id@telnyx.com with business docs, cite ticket #557577).
  Design constraints inherited from the RCS record (decision thread: Cursor
  transcript 6d2e3e70-453f-4725-9913-0c2a690f26c5, Jul 18 2026; PRD
  tier-economics-jul-2026.md:172-205): shared branded senders carry
  PLATFORM traffic only (owner alerts), never customer-facing; verify ALL
  fees before building (RCS died on an unverified "no fee" assumption,
  real cost $600 + $100/mo per agent); no-reply must be explicit in copy
  (alpha has no inbound at all); dedicated messaging profile so tenant
  sends can't ride it; smoke test must assert the alpha route was taken.
  Tenant-branded alpha senders = Enterprise line item later, like RCS.
  NO CODE until Telnyx confirms fees + HK registration approval.
Related: [[telnyx-billing-model-traps]], [[mexico-v1-rollout]].
