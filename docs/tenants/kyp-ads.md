# KYP Ads

Our first full white-glove build, and the account whose onboarding produced a
written incident review. Calendly is the center of gravity here.

## Identity

| | |
| --- | --- |
| Business id | `056034a7-e84c-444d-8d15-747eeb1fa899` |
| Tier / box | standard, VPS `1869876` (term-renewal cutover 2026-07-31 from `1864812`, which had itself replaced `1800985` on 2026-07-29). Hostinger billing sub `169qOAVQwnrcE14n3`, next billing 2026-08-31 |
| DID | `+14388035806` (Canadian) |
| Owner | James Lee |
| Onboarded | 2026-07-14 |
| Roster | James Lee (`+1` Montreal mobile `+1514…`, `james@kypads.com` on the row since 2026-08-28, when `repoint-roster-member-phone.ts` moved it off the `+852` number). **He reads NEITHER number: he carries no Canadian SIM, and our long codes cannot reach `+852` at all, so email and the dashboard are his only live channels.** Texts to the roster row now succeed silently instead of erroring, so absence of `alert_delivery_failed` here is not health; see the +852 sharp edge below. Liz (the VFM assignee) joins when `apply-vfm-team.ts` runs with her phone |

Build spec: [PRDs/white-glove-build-kyp-ads.md](../../PRDs/white-glove-build-kyp-ads.md).
Incident review: [docs/INCIDENT-2026-07-KYP-ONBOARDING.md](../INCIDENT-2026-07-KYP-ONBOARDING.md).

## How leads arrive

Meta lead ads fire a webhook; the AI texts the lead and drives toward a
Calendly booking. Most of what can go wrong on this account is a booking-state
problem rather than a messaging problem.

## Flows

Live snapshot 2026-08-19 (7 on / 11 total).

| Flow | State | Note |
| --- | --- | --- |
| Lead follow-up (white-glove build, webhook, 16 steps) | on | The main path. Offer selection lives on the webhook trigger condition (payload contains the Simple-form name); the in-flow $100/$200 branch from one-shot #715 was removed in an unledgered Jul 19-24 reshape, and live is canonical (`kyp-lead-flow-definition.ts`). Bad-phone intake arm: an undialable lead number emails the lead and tells James instead of dying at the greeting (`patch-kyp-bad-phone-intake.ts`) |
| Booking confirmation (SMS + email, webhook, 5) | on | Shape lives in `kyp-reminder-flow-definition.ts`; trigger: webhook payload contains `calendly_booking` |
| Pre-call reminder, 1hr before (calendar, 3) | on | Same builder as the booking confirmation. `event_start`, 60 min lead, scoped to events containing "KYP Ads \| Free Strategy Call", so the VFM flow's T-60 confirmation never overlaps it |
| No-show recovery text (calendar, 3) | **on** | Live since 2026-08-01, and it has sent. The row still says "awaiting approval" in its own name because James never approved it going live: treat that as an open question for him, not as a reason to flip it off. Fires only for no-shows marked in Calendly within 2h |
| Follow-up send: Stefan, Windshield Place (manual, 1) | on | One-off manual send_email |
| VFM lead follow-up (Vantage Flow Media) (webhook, 25) | on | Seeded 2026-08-10 by `seed-vfm-lead-aiflow.ts` in emailOnly mode; claims the three VFM Meta form names. Live volume since 2026-08-12. Reshaped 2026-08-18 by an owner-approved AI edit (dashboard chat) into a 5-touch value ladder (waits +1d/+2d/+2d/+3d, then the went-quiet flag); live is canonical, the seed builder predates the reshape and re-running it with --force would revert the ladder. Liz emails unified to one address 2026-08-19 (`patch-kyp-vfm-booking-liz-emails.ts`). See the VFM section and the international-lead sharp edge |
| VFM Calendly booking follow-up (SMS + email) (calendar, 9) | on | Saved from the Aug 18 chat hand-off as a disabled "Adapted automation" draft; trigger retargeted + renamed + enabled 2026-08-19 by `patch-kyp-vfm-booking-liz-emails.ts` (the saved condition matched the scheduling LINK, which calendar event text never contains). Scoped by event TITLE ("30 Minute Meeting"): renaming Liz's Calendly event type silently kills it, same class as the pre-call reminder's title scope. Confirmation email + SMS, T-120 attendance-check SMS, no-answer email alert to Liz |
| VFM Calendly booking follow-up (old draft, superseded, keep off) (webhook + calendar, 7) | off | The first Aug 18 chat draft, superseded by the row above. Owner directed 2026-08-19: keep it, keep it OFF, do not delete. Its webhook condition (`calendly_booking_vfm`) matches no real event source |
| Proposal follow-up, email (tag_changed, 8) | off | Fires on the `proposal-sent` tag when enabled |
| Wrong-link booking flag (calendar, 2) | off | Blocked on the warm list |
| Proposal send + follow-up (manual, 6) | off | Awaiting approval; James triggers it manually |

The off flows (proposal follow-up email, wrong-link flag, proposal send) sit
**deliberately off pending owner approval**. Do not "fix" them by enabling
them. Flow NAMES can carry stale state notes ("awaiting approval"); the
`enabled` bit is authoritative, the name is not.

## Second brand: Vantage Flow Media (VFM)

Since Aug 2026 this tenant serves TWO of James's businesses. Vantage Flow
Media (VFM) is his second lead-gen agency, run inside the KYP tenant by
explicit decision: same login, same DID, same box, no new business record,
standard features only. Liz (the VFM assignee, US Eastern) runs the VFM
strategy calls; James is in Hong Kong, so VFM replies must page her, not him.

How the pieces fit:

- **Persona:** the coworker presents as the owner's assistant serving both
  brands and never asks which business a contact means. Marker-delimited
  sections in `identity_md` (VFM facts) and `soul_md` (two-business rules),
  applied by `apply-vfm-brand.ts`.
- **PRICE SILENCE:** VFM is testing three management price points, and no
  surface may quote one (the AI cannot know which offer a lead saw). The
  price points live nowhere in the vault or flow copy, by design; only the
  $30/day ad-spend floor is sayable. Enforced by
  `tests/oneshot-vfm-definitions.test.ts`.
- **Brand separation at the trigger:** the VFM flow claims the three VFM
  Meta form names via OR'd webhook triggers; KYP's lead flow keeps
  "Simple form setup 5/7/26". Same mechanism, different `contains` values.
- **Lead handling:** VFM leads are tagged `VFM`, and `route_to_team` pinned
  to Liz hard-assigns them (`businesses.lead_auto_assign = true`, the Truly
  Issue 7 machinery; no other KYP flow uses route_to_team, verified before
  flipping). Ownership is what redirects `sms_customer_reply` pages to Liz.
- **The Google workspace connection is calendar-only, and nothing uses it.**
  Row `5498f3a8-7014-4ecd-9c05-4c132e890462`, `james@kypads.com`, moved to
  FIRST-PARTY Google OAuth on 2026-08-13 (`transport = direct`, same row id, no
  owner action needed: the refresh token Nango held was redeemed against our own
  verified client). Its grant carries `calendar.events` and the identity scopes
  and **no `gmail.modify` at all**, so it cannot serve mail and never could. If
  James ever wants email through Google it needs a fresh consent rather than a
  token migration.
  "No AiFlow binds it" was true and still is (all 47 checked), but it was the
  wrong question, and reading it as "nothing uses it" was wrong. Nothing binds
  this row EXPLICITLY; the resolver reached it IMPLICITLY. `resolveEmailConnection`
  walks `EMAIL_PROVIDER_CONFIG_KEYS` in order and `google` precedes `outlook`, so
  every caller that resolves a mailbox without a `fromConnectionId` got this
  Gmail-less row and a 403, shadowing the two WORKING Outlook mailboxes this
  tenant also has. The affected surfaces were `sendFromOwnerMailbox` (the voice
  `send_follow_up_email` tool) and the email-coworker inbox poll. Ordinary flow
  sends were never affected, because those go out through the tenant AI mailbox
  (`sam@newcoworker.com`), which is why nothing looked broken. Fixed in #1358:
  the resolver now skips a row whose recorded grant proves it cannot serve mail,
  and KYP email resolves to `microsoft/outlook` (verified reachable, 200).
  This predated the first-party migration; the row carried the same calendar-only
  grant on Nango since 2026-07-22 and `google` already preceded `outlook`.
  The row is also unlabeled in the older sense, carrying only
  `end_user_email`, which is why a dashboard reconnect would take the
  identity-probe branch for this tenant, which is why #1352 had to route that
  probe through the transport-aware seam: a Nango-only probe cannot resolve this
  row any more, and a failed probe inserts a DUPLICATE rather than adopting the
  existing row. **There is no rollback path:** the `google` integration was
  deleted from Nango on 2026-08-13 and took its connections with it, so
  `70df3986-...64cdbe` is gone and the dangling pointer was cleared the same day.
- **VFM booking visibility:** VFM books on Liz's own Calendly
  (`calendly.com/elizabethastone/30min`). Historically invisible to this
  tenant (one Calendly connection per business, James's), so the T-60
  confirmation parses the lead's replies via the run_agent parser ("VFM
  booked-time parser" in business_agents) and a silent booker got no
  confirmation. Multi-connection support (one row per Calendly ACCOUNT)
  now lets Liz's PAT sit alongside James's on the Integrations card; once
  she pastes it, her bookings become native (booking precheck stops the
  nurture ladder, `appointment_booked` goals fire, calendar triggers see
  her events). Liz's PAT connected 2026-08-14 ("Elizabeth Stone" row in
  `calendly_connections`), so her bookings ARE native now, and since
  2026-08-19 the "VFM Calendly booking follow-up (SMS + email)" flow rides
  them (confirmation email + SMS, T-120 attendance check, no-answer alert
  to Liz). Known small overlap, accepted for now: a booker who ALSO texted
  their call time into the nurture thread gets the lead flow's parsed
  T-60 confirm on top of the booking flow's T-120 check; the parse path
  predates booking visibility and is arguably retirable, but that is an
  owner decision, not a cleanup.
- **Timezones:** VFM nudge quiet hours are gated per-flow in
  America/New_York; the business timezone stays America/Toronto, so KYP's
  flows are unaffected.

## Sharp edges

- **This account's leads are not all North American, and the calendar flows
  once assumed they were.** 2026-08-05, Reem (`Europe/London`): the pre-call
  reminder told her a 13:00Z call was "2:00 PM Eastern time (your local
  time)". It was 2:00 PM UK. She was later told no call was starting while
  hers was seven minutes away, and she canceled. Cause: `invitee_tz_plain`
  asked the extractor for a zone from a five-item **North American** list and
  said to return 'Eastern' when unclear, so a London invitee had no correct
  answer available. The trigger payload was right the whole time
  (`invitee timezone: Europe/London`). Same defect class as Ayanna on
  2026-07-20, whose fix (PRs #810/#814/#824) reached `calendar-tools` and
  `contact-booking-context` but not the AiFlow extraction surface. Customer
  copy now says "your time" and names no zone at all, because
  `invitee_local_time` IS the invitee's wall clock; only the owner notify
  carries a zone, copied verbatim as an IANA id. Pinned by
  `tests/e2e/kyp-invitee-timezone-label.e2e.test.ts` (live) and the hermetic
  block in `tests/oneshot-kyp-definitions.test.ts`. James is relocating to
  Hong Kong, so assume international invitees are normal here.
- **A real international lead phone no longer kills a run, but no text ever
  reaches that lead either.** 2026-08-12: the first live lead off the
  "VF Media | High Intent v2" form arrived with a genuine Indian mobile
  (+91...). The VFM greeting send died at Telnyx (409/40306, "Alpha sender
  not configured": tenant long codes are domestic-only, ticket #557577), and
  the terminal step failure killed the run with 13 steps never run: the
  whole nudge ladder, the "lead went quiet" flag to Liz, and the wrap-up.
  Only the earlier s_fyi email to Liz went out. The worker now skips any 1:1
  text to a non-US/CA destination while no P2P gateway is configured
  (TELNYX_INTL_GATEWAY_E164 unset): step result
  `international_sms_no_gateway`, a note in actions_taken, a warn
  (`ai_flow_sms_international_skipped`) in this account's log tail, and the
  run continues (pinned by
  `tests/worker-integration/international-sms-skip.itest.ts`, which also
  covers the +852 roster-send class above).
  **Since Sep 2026 the skip is no longer silent toward the lead or the
  owner.** A lead-facing skip emails the lead the same message when an
  address is known: the flow files the contact (`s_file`, with
  `emailVar`) before the greeting, so both the KYP and VFM ladders reach
  an international lead by email at every rung (greeting plus nudges,
  each through the tenant AI mailbox and logged in `email_log`; replies
  land with the email coworker). The step records `email_fallback`
  (`emailed` / `no_email` / `email_failed`) and the run remembers the
  skip, so every owner alert that follows carries an appended note: the
  number, its country, that no text went out, and whether email carried
  it. In practice on this tenant: KYP's `s_notify` ("I sent them the
  greeting and I'm on follow-up duty") and `s_flag_owner` ("hasn't
  replied to 3 follow-ups") both end with that note, so neither reads as
  texts delivered. The VFM lead flow has no notify_owner step (its
  teammate touches are `send_email` to Liz), so there the platform sends
  ONE standalone owner alert at the first skip ("Heads up: I could not
  text the lead...") through the normal notify_owner ladder. On this
  tenant that ladder is the same one every other KYP notify_owner rides:
  an SMS to the `+1514` forwarding number, which James does not read (see
  the channel map above); it only falls back to email + dashboard when
  the forwarding number is absent or non-NANP. Making owner alerts reach
  James is the open channel problem, not part of this change. Liz's own FYI and
  went-quiet emails keep their existing copy and are NOT annotated
  (plain `send_email` steps cannot be told apart from lead emails). What
  still does not exist: a text to the lead, or a lead-side reply into the
  SMS `wait_for_reply` (an email reply does not resume the wait, so the
  ladder still runs its full cadence by email). The bad-phone intake arm
  (`lead_phone = "none"`) is unchanged and still does not fire for a
  real international number, by design: blanking the number would strip
  it from the contact record and the human alerts.
- **If James switches his owner phone to a Hong Kong (+852) number, every
  SMS to him goes dark and stays dark.** Telnyx confirmed (ticket #557577,
  Aug 2026) that our long codes cannot originate SMS outside NANP at all,
  and Telnyx sells no SMS-capable HK numbers, so two-way SMS to +852 is
  unachievable on this account (README, "International reachability").
  What still works: voice forwarding and warm transfer to a +852 number
  (the outbound voice profile whitelists HK; watch the fleet-wide $25/day
  voice spend limit), email, dashboard alerts, and WhatsApp, which KYP has
  NOT connected yet (no `whatsapp_connections` row). Before or when he
  switches: get his WhatsApp connected so owner alerts have a two-way
  channel, and expect the dashboard's deliverability warnings on the
  profile, alert-phone, and forwarding surfaces, which are correct, not a
  bug. A registered one-way alphanumeric sender (application drafted Aug
  2026) may later restore outbound-only SMS alerts to HK.
  Status 2026-08-19: the switch already happened silently on Jul 30, in
  dashboard chat (James asked to replace his Montreal number with a Hong
  Kong one): the roster row is +852, team texts to James have been dying
  since, the notification-preferences alert phone still holds the old
  Montreal +1 number, and the chat coworker twice blamed his number's
  settings instead of naming the platform limit. PR #1514 makes every send_sms and roster
  tool state the +1-only fact and recommend WhatsApp; Brian has told
  James to connect WhatsApp (pending on James).
  Status 2026-08-26: WhatsApp IS connected (since Aug 20), but the WABA
  cannot START conversations: every business-initiated send fails with Meta
  error 131042, "Business eligibility payment issue", which is billing, not
  verification. Confirmed from the delivery receipts PR #1609 added: every
  owner-alert template send to his Canadian mobile is stamped `failed` with
  that code, so he is receiving NO WhatsApp alerts. James reports Meta will
  not accept his Canadian payment method. Note the shape of the limit: only
  business-initiated (billed) conversations fail. A reply inside the 24-hour
  window opened by an INBOUND message is free-form and unaffected, which is
  why the live customer threads on this WABA work normally.
  Status 2026-08-28: the ROSTER half is fixed. `repoint-roster-member-phone.ts`
  moved James's `ai_flow_team_members` row from the +852 number to his
  Montreal `+1514…` mobile and set `james@kypads.com` on it (ledger id 244,
  owner-directed by Brian, who was told James is physically in Hong Kong).
  Three things were broken by that one field, not one: (a) every team/lead-offer
  text died with 409/40306 and raised an `alert_delivery_failed` system error,
  (b) the roster phone never matched the business's own numbers, so
  `pickImplicitContactOwner` returned null and EVERY contact-scoped alert
  routed as `team_broadcast` / `contact_unowned` instead of paging him
  directly, and (c) because routing was never `contact_owner`, the roster
  email was never consulted at all (`src/lib/notifications/dispatch.ts` reads it only when
  `emailTarget === "contact_owner"`), which is why adding an email without
  fixing the phone would have been a no-op. Verified after the apply: the
  live helper now returns him as the solo owner, and the roster is still
  exactly one row (a second row would have re-broken it, which is why the
  script UPDATEs in place and refuses a collision). His OWNER alert phone
  (`notification_preferences`) was already this +1 number and is untouched;
  nothing here changes the WhatsApp billing block above.
  **CORRECTION, same day, and the important half: SMS reaches James on NO
  number at all.** The repoint was argued from Telnyx delivery receipts (16
  of 16 owner alerts stamped `delivered` over 7 days) read as proof the +1
  number reaches him. It is not proof. Brian confirms **James carries no
  Canadian SIM**; the number is still his, so nothing is leaking to a
  recycled subscriber, but nobody is reading it. A carrier `delivered`
  receipt means a device on the network acknowledged the message, never that
  the intended person holds that device, and no receipt of any kind can close
  that gap: only the person can.
  So the true channel map for James is: **email (`james@kypads.com`,
  Resend-confirmed) and the dashboard, and nothing else.** WhatsApp is dead
  on billing 131042, SMS to +852 cannot be originated by our long codes, and
  SMS to the +1 is accepted by the carrier and read by no one.
  Known cost of the repoint, accepted by Brian (2026-08-28) rather than
  reverted: team/lead-offer texts used to fail LOUDLY at Telnyx (40306,
  raising `alert_delivery_failed` on the admin System Errors card) and now
  succeed silently into a handset nobody checks. The dead channel is no
  longer visible to us. Do not read the absence of `alert_delivery_failed`
  rows on this tenant as the SMS leg being healthy; it is the same outage
  with the alarm disconnected. Claim-by-reply-"1" is likewise now wired to a
  number he does not read, so an unclaimed offer here means "never seen",
  not "declined".
  The corroborating signal was there and was discounted: the LAST inbound SMS
  from that +1 number is **2026-07-24** (`tsx debug/trace-sms.ts --to <his +1>
  --since 60d`, 229 outbound / 11 inbound, 121 sends the carrier never
  confirmed). He asked to switch his number to the Hong Kong one on Jul 30,
  six days later. Silence since Jul 24 across 35 days and ~200 sends was the
  real evidence about reachability, and every one of those sends still came
  back `delivered`. When asking "is the owner getting our alerts", weigh the
  last INBOUND far above any delivery receipt.
  **The alarm is now automatic** (2026-08-28, same day). That "weigh the last
  inbound" instruction is a habit nobody can be relied on to keep, so it is a
  daily check instead: `channel-liveness-sweep` reads, per tenant and per
  channel, whether a HUMAN has acted lately and raises an admin `system_logs`
  row when one of the channels we actively send on has gone quiet. Run it by
  hand, read-only, with `tsx debug/channel-liveness-report.ts --business
  056034a7-e84c-444d-8d15-747eeb1fa899`. KYP resolves to **degraded**, not
  dark, which is the honest answer: SMS and WhatsApp are gone, email and the
  dashboard still land. Two details of this tenant shaped the design and are
  worth knowing before trusting the output elsewhere. First, the check reads
  the OWNER's WhatsApp thread specifically, matched by `psid`: KYP has four
  lead threads whose newest message is hours old, and reading the newest
  thread of any kind would report WhatsApp as live on the one tenant whose
  WhatsApp has been dead on 131042 for weeks. Second, the dashboard read that
  keeps this tenant off "dark" is only trustworthy going forward: reads are
  stamped with an actor from 2026-08-28, admin reads are discarded, and every
  read before that date stays unattributed forever, so the ~4-day-old read
  found during this investigation cannot be proven to have been James rather
  than us.
- **The WABA sender number is James's own phone, so he cannot be reached on
  WhatsApp at it.** The Cloud API sender is the +852 number, and a number on
  the Cloud API is taken off consumer WhatsApp: messages to it arrive at our
  webhook rather than on a handset. Owner alerts therefore target his
  Canadian mobile (`notification_preferences.phone_number`), which is also
  `businesses.phone`. Practical consequence, and the reason PR #1632 exists:
  the one WhatsApp path that works for him today is HIM messaging the
  business number first, which opens the 24-hour window and gets a free-form
  reply that billing cannot block. Before that PR, doing so would have
  reached the CUSTOMER sales assistant, which would have pitched him and
  filed him as a lead. He has not tried it yet (the WhatsApp conversation row
  for his Canadian mobile is outbound-only, `last_user_message_at` is still
  epoch zero), so this was latent rather than experienced.
  **Resolved as far as it can be, 2026-08-31.** James has confirmed he is not
  fixing the billing, so the owner-alert WhatsApp leg is switched off here
  (`disable-undeliverable-whatsapp-alerts.ts`, in the One-shots section
  below) and the daily `whatsapp_message_failed` error stops. Two things to
  hold on to. First, this is muting a channel that was already delivering
  nothing, not giving anything up: 19 of 19 receipted sends failed, and with
  `last_user_message_at` at epoch zero the free window has never been open,
  so no alert has ever reached him here. Second, the platform no longer LIES
  about the ones that did go out: a `failed` receipt now walks back to the
  `notifications` row it belongs to and flips the `sent` status the
  dispatcher wrote on Meta's acceptance, so the dashboard, the unread badge
  and the liveness sweep stop counting delivery that did not happen. The
  channel map for James is unchanged by any of this: email and dashboard,
  nothing else.
- **Calendly event-type names carry the price tier, and renaming one breaks a
  flow silently.** `my-free-scale-plan` is titled "KYP Ads | Free Strategy
  Call" ($100/wk); `kyp-ads-free-strategy-2` is titled "KYP Ads | Free
  Strategy Call | **Client**" ($200/wk). The no-show flow still branches on
  the string `"free strategy call | 2"`, which no live event type matches
  any more, so a $200 no-show falls through and is texted the $100 link,
  which the wrong-link flow explicitly forbids. Latent so far: both runs to
  date (Jul 20, Aug 1) were genuine $100 events.
- **The Canadian DID is not incidental.** Auto-DID assignment failed for a
  Canadian owner during onboarding, and `TELNYX_MESSAGING_PROFILE_ID_CA` being
  unset in local runs is a documented trap. Anything touching DID assignment
  or messaging profiles should be tested against a CA number, not just a US
  one.
- **Booked-then-enrolled was a real bug here.** A lead who had already booked
  kept getting nurture texts. The fix is the synchronous booking precheck plus
  a widened sweep (PR #770); if you change enrollment, keep
  `tests/worker-integration/calendly-booking-goal-gap.itest.ts` passing.
- **Business hours gate this account's sends** (PR #770,
  `patch-kyp-business-hours.ts`). A change that ignores quiet hours will text
  James's leads at night.
- **Noise reduction was a deliberate campaign** (PR #795): short-link AI
  replies, an `event_end` thread-activity guard, booking-status context. James
  notices chattiness.
- **This account has both `mark-lead-spam.ts` and `undo-spam-flag.ts`
  applied.** Spam flagging has been used and reversed here, so check
  `flag_contact_spam` state before concluding a lead is being ignored.
- **The box was adopted from a pool**, and the adopted box once served the
  previous tenant's tunnel (`rowboat_http_530`). The adoption-pool checklist
  in the incident doc exists because of this account.
- **2026-07-29 term-renewal cutover:** overnight sweep bought `1864812`
  (fail-but-charge orphan) instead of renewing `1800985` (~43% savings).
  Orchestrator stalled at 40% (`remote_deploy_starting`); cutover was finished
  manually (restore, billing repoint, old box stop + auto-renew off + pool
  `never_renew`, provisioning marked 100% without owner SMS). Owner notify
  on background migrations is now suppressed via `suppressOwnerNotify`
  (PR #1011).
- **2026-07-31 term-renewal cutover, two days later, and it should not have
  happened.** The 11:01 UTC sweep bought `1869876` and moved KYP again, then
  pooled `1864812` with `never_renew`. Third box in three days for this
  tenant, and `1864812` was stranded barely two days into a paid month. Cause:
  the renewal window was 30 days, but a monthly Hostinger box is never more
  than ~30 days from its next bill, so the box the sweep had just bought
  re-qualified immediately. Scar Fairy was hit by the same bug on 2026-07-30.
  Fixed in two parts: PR #1039 narrowed the window (now 36 hours, so the sweep
  moves a tenant about a day before renewal), and the purchase cooldown means
  a tenant we bought a box for in the last 7 days is never bought another.
  **When reading this account's history, do not assume one box per month:
  check `vps_inventory` for how many boxes carry this business id.**
- **2026-08-06 Canada-whitelist outage: this tenant is the fleet's canary
  for Canadian traffic.** The Aug 5 profile-widening one-shot replaced
  every Telnyx whitelist with a dial-table-derived list that cannot
  contain CA (bare +1 maps to US), so all SMS to Canadian numbers failed
  with Telnyx 40309 from Aug 5 ~15:00 UTC until the profiles were
  re-patched Aug 6 ~20:30 UTC. Only KYP was hit: 22 errors, all Aug 6
  15:03 to 19:51 UTC, being notify_owner alerts to James's forwarding
  number and the lead follow-up to lead H Eve, which never sent. The widen
  script now unions instead of replacing and refuses a list without
  US/CA/MX (`scripts/oneshot/widen-telnyx-allowlist.ts`). If a Canadian
  send fails with "Invalid destination region 'CA'" again, check the
  profile whitelists first.

## One-shots

**Voice infra (Aug 2026):** `migrate-tenants-to-dedicated-telnyx-apps.ts` moves
this tenant off the shared Telnyx Call Control app/profile onto a DEDICATED
app + outbound voice profile (both named with the searchable marker
`[nc:<business id>]`): carrier-enforced concurrent-call cap equal to the plan
tier, a per-tenant $25/day spend fuse, the full destination whitelist, and the
DID re-pointed onto the tenant app. Idempotent (re-runs adopt by marker).
Whether it has run is in the applied_oneshots ledger.

Onboarding: `provision-kyp-ads-retry.ts`, `assign-kyp-ads-did-438.ts`,
`apply-kyp-intake.ts` (the white-glove intake applied to the tenant),
`send-kyp-live-sms.ts`.

Recovery: `requeue-failed-flow-run.ts` (generic; applied here Aug 6 2026 to
re-run the lead flow for H Eve after the Canada-whitelist outage killed run
4e9fdf3c at its first customer text), `repoint-roster-member-phone.ts`
(generic; applied here Aug 28 2026 to move James's roster row off the
untextable +852 number onto his +1514 mobile and set his email, ledger id
244, details in the +852 sharp edge above).

Owner-alert WhatsApp switched OFF 2026-08-31:
`disable-undeliverable-whatsapp-alerts.ts` (generic, evidence-gated) sets
`notification_preferences.whatsapp_urgent = false` here. James has told us he
is not fixing the 131042 billing block, and this tenant meets every bar the
script refuses without: 19 of 19 receipted sends on his own thread failed,
all on 131042, and `last_user_message_at` on that thread is still epoch zero,
so the free 24-hour window has never once been open and no alert could ever
have landed. Nothing else changes: the integration stays connected, inbound
customer threads (which are customer-initiated and therefore unbilled) keep
working, and his alerts continue by email and dashboard. Re-enable from
Dashboard > Settings > Notifications if he ever fixes billing or messages the
business number, and confirm with `npx tsx debug/whatsapp-delivery-report.ts`.

Vantage Flow Media rollout: `apply-vfm-brand.ts` (vault sections + sync),
`apply-vfm-team.ts` (Liz on the roster + `lead_auto_assign`),
`seed-vfm-lead-aiflow.ts` (parser agent + the VFM lead flow). Content and
flow shape are pinned by `tests/oneshot-vfm-definitions.test.ts`.

Owner-directed fixes 2026-08-19: `patch-kyp-vfm-booking-liz-emails.ts`
(transforms pinned by `tests/oneshot-kyp-vfm-booking.test.ts`) enables and
renames the chat-drafted booking follow-up with a trigger that can actually
fire (event TITLE, not the scheduling link), keeps the superseded first
draft off without deleting it, unifies the lead flow's Liz emails onto the
address the owner gave in chat, and repoints the two memory identity lines
off the retired outbound address (the "do not use" instruction line stays).
Addresses are argv-only; run it as (ids are this tenant's booking flow,
old draft, and business):

```bash
npx tsx scripts/oneshot/patch-kyp-vfm-booking-liz-emails.ts \
  --business 056034a7-e84c-444d-8d15-747eeb1fa899 \
  --booking-flow 7ffc3fd0-fc41-44cf-9a67-4bb70461dbb8 \
  --old-draft-flow 7a6918af-326c-416c-a663-cf429faf34e7 \
  --liz-email liz@vfmedia.io --old-liz-email liz@lizdev.com \
  --platform-email sam@newcoworker.com --retired-email sam@kypads.com
```

Flow definitions: `kyp-lead-flow-definition.ts` (previously named
kyp-offer-definition.ts), `kyp-noshow-definition.ts`,
`kyp-reminder-flow-definition.ts`,
`vfm-lead-flow-definition.ts` (seeded by `seed-vfm-lead-aiflow.ts`).

`kyp-reminder-flow-definition.ts` is the canonical shape for the two
calendar-side flows, "Pre-call reminder (1hr before)" and "Booking
confirmation (SMS + email)". Neither had a repo copy before 2026-08-05, which
is how the Reem timezone defect above survived a platform fix aimed at the
same failure mode: there was nothing to grep, review, or test. Captured from
live and verified byte-for-byte against the `ai_flows` rows, so any future
change belongs in the builder and reaches the tenant through a one-shot.

Patches: `patch-kyp-timezone-labels.ts`, `patch-kyp-noshow-event-title.ts`,
`patch-kyp-cancel-tool-policy.ts`, `patch-kyp-business-hours.ts`,
`patch-kyp-noshow-links.ts`, `patch-kyp-calendar-contact-filing.ts`,
`enable-kyp-reply-alerts.ts`, `set-kyp-booking-email-sender.ts`,
`reenroll-kyp-canceled-runs.ts`, `backfill-calendly-booking-goals.ts`,
`fix-kyp-kav-contact.ts`, `mark-lead-spam.ts`, `undo-spam-flag.ts`,
`strip-em-dashes-flows.ts`, `rename-phone-named-gate-fields.ts`,
`patch-kyp-bad-phone-intake.ts`, `patch-kyp-booking-missing-details.ts`.

`patch-kyp-booking-missing-details.ts` (Aug 27 2026, fleet
fallback-composition audit): both calendar flows quoted extraction fields
that fall back to the literal 'none' inside spoken sentences with no guard,
so a malformed Calendly payload would have texted a lead "your free strategy
call on none at none your time" (0 misses in 57 runs, but nothing stood in
the way). Each customer send is now a guarded specific/generic pair behind a
details-known gate field (`booking_details_known` / `reminder_details_known`);
the generic copy points at the calendar invite. The confirmation SMS needs
lead_reachable AND the gate, and a step carries one `when`, so `confirm_sms`
now nests inside the `confirm_sms_gate` branch. The owner notify labels each
fact ("Day: none" reads as a fact). This patch ADDS steps, so unlike the
timezone patch it shifts flat step indices: the apply refuses while any
non-terminal run sits at or past the first differing index (both flows finish
in seconds). Transforms pinned by `tests/oneshot-kyp-definitions.test.ts`
(the pre-fix fixture now chains through BOTH patches to reach the builder).

`patch-kyp-bad-phone-intake.ts` is the Aug 1 2026 undialable-lead fix: a
Facebook lead typed a `+1` number with three stray extra digits (13 national
digits, structurally E.164, impossible in NANP) and the greeting send died at
Telnyx (400/40310) with the owner-notify step behind it. The engine now
scrubs impossible `+1` numbers to "none" (`coerceDialableE164`), and this
patch gives the flow a designed no-phone path: notify James, email the lead
the booking link, skip the reply ladder. The same PR reconciled
`kyp-lead-flow-definition.ts` to the live shape after an unledgered Jul
19-24 reshape had made the old builder stale (live is the source of truth;
the stale applier patch-kyp-offer-branch.ts was retired, see the Removed
section of scripts/oneshot/README.md).

`rename-phone-named-gate-fields.ts` renames the booking flow's `has_phone`
gate to `lead_reachable`.
`has_phone` holds "yes"/"no", but `isPhoneFieldName` matches any phone token in
a field name, so the phone-field validator added in PR #885 rewrote both values
to "none" and would have killed the `confirm_sms` and `file_contact` steps on
the next run. The flow had not fired since Jul 23 2026, so it was caught while
still latent, unlike the same bug on Amy's ReferralExchange flow. Check for the
shape with `tsx debug/audit-phone-field-names.ts`.

### A booked lead can stay in the nudge ladder (identity mismatch)

A nudge ladder stops for exactly two reasons: the lead texts back, or a
booking observer identifies them and fast-forwards the run. Identification is
by phone and email, so a lead who books under a DIFFERENT email than their
lead form captured, on a booking with no phone, is invisible to it.

On 2026-08-19 a lead booked 1.8 seconds BEFORE the flow's first message, using
a different address than her lead record and giving Calendly no phone. Three
more nudges followed over three days, the last inviting her to book the call
she had already booked. She never replied, so nothing else could stop the
ladder. James raised it on 2026-08-21 and the run was cancelled by hand.

This is not rare: 4 of the tenant's 37 August bookings used an address that did
not match their lead record. The pattern is a personal address on the ad form
and a work address at booking.

The AI's Aug 21 answer, disabling the booking-confirmation SMS, addressed a
message that lead never received; there is no confirmation text anywhere in her
history. James's "i just want a text 1 hour before the call thats it" is a
booking-detection ask, not a confirmation-text ask.

Closed by the name fallback in `src/lib/ai-flows/booking-goal-fire.ts`: when
phone and email both fail to identify a booking, its name is matched against
the lead names of LIVE runs only, requiring at least two name tokens. Audit it
with `tsx debug/booked-lead-nudge-audit.ts`, where a NAME-ONLY hit on a nudge
flow means the fallback missed. James has declined to make the phone field
required on his Calendly event type, so the fallback is the load-bearing fix
rather than a backstop.

## History

PRs #617, #641, #693, #715, #756, #768, #770, #795, #1011. Diagnostics:
`debug/diag-kyp-box.ts`, `debug/fix-kyp-tunnel.ts`,
`debug/kyp-calendly-zoom-check.ts`.
