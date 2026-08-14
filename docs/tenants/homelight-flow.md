# HomeLight referral flow (inside Amy's account)

Not a tenant: a lead source inside
[Amy Laidlaw Real Estate](amy-laidlaw-real-estate.md)
(`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`). It gets its own file because it is
the most intricate single lead path in the fleet, it changed five times in two
weeks, and every change starts by re-deriving how the pieces fit.

## What HomeLight actually does

HomeLight does not send a lead record. It **places a phone call** to a live
transfer line and reads the referral out loud, then asks the answerer to press
a key to accept it. Everything downstream follows from that:

- a human has to be on a call within seconds, or the referral goes to another
  agent,
- the referral details exist only as speech, so they have to be extracted from
  a live conversation,
- the accept is a DTMF keypress on a timer, not a click.

## The pieces

| Piece | What it is |
| --- | --- |
| HomeLight Live Transfer (voice flow, 3 steps) | The AI answers the HomeLight call itself rather than ringing a human first (`answerFirst`), and is briefed from the portal so it can speak to the referral knowledgeably (PR #927) |
| Accept-key press | When the recording asks for a keypress, the AI presses it (PRs #932, #936). This is the step that converts a referral into Amy's referral |
| Star-framed alerts | Live-transfer texts to the team are wrapped in a `*` block (`options.starAlerts`) so Amy can see at a glance that a live transfer is happening rather than reading a wall of text (PR #911) |
| Broadcast route_to_team | The offer goes to Amy and Dave simultaneously instead of round-robin, because a HomeLight referral does not wait (PR #790) |
| HomeLight Referral (sms flow, 24 steps) | Everything after the call: extraction, claim, follow-up |
| Late contact details | The seller's contact details often arrive after the call ends, so they are fetched and delivered to whoever claimed the referral (PRs #913, #932) |

## Sharp edges

- **Latency is the product here.** A change that adds a wait step or an extra
  model call before the accept keypress can lose the referral outright. Treat
  the accept path as a real-time path.
- **Extraction runs against speech, not a form.** Model-invented values are a
  live risk; phone fields are validated so a hallucinated `+` prefix becomes
  none rather than a bad number (PR #885). `fix-homelight-extraction.ts` exists
  because extraction drifted once already.
- **The details can arrive after the call ends.** Do not assume the call-end
  event is the end of the referral (`homelight-call-end-details.ts`,
  `homelight-late-contact-retry.ts`).
- **A step that dies takes the retry ladder with it.** The late-contact rungs
  are trunk steps AFTER the post-claim sends, so anything that hard-fails
  earlier in the run silently cancels roughly 2h15m of patient retrying. That
  is exactly what happened on Jul 31 2026 (run `abcada1d`): `lead_email` failed
  on an empty `{{vars.lead_email}}` at step 21 of 60, and rungs 1 and 2 plus the
  owner wrap-up never ran. PR #1051 made a templated empty recipient SKIP, and
  `tsx debug/flow-run-autopsy.ts <runId>` now prints what a failure skipped.
- **`wait_for_call` only attaches to a call already in progress.** Its
  `withinMinutes` is a lookup filter and `timeoutMinutes` is the ceiling on
  waiting for a LIVE call to end, so the flow's `timeoutMinutes: 45` was inert:
  with no session the step resolved `no_call` in zero seconds.
  `awaitStartMinutes` polls for a call to begin. Keep it small. Every step
  after it waits too, and latency is the product here. It is **6** since
  2026-08-14 (`homelight-claim-status-honesty.ts`), raised from the original 3
  because Kevin's real callback landed at 3.1 minutes and was missed by six
  seconds. Measured callbacks since Jul 1 2026: -0.8, -0.5, 3.1, 19.0 and 137
  minutes, with five referrals getting no call at all. Do not chase the tail:
  half of all referrals never get a callback, so every added minute is paid by
  those runs for nothing, and missing the call is recoverable on its own since
  the late-contact ladder re-reads HomeLight's email.
- **Requesting the claim callback is not the same as claiming, and the copy
  used to say it was.** On Amy C. (2026-08-14, run `5ac0ee1b`) the flow clicked
  "Call me to claim referral", waited its 3 minutes, recorded `no_call`, and
  then texted the teammate "HomeLight lead is yours" and emailed Amy
  "HomeLight referral claimed by Gabrielle Mota". The portal HTML saved that
  same minute still showed the unclicked claim button, and HomeLight's own
  90-minute nudge confirms it considered the referral unanswered. HomeLight
  called at 10:26, 137 minutes after the click.
  The copy now separates the two facts: routing DID assign the lead, so
  "assigned to you" is true, and the claim outcome is templated from
  `{{vars.hl_call_outcome_label}}`, the engine's own phrase ("no call came
  in", "spoke with them"), so it stays right for outcomes added later. The
  teammate SMS also carries the portal link now, which is what makes a
  `no_call` actionable: they can finish the claim by hand.
  This also retired the offer line "Our AI coworker answered HomeLight's call
  and is talking to them now", which was sent before any call existed and was
  always false on the text-claim path.
  Note `wait_for_call` publishes `<saveAs>_label` and `<saveAs>_reason` at run
  time exactly like `place_ai_call`; the authoring validator only registered
  them for the dialing step until PR #1371, so templating the phrase used to
  fail to save.
- **HomeLight alerts arrive in two wordings, from two different sender lines**,
  and the flow has to match both. They open with either
  `New HomeLight Referral: <name> - $250K seller in ...` or
  `New HomeLight Warm Transfer Opportunity: <name> - ...`.
  The trigger matched only the first for weeks, so every warm-transfer
  opportunity was silently ignored, and each was withdrawn seconds later by
  "Sorry, this referral is no longer available for a live transfer" (PR #986).
  Neither alert carries the link: it arrives as its OWN message in the same
  second, which is what `has_url` plus `correlationWindowMinutes` is for. Match
  on `New HomeLight (Referral|Warm Transfer)` and not on a bare
  "HomeLight referral", which also appears in HomeLight's post-call feedback
  text alongside a URL.
- **The warm-transfer window can be shorter than the worker tick.** Withdrawals
  landed 46s, 1m34s and 1m54s after the alert, and once after 3s, while the
  worker claims a run about once a minute. `options.startImmediately` (PR #990,
  `homelight-start-immediately.ts`) makes the inbound webhook kick the worker on
  enqueue so the claim starts within seconds. That removes the QUEUE delay, not
  the work: the claim still needs a credentialed page load, so a single-digit
  window can still close first.
- **HomeLight has TWO claim mechanics, and the newer one has no call.** A
  text-preferred referral opens with a "This client prefers texting" modal and
  says outright "You don't need to call and enter a PIN to accept these types of
  referrals". That page has no call-to-claim button at all: the only actions are
  "Send message" and "Decline referral", and HomeLight's own markup names the
  first one `data-test="submit-claim-referral"`, so sending the message IS the
  claim. HomeLight pre-fills that message in Amy's name, so the flow sends it
  rather than composing one. The flow picks a path with the `claim_mode`
  extraction field (call, text, or none, defaulting to call when the page is
  ambiguous). Applied by `homelight-text-referral-claim.ts`. Before it, the
  first such referral (Aug 5 2026, run `0e9b52d2`) died at `claim_click` with
  "no matching control on the page" and took 57 steps with it, so a Mesa seller
  never reached the team.
  Two follow-on rules: match the claim button on its `data-test`, never its
  visible text, since the text is exactly what changed; and never use its
  `sc-*` classes, which are styled-components build hashes. (The offer line
  that was wrong on this path is gone; see the claim-status edge above.)
- **`route` runs BEFORE anything is known about the lead, which twice bound
  ownership to HomeLight's own alert line.** `route_to_team` is step 5; the
  extraction that produces `lead_phone` is step 6. Contact-ownership routing
  used to ask the run's variable bag "is there a `lead_phone` key yet?", and
  at step 5 the honest answer is no, which is indistinguishable from a
  customer-texts-in flow where the sender genuinely IS the lead. So the
  sender fallback fired and ownership bound to `+1 415-915-7879`
  ("HomeLight Referral"), whose row an earlier claim had already stamped
  with an owner. Every referral from Aug 11 to Aug 14 2026 was
  owner-assigned to one teammate with no team race, 17 leads in all, and it
  surfaced only because someone asked what had happened to one of them
  (Amy C., run `5ac0ee1b`). The 2026-08-10 Danfar fix had closed the
  narrower version of the same hole (extracted-but-EMPTY) but kept asking
  the variable bag, so this ordering walked straight around it.
  The rule now reads the flow DEFINITION (`flowDealsInLeadPhone`), which is
  settled before step 0 and cannot drift with execution order. Two habits
  follow: never assume a var-existence check is safe at a step that runs
  before the var is declared, and run
  `tsx debug/audit-relay-contact-owners.ts` after touching ownership code.
- **This flow is live on a real account earning real commissions.** Changes go
  out as ledger-recorded one-shots (`homelight-*` in `scripts/oneshot/`),
  dry-run first, and Amy is told what changed.

## One-shots

Seeds: `seed-homelight-lead-aiflow.ts`,
`seed-homelight-ai-call-voice-flow.ts`, `seed-homelight-voice-handoff.ts`.

Patches: `homelight-accept-on-prompt.ts`, `homelight-accept-fallback-20.ts`,
`homelight-await-call-start.ts` (superseded by
`homelight-claim-status-honesty.ts`), `homelight-claim-status-honesty.ts`,
`homelight-call-end-details.ts`,
`homelight-late-contact-retry.ts`, `homelight-broadcast-offer.ts`,
`homelight-ai-call-referral-patch.ts`, `homelight-warm-transfer-trigger.ts`,
`homelight-start-immediately.ts`, `set-homelight-star-alerts.ts`,
`fix-homelight-extraction.ts`, `homelight-text-referral-claim.ts`.

All are idempotent and dry-run by default. Read the one you are about to
re-run: several supersede each other.

## History

PRs #790, #911, #913, #920, #927, #932, #936, #986, #990, #1370, #1371.
