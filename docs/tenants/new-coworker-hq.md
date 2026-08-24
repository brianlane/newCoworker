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
- **Tenant zero for the Slack integration** (Aug 10 2026). Connected to the
  "New Coworker" workspace (team `T0BP5MBN1AR`, bot `U0BQ77AUR24`), alert
  channel `#all-new-coworker`. Live-smoked the same day: hello post, an
  alert card through the production delivery path, and a signed
  `app_mention` answered in-thread by the inline engine in ~40s. The smoke
  also caught the `users.info` JSON-body bug (owner identity resolved as
  team) fixed in the follow-up PR; docs/SLACK-INTEGRATION.md is the
  operational runbook.
- **Slack approval buttons verified end to end** (Aug 13 2026), the one
  path the Aug 10 smoke could not reach because nothing was parked at a
  gate. A throwaway three-step flow (`notify_owner`, `approval_gate`,
  `notify_owner`) was created on HQ, run, and deleted afterwards; HQ is
  back to its usual flows and no test artifact remains. The card posted to
  `#all-new-coworker` with Approve / Skip step / Cancel workflow, pressing
  Approve moved the run from `awaiting_approval` to `queued` with
  `decided_by: slack:U0BP96TFHB4`, the guarded final step then ran, and the
  card rewrote itself to "Approved, sending it now. (newcoworkerteam)" with
  the buttons removed. The owner-only guard was proved separately on the
  Slack review sandbox, whose owner is `slack.reviewer@newcoworker.com`: a
  correctly signed Approve from Brian's sandbox Slack user
  (`brianlane2@gmail.com`) answered `refused: not_owner` and left the run
  parked with no decision recorded. Reading the card back through the API
  is impossible by design, since the app never requests `channels:history`;
  it was confirmed in the Slack client instead.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Demo caller follow-up (contact_created, 6) | on | Follows up with people who call the demo line |
| Webchat lead follow-up (contact_created, 6) | on | |
| Team inbox triage (email, 15) | on | **Left out of the daily and weekly summary emails** (`options.hideFromDigest`, Aug 17 2026). A mailbox poller's run count measures how much mail arrived, not how much happened: the Aug 17 daily summary was 21 events, 17 of them one line each reading "Team inbox triage (HQ), done", with the day's single real call and single new customer buried underneath. This flow texts Brian the moment anything here needs him, so its runs were the one part of that email he could never act on. Pinned in the builder, not left to the dashboard toggle, because re-running the applier resets the live row. This is a DIFFERENT control from `digest_customer_facing_only` (set by `set-hq-digest-prefs.ts`), which decides whether the digest sends AT ALL on a quiet day; that one did not help here, since Aug 17 had real customer activity, so the digest correctly sent and then buried it. Classifies sales/support/billing/receipts/automated mail, texts Brian, and applies HQ/* Gmail labels via email_organize. **Nothing is ever removed from the inbox**: no archive, and no `moveToFolder` either, since in Gmail a folder move strips the INBOX label and that is archiving by another name (Brian went looking for the Bobby referral on Aug 8 2026 and could not find it, because it sat under HQ/Sales alone), and, since Aug 21 2026, no `trash` either: the bulk tier's bin move is gone (details below). **Payment receipts are STARRED** and left in place, matching what Brian does by hand: every starred message in the live mailbox is a receipt or invoice (Anthropic, Vercel, Supabase, Telnyx, Google Payments, Resend). `email_organize` gained `star`/`unstar` for this (Gmail STARRED label, Outlook follow-up flag; the AI mailbox has no star and says so rather than reporting a success it did not perform). Routine payment receipts deliberately do not page the owner (PR #792). Each alert names the real subject from `{{trigger.subject}}`, carries **no link at all** (the Gmail deep link opened Gmail on the WEB from a phone, and swapping it for our own `/dashboard/emails?id=` only moved the login wall, so the text now carries sender, subject, ask and the full draft, and approval is a digit reply needing no browser), and cools down 12h per `{{trigger.thread_id}}`, so a reply on a thread Brian was already told about does not text him twice; filing still runs on the quiet reply. **Sales leads are now ANSWERED, not just announced**, and an introduction gets **TWO tailored emails, not one reply-all**: the flow drafts a note to the prospect and a separate note to the introducer with the same "Team inbox reply drafter" Agent (the `WRITE:` line in the input picks which), texts Brian the gist plus BOTH drafts at one approval gate, and on approval sends them as two messages. One combined reply read oddly to both parties, since each saw a paragraph written for the other and on a phone the recipient list is not even visible (Aug 9 2026). Both sends are threaded into the original Gmail conversation but carry `replyAll: false`, because mirroring the original recipients would put both people back on both notes. The prospect note is addressed with **`{{trigger.others_to}}`**, everyone on the mail who is neither us nor the sender, with `others_cc` carrying any extras; when that is empty the drafter returns NO_REPLY and the send skips, so the introducer note becomes the whole reply and asks for the connection instead. The gate declares **`guardsNextSteps: 2`**, without which answering "skip" (or a cooling gate) would have skipped only the first send and mailed the prospect unapproved. The first send claims the thread, so every later message on it is handled autonomously by the email coworker. **Both replies carry the real branded signature** (logo, "Brian Lane, Founder", the HQ number, the web link) from `platformSignatureHtml` in `src/lib/email/branded-html.ts`, the same block the platform's own templates use and the artwork in `docs/email-signatures.html`. It is composed by the SEND PATH, never written by the model: a signature is exact by nature, and a model asked for one invents a title or a phone number. That made the replies multipart, so `sendFromMailboxConnection` gained `bodyHtml` (Gmail `multipart/alternative` with the text part first; Graph `contentType: HTML` on both `sendMail` and `/reply`, where it must ride `message.body` because `comment` is escaped). The signature is **platform identity only**: the route honours `brandedSignature` for `HQ_BUSINESS_ID` and ignores it for every other business, so a tenant flow copying the step cannot put Brian's name and phone under their own From header. **The coworker never auto-answers a conversation we have already replied to.** Claiming the thread used to make the triggering email retroactively eligible for the coworker's own poll (still inside its lookback window, now on an owned thread, never seen by the coworker), so on Aug 10 2026 James got the flow's reply and an off-script second one a minute later. The guard keys on threads a GATED FLOW answered, via `threadsAnsweredByFlow` (the discriminator is `run_id`, which the flow worker stamps and the coworker and outreach sweep leave null): once Brian has approved a reply on a conversation, every further reply goes back through the same gate instead of out unseen, because gating the first email to a stranger and then sending the rest unread is not what an approval is for. Deliberately NOT "any outbound row on the thread": the coworker's own replies are outbound too, so that rule would have stopped it after its FIRST reply on a conversation it owns and quietly broken the multi-turn budget the surface is built around. The flow still runs on those messages, so they are classified, filed and put in front of Brian; only the SILENT send is stopped. **The approval gate is no longer cooled down**, which is a reversal: it carried the 12h thread cooldown while it was an alert, but it is now the approval, and with the coworker out of the way a cooled gate meant a genuine follow-up was classified, filed and answered by nobody. The #1191 duplicate it guarded against is covered better by the drafter returning NO_REPLY on a message with no new ask, and the fallback `notify_owner` keeps its cooldown so owner paging stays deduped. Replying to the gate with free text ("shorter, drop the second paragraph") rewinds to the drafter and asks again. Support and billing stay alert-only by design, the deliberate first rollout. A draft that comes back NO_REPLY falls back to the plain alert, so a real lead never resolves to silence. The drafter is also told WHO IS ON the email (`To`/`Cc` are templated into its input) and will not write at someone who is not: on Aug 6 2026 James referred a client named Bobby without adding him, and the draft opened "Bobby, please reach out" to an email only James received. An address counts for a person only when it visibly carries their name, so a generic address is never assumed to be the prospect; a blank `To` line means unknown, not absent, and the reply speaks to the prospect as before. **Automated mail is split into FOUR tiers by consequence**, not by sender: `automated_important` (it asks us to do, verify, approve or respond to something, or reports an outage, security alert, suspension or broken integration) texts Brian and is left in the inbox on purpose; `automated_review` (a platform outcome that is DONE and needs no reply: our app review approved or published, a marketplace listing live, OAuth or domain verified, a rate change on a service we run on) is **silent** and labelled `HQ/Automated/Review`; `automated_notice` (routine, asks nothing) is labelled `HQ/Automated` and left exactly where it was; `automated_bulk` (marketing, newsletters, promotions) is labelled `HQ/Automated` and **left in place too, since Aug 21 2026**. It was the one tier that moved mail to the Gmail bin, until an intro from TAC Security's Customer Success manager (a vendor we actively pay for the CASA scan, asking for a call) classified `automated_bulk`, scored 3/10, and vanished 61 seconds after arriving: the bin hides a message from the inbox, from label views and from default search at once, so a misclassification there removed mail from every surface Brian reads. All `trash` is gone from the flow (`tests/oneshot-hq-inbox-triage-definition.test.ts` pins zero `trash` on any step), so a mistake may only ever mislabel, never remove. **The review tier was added Aug 17 2026 after the Zoom miss.** "New Coworker OAuth has been updated and published" classified `automated_notice` and got byte-identical treatment to a Slack "Find and join channels" digest, because those were the only two options: text him, or make it look like wallpaper. Both calls were defensible one at a time, which is the tell that the TIER was missing rather than the classifier being wrong. The signal built for exactly this case could not fire: mail continuing a conversation we are in is never routine, but `thread_has_our_reply` only knows about EMAIL, and that update was submitted through the Zoom Marketplace portal, so the Gmail thread had no history at all. The new category description carries the knowledge that signal could not, naming the platforms so the classifier matches on sender and content without needing a thread. Silent is the point of the rung, and it uses a nested label rather than a star because every starred message in this mailbox is a payment receipt and that signal stays single-meaning. Hosting renewals stay `automated_notice` (a test pins it), since the review tier is their nearest neighbour and the most likely thing to swallow the carve-out. **The review tier's wording was tightened to "DONE and needs no reply" on Aug 18 2026**, after the nightly live suite caught the neighbour on the OTHER side. The first wording named the platforms and stopped there, so it read as "any mail about a review", and "Your app submission needs changes / Respond with an updated build to continue" classified `automated_review` and went silent, at the exact moment the ChatGPT app and Meta App Review were both in flight. A rejection is a review outcome AND an ask, and the ask wins: an outcome that still wants something from us is `automated_important`, the tier that texts, whatever it is about. Both sides of that line now have a live e2e case (rejection texts, an approval and the Zoom publication notice stay silent), because guarding only the neighbour below is how this got shipped in the first place. That gap survived PR #1433's own CI: the Admin "CI live e2e" toggle reads nightly-only, so no PR run classifies anything against the real model, and the nightly is the first thing that does. **Every filed message also gets a display-only 1-10 importance score** (`importanceTemplate` off the anchored `email_importance` extract field), which sorts Dashboard -> Emails and is read by nothing else: a test asserts no gate anywhere reads it, because a model's number is steady enough to rank a list and not to decide whether to page anyone. **The flow never marks a message read, or unread, in any tier** (Brian's rule, Aug 17 2026). Three `email_organize` steps used to carry `markRead: true`, so mail that had never been in front of a human arrived already read: a Zoom Marketplace notice that our OAuth update was approved and published, and a Telnyx notice that Global Voice Conversational rates change on Aug 20, both landed that way the same morning, and the read mark is what hid them. Labels already solve the pile-up that `markRead` was clearing, and they solve it without the flow lying about what a human has looked at. `markUnread` went with them, from the other direction: with nothing marking mail read, forcing `automated_important` back to unread could only ever undo a human who read it in the minute before the poll. Read state belongs to the reader. The OTHER path that can mark a triggering email read is the poller (`markGmailMessageHandled`), and it does not reach this flow: it fires only for an UNCONDITIONAL `send_email` on the trunk, and both sends here sit inside the `b_sales` arm behind a `when`, which a test now pins. Nothing archives either. The middle tier exists because the two-tier version was destructive on every mistake: on Aug 9 2026 an email titled "[Action Needed] OAuth Verification Request Acknowledgement", on a thread Brian had already replied to, was read as routine and binned. A classifier is sometimes wrong, so uncertain mail is now merely read and labelled, staying exactly where it was. That email had a second tell nobody could use at the time, and it is now wired in: **`{{trigger.thread_has_our_reply}}`** says whether this business has already SENT on the conversation, and `emailTriggerScope` appends a marker to `windowText` so the classifier actually sees it (`classify` reads windowText and its `question` is not templated, so that is the only path in). Mail continuing a conversation we are in is never routine and never bulk, and unlike a phrase match that holds however the sender words the subject. While the bin move existed (through Aug 21 2026) it labelled first, so anything binned in that era stays findable with `label:HQ/Automated in:trash` for the 30 days Gmail keeps it, and there is still no hard delete anywhere in the engine. The bulk category originally matched and then did nothing, so unsubscribable Zapier mail accumulated unread; the label plus the importance score is now the whole treatment again, and the pile-up is answered by sorting, not by removal. **The flow never answers its own mail.** On Aug 7 2026 the sales arm replied-all, which cc'd `team@newcoworker.com`; the Cloudflare catch-all forwards that into the connected mailbox, so the reply arrived as genuinely received mail and the flow drafted a fresh answer six times over. `provider_account_email` is `newcoworkerteam@gmail.com`, so the old self-check never matched the alias. Two guards now: the Gmail poll query carries `-from:me` (the provider's own alias list, which is the set we cannot enumerate) and the poller drops any sender on the tenant email domain, logging `ai_flow_email_poll_self_sent_skipped`. The reply-all cc also excludes that domain, so the copy is never generated in the first place. **Hosting renewal and expiry notices are routine on purpose**: `src/lib/vps/billing-posture.ts` is the system of record for fleet renewals (it auto-heals auto-renew for boxes a paying tenant depends on and honours a `never_renew` flag for boxes that must lapse by design), and the classifier cannot tell a box we are about to lose from one we chose to let go. On Aug 6 2026 Hostinger mailed that the KVM 2 plan on srv1800985 had expired and the flow texted a billing alert; that was the retired residency-pilot box, so lapsing was the plan. A declined card, a dispute or an invoice we owe is still `billing`, since no cron owns those. **It recurred on Aug 20 2026 and the one-line exclusion on `billing` was not enough** (shipped by re-running `setup-hq-inbox-triage-flow.ts --apply`): "Your KVM 8 srv1632631.hstgr.cloud has been canceled as we have not received payment for the renewal" texted a billing alert about the KVM 8 pooled under the kvm2 label, flagged `never_renew` in July so it WOULD lapse and already `retired` in `vps_inventory`, at $73.99/mo. That wording beats the guard because it matches the other paging tiers on their own terms: `billing` names "a failed or declined payment" and "we have not received payment" IS that sentence, while `automated_notice` opened with "asks nothing of us" and the mail asks twice ("View restore options", "please reply to this email"), disqualifying the very tier it belonged in. Replaying the old wording against five framings of that one email showed it was not simply wrong but UNSTABLE, with the framing deciding the answer: the production `windowText` verbatim gave `billing` 5/5, a condensed retelling gave `automated_important` 5/5, and redacting only the 1.5KB of per-recipient tracking tokens gave `automated_notice` 5/5. So all THREE paging tiers were closed, not just the one that happened to win, because excluding one moves the false alarm to its neighbour; the new wording answers `automated_notice` on all five framings, 25 draws. Category descriptions are capped at 200 characters by the authoring validator and all three now sit within a few characters of it, so room for a new clause has to be bought by removing words |
| Contact form triage (webhook, 2) | on | Feeds the admin-designated sink business (PR #773) |
| Meta lead follow-up (webhook, 4) | on | |
| Lead intake & follow-up (Privyr) (TEST COPY of Truly) | on | The AiFlow e2e harness fixture, laid down by `debug/flow-test-setup.ts` |
| Google review demo reply (email, 2) | off | Reviewer-facing demo |
| New Contact Greeting (contact_created, 1) | off | |
| Prospect outreach follow-through (webhook, 3) | on | Files and tags the businesses our outbound outreach emails (PR #972). Installed disabled, enabled by Brian once the notify step was gone; the pitch itself is sent in code, not by this flow, and the per-prospect owner text was removed (it would have been 12 texts a day announcing that strangers got email) |

## Booking

The public page is `/book/newcoworker` (token `ncb_df13…`), linked from both
follow-up flows. Calendar and Gmail are `newcoworkerteam@gmail.com` via
FIRST-PARTY Google OAuth since 2026-08-13, not Nango: connection row
`16cff2b9-b4d3-421c-b25d-b40edd80c9a8` is `transport = direct` and we hold the
tokens. The row ID did not change, which is what kept the 12 references to it
across "Team inbox triage (HQ)" and "Google review demo reply (HQ)" working;
`metadata.shared_calendar_id` still points at the app-created "NewCoworker"
calendar. All seven frozen scopes are granted. **There is no rollback path any
more:** the `google` integration was deleted from Nango on 2026-08-13, which took
its connections with it (irreversibly, per Nango's own warning), so the
superseded grant `1b7f7c19-...d03278` no longer exists. The now-dangling
`metadata.migrated_from_nango_connection_id` was cleared the same day and
`nango_rollback_revoked_at` records it; leaving the key would have told
`debug/nango-audit.ts` to protect a seat that is already gone, and told a reader
a rollback was available when it is not. Reverting this tenant to Nango would now
mean a fresh owner consent. Zoom is `team@newcoworker.com`.

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

**Discovery-call doc pricing corrected (2026-08-24):**
`fix-hq-discovery-doc-pricing.ts --apply` replaced the garbled pricing bullet
in the "Kingsley Moyo + New Coworker: Discovery Call" transcript document
(the Zoom import's AI summary claimed "$999/month" and "$9.99/mo"). HQ
documents are coworker-readable knowledge and Kingsley texts the HQ line, so
the wrong numbers were quotable. Transcript body untouched.


**Trash removed from inbox triage (2026-08-21):** `s_org_bulk` in
`hq-inbox-triage-definition.ts` no longer carries `trash: true`, and the live
row was refreshed by re-running `setup-hq-inbox-triage-flow.ts --apply`. No
tier moves mail to the Gmail bin any more: bulk mail is labelled
`HQ/Automated`, scored, and left in the inbox, the same treatment as
`automated_notice`. Prompted by the TAC Security Customer Success intro of
Aug 21 (classified `automated_bulk`, importance 3/10, binned 61 seconds after
arrival); the trade-off is accepted knowingly, bulk mail now accumulates in
the inbox under its label instead of disappearing.

**Em dash sweep (2026-08-18):** `strip-em-dashes-flows.ts --apply` cleaned the
live `ai_flows` copy for this tenant, closing the last gap left by the repo-wide
sweep in PRs #1474 and #1475. 2 flows, 3 copy fields: the contact-form triage alert, and the Meta lead follow-up (both its customer-facing SMS and the owner alert). Both were `enabled=true`, so this changed copy that is actively sending. Flow NAMES are untouched
by design: they are the lookup keys the one-shots resolve rows by. Re-running
the script now reports "No em dashes in any flow's copy fields".


**Voice infra (Aug 2026):** `migrate-tenants-to-dedicated-telnyx-apps.ts` moves
this tenant off the shared Telnyx Call Control app/profile onto a DEDICATED
app + outbound voice profile (both named with the searchable marker
`[nc:<business id>]`): carrier-enforced concurrent-call cap equal to the plan
tier, a per-tenant $25/day spend fuse, the full destination whitelist, and the
DID re-pointed onto the tenant app. Idempotent (re-runs adopt by marker).
Whether it has run is in the applied_oneshots ledger.

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
