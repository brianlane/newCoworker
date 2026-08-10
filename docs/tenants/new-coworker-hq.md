# New Coworker (HQ, internal)

Our own tenant. It is simultaneously the dogfood account, the homepage demo
voice line, the site webchat backend, and the default target of every smoke
and e2e script. That overloading is deliberate, and it is the thing to
remember before running anything here.

## Identity

| | |
| --- | --- |
| Business id | `8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d` |
| Tier / box | enterprise, VPS `1806097` (KVM1: 1 vCPU / 4GB) |
| DID | `+16023131823` (also the homepage demo line) |
| Owner | New Coworker Team |
| Onboarded | 2026-07-16 (`scripts/oneshot/onboard-hq-tenant.ts`) |
| Roster | Brian |

There is deliberately **no separate smoke tenant or box**. The old "NCW Flow
Test" tenant and the KVM1 smoke clone were retired when HQ was onboarded. Full
operating detail is in [debug/README.md](../../debug/README.md); this file is
the summary.

## What HQ carries

- **The homepage demo voice line.** A stranger can call `+16023131823` from
  the marketing site and talk to a real Gemini Live session.
- **The newcoworker.com webchat**, re-keyed onto HQ by
  `debug/webchat-rekey.ts`.
- **Contact-form and signup triage**, so our own inbound leads run through our
  own product.
- **The e2e / smoke default.** Anything in `debug/` that writes without an
  explicit business id writes here.
- **Tenant zero for Prospecting.** Our own outbound outreach runs through our
  own product: Places discovery across Phoenix-metro trades (12 paid queries
  a day on the Enterprise budget, double the Standard 6), a pitch built
  from what each prospect's site is missing, sent from HQ's connected mailbox.
  Configured by `configure-hq-prospecting.ts` in **manual mode**, so drafts
  wait on a human until the copy earns automatic sending. See the README's
  Prospecting section.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Demo caller follow-up (contact_created, 6) | on | Follows up with people who call the demo line |
| Webchat lead follow-up (contact_created, 6) | on | |
| Team inbox triage (email, 15) | on | Classifies sales/support/billing/receipts/automated mail, texts Brian, and applies HQ/* Gmail labels via email_organize. **Nothing is ever removed from the inbox**: no archive, and no `moveToFolder` either, since in Gmail a folder move strips the INBOX label and that is archiving by another name (Brian went looking for the Bobby referral on Aug 8 2026 and could not find it, because it sat under HQ/Sales alone). **Payment receipts are STARRED** and left in place, matching what Brian does by hand: every starred message in the live mailbox is a receipt or invoice (Anthropic, Vercel, Supabase, Telnyx, Google Payments, Resend). `email_organize` gained `star`/`unstar` for this (Gmail STARRED label, Outlook follow-up flag; the AI mailbox has no star and says so rather than reporting a success it did not perform). Routine payment receipts deliberately do not page the owner (PR #792). Each alert names the real subject from `{{trigger.subject}}`, carries **no link at all** (the Gmail deep link opened Gmail on the WEB from a phone, and swapping it for our own `/dashboard/emails?id=` only moved the login wall, so the text now carries sender, subject, ask and the full draft, and approval is a digit reply needing no browser), and cools down 12h per `{{trigger.thread_id}}`, so a reply on a thread Brian was already told about does not text him twice; filing still runs on the quiet reply. **Sales leads are now ANSWERED, not just announced**: the flow drafts a reply with the "Team inbox reply drafter" Agent, texts Brian the gist plus the draft at an approval gate, and on approval sends it INSIDE the original Gmail thread and claims that thread, so every later message on it is handled autonomously by the email coworker. Replying to the gate with free text ("shorter, drop the second paragraph") rewinds to the drafter and asks again. Support and billing stay alert-only by design, the deliberate first rollout. A draft that comes back NO_REPLY falls back to the plain alert, so a real lead never resolves to silence. The drafter is also told WHO IS ON the email (`To`/`Cc` are templated into its input) and will not write at someone who is not: on Aug 6 2026 James referred a client named Bobby without adding him, and the draft opened "Bobby, please reach out" to an email only James received. An address counts for a person only when it visibly carries their name, so a generic address is never assumed to be the prospect; a blank `To` line means unknown, not absent, and the reply speaks to the prospect as before. **Automated mail is split into THREE tiers by consequence**, not by sender: `automated_important` (it asks us to do, verify, approve or respond to something, or reports an outage, security alert, suspension or broken integration) texts Brian and is left UNREAD and in the inbox on purpose; `automated_notice` (routine, asks nothing) is marked read, labelled `HQ/Automated` and **archived**; only `automated_bulk` (marketing, newsletters, promotions) is **moved to the Gmail bin**. The middle tier exists because the two-tier version was destructive on every mistake: on Aug 9 2026 an email titled "[Action Needed] OAuth Verification Request Acknowledgement", on a thread Brian had already replied to, was read as routine and binned. A classifier is sometimes wrong, so uncertain mail is now merely read and labelled, staying exactly where it was. That email had a second tell nobody could use at the time, and it is now wired in: **`{{trigger.thread_has_our_reply}}`** says whether this business has already SENT on the conversation, and `emailTriggerScope` appends a marker to `windowText` so the classifier actually sees it (`classify` reads windowText and its `question` is not templated, so that is the only path in). Mail continuing a conversation we are in is never routine and never bulk, and unlike a phrase match that holds however the sender words the subject. Binned mail is labelled first, so it stays findable with `label:HQ/Automated in:trash` for the 30 days Gmail keeps it, and there is still no hard delete anywhere in the engine. That category previously matched and then did nothing, so unsubscribable Zapier mail accumulated unread. **The flow never answers its own mail.** On Aug 7 2026 the sales arm replied-all, which cc'd `team@newcoworker.com`; the Cloudflare catch-all forwards that into the connected mailbox, so the reply arrived as genuinely received mail and the flow drafted a fresh answer six times over. `provider_account_email` is `newcoworkerteam@gmail.com`, so the old self-check never matched the alias. Two guards now: the Gmail poll query carries `-from:me` (the provider's own alias list, which is the set we cannot enumerate) and the poller drops any sender on the tenant email domain, logging `ai_flow_email_poll_self_sent_skipped`. The reply-all cc also excludes that domain, so the copy is never generated in the first place. **Hosting renewal and expiry notices are routine on purpose**: `src/lib/vps/billing-posture.ts` is the system of record for fleet renewals (it auto-heals auto-renew for boxes a paying tenant depends on and honours a `never_renew` flag for boxes that must lapse by design), and the classifier cannot tell a box we are about to lose from one we chose to let go. On Aug 6 2026 Hostinger mailed that the KVM 2 plan on srv1800985 had expired and the flow texted a billing alert; that was the retired residency-pilot box, so lapsing was the plan. A declined card, a dispute or an invoice we owe is still `billing`, since no cron owns those |
| Contact form triage (webhook, 2) | on | Feeds the admin-designated sink business (PR #773) |
| Meta lead follow-up (webhook, 4) | on | |
| Lead intake & follow-up (Privyr) (TEST COPY of Truly) | on | The AiFlow e2e harness fixture, laid down by `debug/flow-test-setup.ts` |
| Google review demo reply (email, 2) | off | Reviewer-facing demo |
| New Contact Greeting (contact_created, 1) | off | |
| Prospect outreach follow-through (webhook, 3) | on | Files and tags the businesses our outbound outreach emails (PR #972). Installed disabled, enabled by Brian once the notify step was gone; the pitch itself is sent in code, not by this flow, and the per-prospect owner text was removed (it would have been 12 texts a day announcing that strangers got email) |

## Booking

The public page is `/book/newcoworker` (token `ncb_df13…`), linked from both
follow-up flows. Calendar is `newcoworkerteam@gmail.com` via Nango; Zoom is
`team@newcoworker.com`.

| Meeting | Length | Visible |
| --- | --- | --- |
| Discovery Call | **60 min** | yes |
| Support Call | 30 min | yes |
| White Glove | 60 min | hidden |
| Honed Tech Audit | 60 min | hidden |

**The discovery call is 60 minutes.** Any copy that names a length must say
so, which is why `sync-hq-booking-copy.ts` derives it from the meeting type
instead of hardcoding it. Change the length in the Bookings dashboard, then
re-run that script and the SMS bodies follow.

Two paths book this call and they used to disagree. A prospect who CLICKS the
link books the meeting type's own length. A prospect who REPLIES with a time
gets the coworker's `calendar_find_slots` call, and an AI-made booking carries
no `meeting_type_id` (README, "Public self-serve booking page"), so it has no
length to inherit: it took the tool's 30-minute default until the scheduling
prompt line started stating the real duration. For three weeks in Jul 2026 the
copy said 15, the click path booked 60, and the reply path booked 30.

`booking_pages.allowed_durations` is legacy here: meeting types own what a
visitor actually books.

## Sharp edges

- **The box is shared hardware.** `srv1806097` also hosts **JobArms**, our
  second product, namespaced end to end. It is the only co-tenanted box in the
  fleet and no customer box may ever join it. Anything that re-images it
  destroys JobArms with no backup of ours to restore:
  `debug/migrate-vps-size.ts` refuses without `--shared-box-ack` and the admin
  panel refuses outright.
- **It is resource-tight by decision.** 4GB and one core, two Chromium
  sidecars, and it answers the demo line over Gemini Live, which is the least
  forgiving neighbor there is. When HQ's voice or chat is slow, read the
  `memory_headroom` posture check before blaming the voice bridge.
- **HQ is long-lived: never bulk-delete its rows.** `flow-test-reset.ts` is
  scoped to the test flow's runs for exactly this reason.
- **Smokes spend HQ's budget and land in HQ's history.** That is the point
  (never a customer's), but it means HQ's usage numbers include our testing.
- **JobArms holds a decrypted copy of this box's SSH key.** The one place a
  credential of ours lives outside this repo, an explicit decision, this
  internal box only. Rotating the keypair means the JobArms deploy needs the
  new one.
- **The inbox-triage builder had drifted from live for two weeks.** Until Aug
  5 2026 the live flow ran 5 steps while
  `scripts/oneshot/setup-hq-inbox-triage-flow.ts` defined 8: the three
  `email_organize` steps were in the repo but had never been applied, so no
  HQ/* label was ever written even though this file claimed otherwise. The
  builder is not the source of truth, the `ai_flows` row is. That one-shot's
  dry run now prints a per-step add/change/remove diff against live, so the
  next divergence shows up before `--apply` rather than after.

## One-shots

`onboard-hq-tenant.ts`, `configure-hq-dogfood.ts`, `setup-hq-dogfood-flows.ts`,
`setup-hq-inbox-triage-flow.ts` (its definition lives beside it in
`hq-inbox-triage-definition.ts`, split out so
`tests/oneshot-hq-inbox-triage-definition.test.ts` can pin the alert copy
without the applier's Supabase connection running),
`hq-inbox-reply-drafter.ts` (the saved-Agent instructions that draft the reply
in Brian's voice, pinned against a live model by
`tests/e2e/hq-intro-reply.e2e.test.ts`; the booking link lives in these
instructions because a `run_agent` step never sees `bookingLinkPromptLine`),
`enable-hq-booking-page.ts`,
`patch-hq-booking-offer.ts`, `sync-hq-booking-copy.ts`,
`fix-hq-placeholder-contact-names.ts`, `set-hq-digest-prefs.ts`,
`configure-hq-prospecting.ts`, `quiet-hq-prospect-flow.ts`.

**Order matters for the two follow-up flows.** Their live SMS bodies are the
product of three scripts layered in sequence, so re-running an earlier one
reverts the later ones: `setup-hq-dogfood-flows.ts` seeds the bodies,
`patch-hq-booking-offer.ts` adds the discovery-call offer,
`enable-hq-booking-page.ts` appends the public booking link, and
`sync-hq-booking-copy.ts` resyncs the quoted call length. Re-run them in that
order, or just run `sync-hq-booking-copy.ts` when only the length changed.

## History

PRs #700 (retarget the smoke/e2e harness defaults here), #776 (HQ dogfood
config and team-inbox triage), #792 (stop owner SMS for routine receipts),
#899 (booking page enabled and linked from the follow-up flows), #921
(guardrails for the co-tenanted box).
