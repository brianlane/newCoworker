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
- **This flow is live on a real account earning real commissions.** Changes go
  out as ledger-recorded one-shots (`homelight-*` in `scripts/oneshot/`),
  dry-run first, and Amy is told what changed.

## One-shots

Seeds: `seed-homelight-lead-aiflow.ts`,
`seed-homelight-ai-call-voice-flow.ts`, `seed-homelight-voice-handoff.ts`.

Patches: `homelight-accept-on-prompt.ts`, `homelight-accept-fallback-20.ts`,
`homelight-call-end-details.ts`,
`homelight-late-contact-retry.ts`, `homelight-broadcast-offer.ts`,
`homelight-ai-call-referral-patch.ts`, `homelight-warm-transfer-trigger.ts`,
`homelight-start-immediately.ts`, `set-homelight-star-alerts.ts`,
`fix-homelight-extraction.ts`.

All are idempotent and dry-run by default. Read the one you are about to
re-run: several supersede each other.

## History

PRs #790, #911, #913, #920, #927, #932, #936, #986, #990.
