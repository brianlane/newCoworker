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
- **A dispatched claim click is not a registered claim.** On 2026-08-16 both
  morning referrals' `claim_click` steps resolved HomeLight's real
  `data-test="submit-claim-referral"` button and reported success
  (`actionsCompleted: 1`), and Telnyx carrier records show HomeLight never
  placed the claim callback for either. Amy's by-hand click at 09:40 produced
  it within seconds; the voice flow answered, pressed 1, and HomeLight said
  "Connecting you now", so the answering side works. A clean Playwright click
  on this Next.js portal can be swallowed client-side (handler not attached
  yet, or a silent request failure). `homelight-verified-claim.ts` therefore
  re-reads the page after the claim steps (`claim_verify`, a FRESH navigation:
  the claim-call state is server-side and survives reloads), retries the click
  once when the state reads NOT CONFIRMED (`claim_fix` branch, call-mode
  only), and templates the offer's claim line from the verified
  `claim_state` instead of asserting "Our AI coworker is claiming it with
  HomeLight now." on faith. When the state stays unconfirmed, the copy IS the
  rescue instruction ("NOT CONFIRMED, claim by hand now") directly above the
  portal link, which turns a silent loss into a one-minute human nudge. The
  retry carries `continueWhenText: "HomeLight"` (present on any portal page)
  so a retry failure records skipped and the run carries on to the offer,
  never dead-letters.
- **`email_extract` writes NO vars on a mailbox no-match, so an
  `equals "missing"` gate never fires.** The Aug 12 reveal ladders gated
  their retry rungs on `u1_status equals "missing"` (unclaimed) and
  `contact_status equals "missing"` (claimed), but those vars exist only when
  an email WAS found and read; when the mailbox has no matching message yet
  (`{found: false}`), the status is unset and the whole 15/60-minute retry
  chain skips silently. Both 2026-08-16 runs show it: step result
  `{"found":false}`, no `u1_status`, every later rung `when_unmet`. The same
  one-shot re-gates those rungs on `notEquals "found"` (an unset status now
  means "keep trying"; "found" still stops the ladder) and widens all six
  HomeLight reads to `lookbackMinutes: 240`, because the unclaimed read runs
  ~75+ minutes after arrival, behind the offer ladder, so a 60-minute window
  could not reach the referral email at all. The matchers stay
  FIRST-NAME-ONLY on purpose: bodyContains terms are AND-ed, and the tempting
  `{{vars.price_digits}}` term comes from the SMS alert's ROUNDED price
  ($420K gives 420) while the details email carries the exact figure
  ($419,500), so it would exclude the very email being sought (Bugbot caught
  this on PR #1400; the model has also produced full runs like 507258, which
  never match a comma-formatted $507,258).
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
- **After the accept keypress, the bridged leg can be a MACHINE.** HomeLight
  connects the accepted call onward to the client's own phone, and on Aug 16
  2026 (Thomas L., 16:40Z) that phone was off: a carrier voice said
  "592030 is not available.", the AI asked it whether it was trying to give a
  phone number, and the client's mailbox recorded four minutes of one-sided
  intake before its time-limit menu ended the call. The inbound intake
  persona now names the carrier signatures verbatim ("is not available",
  "please record your message", "at the tone") and leaves ONE scripted,
  detail-free message, then hangs up (`INBOUND_VOICEMAIL_RECOGNITION_LINE` /
  `inboundVoicemailMessageLine`, `vps/voice-bridge/src/intake.ts`; pinned by
  `tests/voice-bridge-intake.test.ts`). Outbound calls are deliberately
  untouched: their authored `voicemailTemplate` policy already decides what,
  if anything, gets left. Also note HomeLight treats a voicemail pickup as
  NOT connected: Thomas's portal contact stayed "withheld" at 10:42, so a
  claim whose client leg reached voicemail releases nothing.
- **The credential label is `HomeLight`, one word, and the lookup forgives case
  but NOT the space.** `getCustomIntegrationByLabel` matches with `ilike` on the
  trimmed label, so `homelight` is fine and `Home Light` is a different string.
  On Aug 17 2026 the `custom_integrations` row was renamed `Home Light` ->
  `HomeLight` while all ten live browse steps still asked for the old spelling:
  every one resolved to `integration_not_found`, which the render service
  reports as `auth_config_error`, which the worker classifies as PERMANENT. The
  next referral would have died at step 2 (`open`) with no claim, no team
  routing and no lead, and HomeLight reassigns an unanswered referral within
  minutes. Caught before any run fired; closed by
  `amy-homelight-integration-label.ts`, which repoints every step (branch arms
  included: `claim_verify`, `claim_retry` and `claim_verify2` are nested, so a
  trunk-only sweep looks successful and leaves the flow broken). Its pre-flight
  refuses to run unless the target label exists, is active and holds a secret.
  `seed-homelight-lead-aiflow.ts` was defaulted to the same spelling in the same
  PR, since otherwise a re-seed recreates the outage.
- **A `login_failed` from the render service now says why.** It carries
  `finalUrl`, a page-text excerpt, a screenshot and which submit selector was
  found (and whether it was enabled), and the worker copies that detail into the
  run's error. Before Aug 17 2026 it returned a bare code, which is what made
  the Clever login failure that day take a day of reading portal markup by hand.
- **`prompt_ended` does NOT mean Apple call screening.** Flow-placed dials run
  `premium_ios_call_screening_detection`, whose documented sequence fires
  `detection.ended` with `machine` FIRST and only then listens for the
  screening prompt, so the machine verdict is provisional and its ACTIONS wait
  for the resolving greeting event. The trap is what that resolving event
  carries: Telnyx reports `prompt_ended` whenever the prompt following a
  machine verdict ends without a beep, and an ordinary voicemail greeting does
  exactly that. Reading it as "a live person is screening" cancelled a CORRECT
  machine verdict on Jennifer Kline's call (2026-08-17 16:08Z): nothing hung
  up, the assistant pitched into her voicemail for two minutes, and the flow
  recorded "spoke with them". The only proof a person is deciding is an actual
  `call_screening.detected` event; `classifyGreetingEvent`
  (`_shared/voice_amd.ts`) now owns that rule and is where to change it.
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
`fix-homelight-extraction.ts`, `homelight-text-referral-claim.ts`,
`homelight-verified-claim.ts` (claim verify/retry, honest claim-status copy,
reveal-ladder regate, wider mailbox reads; `--revert --apply` restores the
stored previous definition),
`amy-homelight-integration-label.ts` (Aug 17 2026: the credential rename, see
Sharp edges) over the pure builder
`amy-homelight-integration-label-definition.ts`.

All are idempotent and dry-run by default. Read the one you are about to
re-run: several supersede each other.

## History

PRs #790, #911, #913, #920, #927, #932, #936, #986, #990, #1370, #1371,
#1400.

## The agent dashboard, read live 2026-08-18

Reachable now that the render service can do HomeLight's email-first login
(PRs #1462, #1469). `agent.homelight.com/dashboard` returns ~294KB of
authenticated content.

**What is there**

- Action item: "Provide feedback on N of your recent referrals" ->
  `Submit Feedback`
- Per referral: "Any updates for <Name>? ... Last Update: <Stage> (<age>)" ->
  `Update Referral Stage`
- `agent.homelight.com/referrals` lists every referral. Rows carry
  `data-test="referralsList-row"` with `referralsList-rowClientName`,
  `referralsList-rowStage`, `referralsList-rowAssignedTo`,
  `referralsList-rowCreatedAt`, and a per-card `referralsList-card-<agentLeadId>`.

**The stage vocabulary**, from the filter panel's own options
(`referralsList-filterOption-<key>`):

| Label | key |
| --- | --- |
| New | `introduced` |
| Left Voicemail | `agent_left_vm` |
| Connected | `connected` |
| Meeting Scheduled | `meeting_scheduled` |
| Met With Client | `met_in_person` |
| Coming Soon | `coming_soon` |
| Listed | `listing` |
| Making Offer | `making_offer` |
| In Escrow | `in_escrow` |
| Offer Accepted | `offer_accepted` |
| Failed | `failed` |
| Closed | `closed` |

That ordering is what a forward-only stage guard has to respect: never move a
referral backwards, and never off `closed` or `failed`.

**How navigation works, and the trap in it**

Rows are `<a>` elements with **no href**; the SPA navigates on click. Clicking a
client name lands on `agent.homelight.com/referrals/page/1?referralId=<leadId>`
and opens a detail drawer. The `referralId` is the same `lead_id` carried in the
row's "Request cash offer" link.

Navigating DIRECTLY to that `?referralId=` url does NOT open the drawer: it is
client-side state, so the flow has to click. And the drawer mounts
asynchronously, so a read taken right after the click is a race. It appeared in
one probe's control list and was absent from the next probe's markup, from the
identical click. Use the probe's `--expect` flag (added for exactly this) to
hold until the drawer is on the page.

**The stage editor, read live 2026-08-18 in a signed-in browser**

In a REAL browser the panel hydrates fully (zero `--skeleton` nodes) and carries
`Call`, `Email`, `Reassign`, `Hide Activity`, **`Update Stage`** and
**`Add Note`**. Clicking `Update Stage` opens a bottom drawer:

```
.referral-action-drawer.stage-update-drawer
  [data-test="referralDetailsModal-stageUpdateOptions"]   role=listbox
    [data-test="select-selected-item"]                    role=button, text = current stage
    [data-test="select-option-item"]                      one per offered stage
  button "Add Note"
```

**The dropdown is forward-only and contextual, like Clever's.** A referral at
`Listing` offers exactly `Listing`, `In Escrow`, `Failed`. HomeLight enforces
the stage ordering itself, so the forward-only guard this plan plannned to build
is unnecessary: the portal will not offer a backward stage. What a flow must
handle instead is the target stage simply not being on offer.

**WHY the headless render does not get here (diagnosed 2026-08-19).** With page
diagnostics live (PR #1504) the panel finally explains itself:

```
pageErrors (2): Unexpected token '<'
failedRequests (7): net::ERR_ABORTED POST https://www.google-analytics.com/g/collect?...
```

The analytics aborts are noise. `Unexpected token '<'` is the classic signature
of **JavaScript being served HTML instead of a script**: HomeLight lazy-loads
the chunk that renders the stage editor, that request comes back as markup, the
component never mounts, and the two `--skeleton` placeholders stay forever.

Two things that narrows it to. No 4xx/5xx was recorded (the `response` listener
catches those), so the chunk returns **200 with an HTML body**, which is what a
bot-challenge or interstitial looks like rather than a plain 404. And the
analytics payload carries `sr=1280x720`, confirming the headless viewport is a
normal desktop size, so viewport is NOT the cause: a real browser at 817px wide
renders the editor fine.

Remaining suspects, in order: bot protection on whatever serves HomeLight's JS
chunks (our datacenter IP plus a Playwright fingerprint), and the UA override in
`server.mjs`, which claims `Chrome/124.0` while the bundled engine is far newer,
a mismatch that is itself a common detection signal. Next step is to capture the
chunk response body rather than guess between them.

**The UA suspect is now ruled out on its own (2026-08-19, after PR #1511).**
That PR derived the UA version from `browser.version()` so the claimed Chrome
major can never disagree with the engine again, and the fleet was redeployed
the same day. Probing `https://agent.homelight.com/referrals` on Amy's box
AFTER that redeploy still reports the same failure, louder:

```
pageErrors (11): Unexpected token '<' (x8), Request failed with status code 401
failedRequests: HTTP 401 POST https://hapi.homelight.com/api/events-service/user-events/record-user-event
```

So a matching user agent does not get the chunks served as JavaScript. Fixing
the mismatch was still right (it removed a real detection signal and cannot
drift again), but it is NOT sufficient, and the "two suspects" list above is
now a list of one: whatever serves those chunks is refusing this client for
some other reason.

The 401 is a new detail worth keeping: an authenticated XHR to HomeLight's own
events service is being rejected inside a session that is otherwise logged in
(the referrals list itself renders, with its real counts). Whether that shares
a cause with the HTML-for-JS responses is unknown; capturing one chunk response
body is still the next step, and is now the ONLY step that separates the
remaining hypotheses.

**The headless render still does not get here.** Same referral, same click:
the real browser shows zero skeletons and `Update Stage`; the render service
leaves both interactive children as `--skeleton` and `--expect "Update Stage"`
times out. Two hypotheses are now DISPROVEN: it is not referral-specific (a
terminal `Failed` referral has the editor too), and it is not the SSRF guard
aborting `blob:`/`data:` subresources (the live page loads 242 resources, all
https, no service worker, no workers). Still open: viewport (the render service
sets none, so Playwright's default applies) and headless-specific gating.

**Superseded note on where the editor is**

Both routes, clicking a row and clicking the dashboard's `Update Referral
Stage`, open the same panel. Its visible text reads as read-only:

```
<Name> / Role / Property Address / Price / Client timeframe
Date Received / Last Updated / Stage: <value> / [Done]
```

But the markup shows the controls ARE there and simply had not hydrated when
the probe read. Directly below the Stage row:

```html
<div class="... MygTT">
  <div class="... Udsyj"><p>Stage</p><p>Failed</p></div>
  <span class="--skeleton" style="width:100%; height:40px;  margin-top:32px;"></span>
  <span class="--skeleton" style="width:100%; height:200px; margin-top:24px;"></span>
</div>
<button type="button"><span>Done</span></button>
```

A 40px-tall control (the stage picker) and a 200px-tall one (notes or the
activity feed), both still `--skeleton`. The date values above them are wrapped
in `--skeleton` spans too, which is the tell: the panel paints its text first
and swaps in its interactive children afterwards.

So `expectText "Last Updated"` is NOT a sufficient wait: that text is present
while still inside a skeleton. The panel needs a marker that only exists after
hydration before the editor can be read, and until it is read, no
`browse_action` should be authored against it. This account has been bitten
twice by selectors written from a guess
(`debug/update-amy-aiflow-re-update-actions.ts`, and the Aug 16 claim click
that reported success and changed nothing).

Next step: get the skeletons to resolve. Five candidate post-hydration markers
were tried and none appeared within `expectText`'s 10s window ("Add a note",
"Activity Feed", "Select a stage", "Update Stage", "Save"). Since the panel's
own DATE values are skeleton-wrapped too, the likely cause is the panel's data
fetch not completing in the headless session rather than a wrong marker: this
is a waiting problem, not a selector problem. Worth trying next, in order: a
longer settle (`AIFLOW_RENDER_TIMEOUT_MS` on the box), a screenshot via
`--shot` to see what the panel actually looks like once open, and
`--read-network`-style inspection of whether the panel's XHR is being blocked
by the SSRF guard the render service attaches to every page
(`attachSsrfGuard`), which is the one thing in our stack that could stop a
fetch a real browser would allow. Concretely: the guard routes `**/*` through
`safeUrl`, which returns null for any protocol that is not `http:`/`https:`, so
every `blob:` and `data:` subresource is aborted with `blockedbyclient`. A SPA
that boots a web worker from a `blob:` URL, which is a common bundler output,
would lose it silently and could leave exactly this pattern: text painted,
every interactive child stuck as a skeleton. That would affect every SPA portal
we browse, not just this panel, so it is worth confirming before anything is
built on top of it.
