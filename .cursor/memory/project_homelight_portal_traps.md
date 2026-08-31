---
name: homelight-portal-traps
description: HomeLight portal automation traps and fixes: email-first login, claim flows, unclaimed email ladder, dashboard skeletons
metadata:
  type: project
---

## homelight-email-first-login

**HomeLight is NOT passwordless.** Its login is two-step:

1. `homelight.com/client/sign-in` takes only the email -> **Continue**
2. `homelight.com/users/login?email=<addr>` carries email + **password** -> Sign In
3. lands on `agent.homelight.com/dashboard`

Do not be misled by `homelight.com/users/sign_in`: it redirects to a
SALES-side page (`sales.homelight.com/users/login`) with only an email box.
That redirect is what made this look passwordless.

**Why it mattered:** `looksLikeLogin` in `vps/aiflow-render/login.mjs` required
a password AND a username field on the SAME page, so neither HomeLight page
qualified and **no login was ever attempted**. Every HomeLight browse step
worked only because the `hmlt.co` referral link self-authenticates. Once a link
expired, the step landed on `/client/sign-in` or the logged-out `/referrals`
funnel and **returned that page as a successful read**: no `login_failed`, no
`auth_config_error`. A marketing page fed straight into extraction.

**How to apply:**
- Fixed 2026-08-18: `login.mjs` gained `ADVANCE_SELECTORS`, `EMAIL_FIRST_SELECTORS`,
  `looksLikeLoginPage` and `waitForPasswordField`. `performLogin` fills the
  email, blurs, clicks the advance control, waits for the password step, and
  reports `steps: 2` plus `selectors.advance` in diagnostics.
- "Continue" is in ADVANCE_SELECTORS and deliberately still OUT of
  SUBMIT_SELECTORS: the advance list is only consulted when there is no password
  field, so it cannot steal a click from a validation-disabled real submit.
- The agent dashboard `agent.homelight.com/dashboard` carries a real stage
  control ("Update Referral Stage", "Last Update: <stage>") and "Submit
  Feedback". HomeLight DOES have a factual status surface. See
  [[project_homelight_claim_click_silent_noop]].
- General lesson: a browse step that returns a page is not a browse step that
  returned THE page. Same family as [[feedback_verify_the_column_is_written]].

## project-homelight-own-claim-read-as-rival

HomeLight's referral page renders a single flat `Claimed By: <name>` row
whether the claimer is this team or a different brokerage. The `already_claimed`
extraction asked whether it was "claimed by ANOTHER agent", which gave the model
no way to tell the two apart.

On Kevin Duford's run (`85d1bd1f`, Aug 11 2026) the card read
`Claimed By: Amy Laidlaw` (OUR claim), the model answered `yes`, the flow took
the we-lost-it path, and **39 of 61 steps were skipped**: `save_contact`,
`to_agent`, `qt_email`, `lead_sms`, `lead_email` and `notify` all never ran.
That is the whole of Amy's "it broadcasts the lead but we never have the contact
information or the price".

Fixed Aug 12 2026 by `homelight-contact-reveal.ts`: the question now names the
team, and names the TEAM rather than four individuals, because a roster list in
a prompt goes stale the moment someone joins.

**The wider lesson, which cost four Bugbot rounds on one PR.** This flow has 25+
top-level steps where conditions routinely do double duty:

- `contact_status` looks like an email result and is ALSO the late-retry
  ladder's claim gate (it is only a claim gate because `email_card` was gated).
- `already_claimed` looks like a portal fact and is ALSO the switch for six
  delivery steps.

Before changing any gate here, map what else reads it. And copy the SEMANTICS of
the neighbouring ladder, not just its shape: per-read status vars,
gate-while-missing so it delivers the moment details land, and stop-on-reached.
Every one of those was already solved in the claimed path.

Other HomeLight facts worth keeping: contact details are revealed ONLY after a
successful live transfer or a connected call, so a seller who hangs up first
means none are ever coming; the reveal email is delayed, so reads must retry;
nothing can screenshot an email (`attachScreenshot` is a BROWSE screenshot);
and definitions cap TOP-LEVEL steps at 30, which this flow is near.

See [[project-call-window-skip-not-placed-trap]] for the other silent-no-op trap
on this account.

## homelight-claim-click-silent-noop

Aug 16 2026, Amy's account: two HomeLight referrals (runs 58034590 Ana 16:09Z,
def440a9 Thomas 16:29Z). Both `claim_click` steps resolved the real
`data-test="submit-claim-referral"` button (saved step-2.html proves the markup),
Playwright clicked it (actionsCompleted 1, no render-service log events, no
overlay, no failure), and Telnyx CDRs show ZERO inbound calls to the DID until
Amy clicked the same button by hand at 16:40, which produced the +14159851909
callback within seconds. A clean Playwright click on a Next.js portal can be
swallowed client-side (handler not attached yet, or a silent XHR failure);
`actionsCompleted` only proves the click was dispatched.

**Why:** browse_action has no post-click state verification, so "clicked" and
"claimed" are conflated, and the offer copy asserted "Our AI coworker is
claiming it with HomeLight now" on faith.

**How to apply:** never trust a bare click on a consequential portal action.
Verify the page's post-action state with a follow-up extract (HomeLight call
claim shows "Pick up now to claim this lead" / "We're calling you at" /
"Call me again"), retry the click on a fresh navigation when still open, and
alert a human when unconfirmed. The voice side works: the enabled voice flow
(trigger fromE164 +14159851909) answered, was briefed, pressed 1 on prompt,
HomeLight said "Connecting you now".

**SHIPPED Aug 16 2026:** PR #1400 (`homelight-verified-claim.ts`, applied to
the live flow the same day: claim_verify + claim_fix retry branch, offer
templates "Claim status: {{vars.claim_state}}", reveal-ladder regate to
notEquals "found", 240-min lookbacks); PR #1401 (`browse_action.expectText`
postcondition + `email_extract.noMatchVars`, render service redeployed
fleet-wide); PR #1402 (inbound intake voicemail recognition + one scripted
message, voice-bridge redeployed fleet-wide). Related:
[[voice-flows-leave-no-run-rows]], [[homelight-unclaimed-email-ladder-inert]].

## homelight-unclaimed-email-ladder-inert

`email_extract` returns `{kind:"ok", result:{found:false}}` and writes zero
vars when no mailbox message matches (ai-flow-worker/index.ts ~3588, "backfill
nothing and let the run continue"). The Aug 12 2026 HomeLight contact-reveal
ladder (`homelight-contact-reveal.ts`) gates its retry rungs on
`u1_status equals "missing"` / `u2_status equals "missing"`, but those vars are
only written when an email WAS found; on the common first-read-too-early case
the whole 15/60-minute retry ladder is when_unmet-skipped silently. Seen live
on both Aug 16 runs (step result `{"found":false}`, no u vars, steps 63-69 all
skipped). Also: the reads carry `lookbackMinutes: 60`, and the unclaimed read
runs ~70-105 min after arrival (after the offer ladder), so the window can
exclude the referral email entirely.

**Why:** a gate keyed on a var that the producing step only writes on success
is the assert-the-producer trap again: the "missing" answer was assumed to come
from the model, but a no-match never calls the model.

**How to apply:** gate email-retry rungs on `<status> notEquals "found"`
(unset passes, which is the desired retry) instead of `equals "missing"`, or
give email_extract explicit no-match defaults (engine support shipped as
`noMatchVars`). Check lookbackMinutes against the real delay budget of the
steps before the read. Do NOT tighten HomeLight matchTemplates with
`{{vars.price_digits}}`: the SMS alert's price is ROUNDED ($420K -> 420)
while the details email carries the exact figure ($419,500), so the AND term
excludes the very email being sought (Bugbot caught this on PR #1400);
first-name-only at 240 min is the shipped precedent. Related:
[[homelight-claim-click-silent-noop]].

## homelight-agent-dashboard-skeletons

`agent.homelight.com/referrals` is now FULLY writable headless through Amy's
render sidecar (verified 2026-08-19: populated list, hydrated drawer, stage
dropdown opens, Add Note editor reachable).

**What the long "skeletons forever" saga turned out to be.** The drawer's data
comes from `hapi.homelight.com` REST calls authed by the `hapi_user_production`
cookie (NOT the NextAuth session cookie that renders the page shell). A stale
or fingerprint-flagged login never obtained it, so every hapi call 401'd: full
page, empty drawer, "0 referral matches". Fixed by the fingerprint stack
(derived UA #1511, client hints #1513, AutomationControlled #1515) plus the
post-login wait (`waitForLoginToResolve`, PR #1524: server.mjs used to
re-navigate while the submitted login was still in flight, because
`waitForLoadState("networkidle")` is a no-op on an already-loaded page). The
same #1524 fix unblocked Clever's credential login through the service path.

**Noise that is NOT a defect** (identical in a healthy real browser): 404 on
`_ssgManifest.js`, `/_next/data/*.json` answered `text/html`, two
`Unexpected token '<'` page errors. Never diagnose from these.

**The write surface** (all read live headless, in `docs/tenants/homelight-flow.md`):
click the client's name on `/referrals` (rows are `<a>` with NO href, so
forEachLink cannot reach them and direct `?referralId=` does not open the
drawer) -> drawer with inline Stage combobox
`[data-test="referralDetailsModal-stageUpdateOptions"]` (SCOPE it: the list's
team filter reuses `select-selected-item`) and Add Note
(`referral-detail-modal-add-note-button` -> `referral-add-note-textarea` +
`referral-add-note-btn`). Stage dropdown is forward-only and contextual.

**What shipped (plan Phase 4b, PR #1527 + amy-homelight-portal-note.ts):** a
NOTE with `{{vars.actions_taken}}`, deliberately not a stage write:
`hl_call_outcome` proves our line answered HomeLight's claim call, not that
the client was reached, and HomeLight's own AI already maintains stages. The
row click is `click_text "{{vars.lead_name}}"`: browse_action TARGETS render
{{vars.*}} at plan time since #1527 (braced targets only; literal targets
byte-identical). Do NOT fill the list's search box and click the first row:
the click races the SPA re-render onto the wrong referral (observed live).

**Traps that stay true:**
- Terminal stages (`Failed`, `Closed`) have no editor in ANY browser. Test on
  Thomas Larkin (lead 15314809, Left Voicemail) or Jose King (Listing), never
  Anastasios C.
- Two drawers can be mounted at once (duplicated "Add Note" is the tell);
  close before reading.
- The drawer mounts async: always probe with `--expect` (e.g. "Add Note").

See [[project_homelight_claim_click_silent_noop]] for the never-guess-selectors
rule this account keeps re-learning.

## homelight-three-price-channels

HomeLight states a referral's price on THREE channels and they are not one
number. Measured 2026-08-28 over every live transfer on Amy's account:

| channel | figure | where it lands |
| --- | --- | --- |
| SMS alert | rounded to the nearest $1K ("$379K") | `{{vars.price}}`, `price_digits`, `price_band` |
| details email | exact ("$379,000") | `{{vars.email_price}}` |
| IVR announcement | exact, read aloud on the transfer | transcript only, nothing parses it |

SMS = round(email) held on all five pairs where both existed ($468K/$468,000,
$507K/$507,000, $515K/$514,600, $644K/$643,800, $379K/$379,000), which is the
same relationship [[project_homelight_portal_traps]] already records for
matchTemplates.

**The new fact: the IVR can disagree with both.** Six transfers had both an
SMS and a spoken figure. Five matched ($800K/$800,000, $464K/$463,559,
$560K/$560,000, $515K/$514,600, $420K/$419,500). One did not: Rhonda J.,
85205, 2026-08-28, where the text and the email both said $379,000 and the
robot said **$437,900**. So when they differ, the WRITTEN pair is corroborated
twice and the announcement is the lone outlier. Do not assume the text is the
stale one.

**How to apply:**
- `price_band` (the $1M owner-direct gate in the `route` step) is computed from
  the ROUNDED SMS figure. If HomeLight under-reports, a genuine $1M+ lead gets
  offered to the team instead of held for Amy. Closest observed: $976K and
  $910K, no miss yet.
- The live-transfer flow sets `briefFromSmsContaining: "New HomeLight"`, so the
  AI is handed the raw alert text with the rounded figure and NOTHING labelling
  it as HomeLight's record rather than our valuation. See
  [[project_ai_invents_callback_numbers_on_voicemail]] for why an unlabelled
  figure in a brief is dangerous, and `invented_amount` in
  `supabase/functions/_shared/call_integrity.ts` for the detector.
- Three different 85205 sellers (Kim Aug 5, Nancy Aug 24, Rhonda Aug 28) all
  came through at $379K. Only Rhonda's email was captured, so whether that is a
  zip-level default is UNPROVEN; do not repeat it as fact.
