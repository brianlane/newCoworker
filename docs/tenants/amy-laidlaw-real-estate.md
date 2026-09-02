# Amy Laidlaw Real Estate

Our oldest and heaviest tenant, and the one that drives most AiFlow engine
work. If a flow feature exists, Amy probably asked for it first.

## Identity

| | |
| --- | --- |
| Business id | `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3` |
| Tier / box | standard, VPS `1863856` (biennial cutover 2026-07-28 from `1800980`, see Billing). Term box, Hostinger billing sub `6olQFVQi75HF2es2`, expires 2028-07-14 |
| DID | `+16028053377` |
| Owner | Amy Laidlaw |
| Onboarded | 2026-04-29 |
| Roster | Amy Laidlaw, Dave Lane, Jason Lane, Gabrielle Mota |

## How leads arrive

Amy buys leads from referral networks, and each network has its own delivery
mechanic. That is why this account has ~20 flows rather than two: the flows
are not variations on a theme, they are adapters to four different vendors.

- **Clever** sends group texts from a rotating pool of numbers, so a lead is a
  text thread the agent joins rather than a record it receives.
- **HomeLight** calls a live-transfer line and reads a referral out loud,
  expecting a keypress to accept. See [homelight-flow.md](homelight-flow.md).
- **ReferralExchange** and **Realtor.com** deliver leads that then need
  routing to whichever teammate is available.

**Lead state is written by the platform, not by these flows.** Stage tags
(New Lead, Contacted, Engaged, Booked) are applied automatically at the four
lifecycle moments in
`supabase/functions/_shared/pipelines/lifecycle.ts`, and `contacts.lead_source`
is stamped from the filing flow's name, so the Tasks board and its SOURCE
column populate themselves. Do NOT add `update_contact` stage steps to these
flows: the platform already covers it, and a hand-authored stage tag would
fight the forward-only rule. The leads that predate this were backfilled by
`backfill-amy-lead-stages.ts`.

## Flows

Roughly 21 flows, 19 enabled. The ones with behavior worth knowing before you
touch them:

| Flow | Why it is not obvious |
| --- | --- |
| HomeLight Referral (sms, 24 steps) | The biggest flow in the fleet. Own file. |
| HomeLight Live Transfer (voice) | The AI answers and works the call itself (`answerFirst`) |
| Clever Lead - Accept (sms, 13) | Accept path for Clever's group-text leads |
| Clever Lead - Group Reply Intro / Connected | Two-step flows reacting inside a group thread. Clever sends TWO intro wordings; the Intro flow matches both (the second via an extra OR trigger, Aug 2026). Connected is deliberately left unmatched (greet-only decision). An OLD disabled copy of the Intro flow still exists, do not edit that one |
| Clever - Spoke Check & Weekly Call Follow-Up (owner_assigned, 15) | Owner-assigned trigger, not lead-driven |
| Clever Cue Text | Arms an expected-call window so a transfer from a rotating Clever number is recognized (PR #781) |
| ReferralExchange Lead (sms, 31) | Browse-screenshot steps, gated owner emails, gated MMS routing, bad-phone retry tail |
| Realtor.com Lead + Reply forward | Reply forwarding to the lead owner. Routing forks on `lead_type` at `rt_route_gate`: buyers round robin (Dave, Gabby, Jason, one at a time), sellers broadcast to the trio |
| New Lead Intake (manual, 10) | Owner hands the AI a lead by name; the AI calls the lead, speaks their language, and can pin the lead to a named teammate |
| Follow Up Requested (Unclaimed Leads) (tag_changed, 3) | Day-of router for unclaimed leads who asked for a follow-up: adding the "Follow Up Requested" tag (or Run now with context text) races Dave + Gabby (seller/both) or Dave + Gabby + Jason (buyer), 15-min claim window, Amy is the owner fallback and never in the race. Offer SMS carries *asterisk* emphasis by request |
| Voice routing - calls from ... | Five per-source voice-routing flows, keyed to each network's caller IDs |

Read the live state rather than this table when it matters:
`tsx debug/flow-poll.ts 621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`.

## Sharp edges

These are mistakes already made on this account. Do not remake them.

- **An interpreter needs someone to interpret FOR.** Call 5634b7f0 (Aug 18
  2026): an outbound Clever seller call reached an English-speaking lead,
  transferred him live to Dave, and the AI then stayed on the bridged line and
  translated Dave's "Hello. Hello." into "Hola. ¿Hola?". Translator mode
  engaged on the tenant flag alone, with no language known, so the model
  invented a language pair off one mis-transcribed turn ("¿Tú?"). The call died
  in 63 seconds and the flow still recorded it as `transferred`, which resolved
  the goal and ended weeks 3 through 8 of the cadence for that lead. The gate
  that fixes it is in the README's translator section; the lesson for this
  account is that a live transfer's outcome ("transferred") is not evidence the
  conversation went well.

- **A claim reply names a lead, and naming the wrong one used to assign it.**
  Aug 17-24 2026, four times: a teammate replying `"1, <lead name>"` whose name
  matched none of their LIVE offers had that name read as a claim ETA, and the
  reply then claimed their most-recently-touched offer instead. Jason replied
  `"1,Sandy"` at 09:17 on Aug 23, five minutes after Gabrielle took Sandy
  Baldwin, and was silently given the Clever spoke check on Isiah Perez; Amy was
  texted "Jason Lane confirmed they spoke with the Clever lead Isiah Perez ...
  ETA to contact lead: Sandy" the next morning, and the weekly AI call ladder
  was cancelled as handled. Same shape for `"1, Jennifer"` (Lauren Bennett,
  Aug 17), `"1, Michael"` (Kirsten Wade, Aug 22) and `"1, Nancy"` (Linda
  Elenes, Aug 24). Four leads, roughly $1.5M in list price, were marked spoken
  to by conversations that never happened, and nobody was following them up.
  Two causes, both fixed: the router treated an unmatched name as an ETA rather
  than refusing, and HomeLight Referral leads carry only `lead_first_name`,
  which was not a name var the matcher read, so those leads had no label and
  could never be named at all. The reply is now refused and the teammate is
  told who took the lead and what they still have. Restarted by
  `repair-misclaimed-lead-followups.ts`. The lesson for this account: this is
  the roster that routinely holds several simultaneous offers per teammate, so
  every reply-disambiguation bug lands here first.

- **A starred "1" is still a "1".** Aug 29 and Aug 31 2026: Jason replied
  `*1, Logan` twice and `*1, Kimberly` once, copying the reminder's
  `Reply *1, Kimberly*` wrapping. The parser required a leading digit, so
  those landed in the staff coworker, which agreed he could take the lead
  and assigned nobody. Kimberly was assigned by hand (run `003b3a20`,
  2026-09-01). The parser now strips that wrapping; reminder/offer hints
  quote the typed reply like the ask-back that already worked. The staff
  coworker is also forbidden from promising a claim.

- **A claim stamps the CONTACT, so clearing a run does not undo it.** Repairing
  the four runs above meant clearing `routing.claimed_by` and requeuing them,
  which is only half the artifact: the claim had also written
  `contacts.owner_employee_id`, and `route_to_team` hands a lead straight back
  to an existing owner with no claim reply at all ("New lead for a contact you
  already own, so it's yours"). All four re-closed within seconds of being
  reopened and texted Amy the same false confirmation a second time. Anything
  that undoes a claim on this account has to clear the contact ownership FIRST,
  and then requeue. `debug/clear-contact-owner.ts` is the tool;
  `repair-misclaimed-lead-followups.ts` now does it inline.

- **A teammate is never a lead.** Dave and Amy have both been filed as
  customers by flows that texted them. The rule and its guard are in the
  README ("A teammate is never a lead, however the step addressed them");
  `fix-staff-contact-rows.ts` cleaned up the rows that already existed.
- **Never hardcode a teammate name in a flow step.** Rosters change. Use
  `agentNameVar` for a dynamic teammate pin (PRs #876, #877).
- **The group-reply greeting once extracted our own agent's name**, producing
  "Hi Amy" to Amy (PR #856). Any greeting-extraction change needs a group-text
  case in its tests.
- **Clever rewords its intro templates without notice.** A second wording
  ("meet your top-rated local Clever agent") dropped the phrase "Clever Real
  Estate", matched no flow for weeks, and fell to the default assistant: the
  lead got no branded greeting and Amy was paged "needs you to take over"
  with the group-thread label (Jul 31 2026, fixed by
  `patch-clever-group-reply-second-intro.ts`). Anchor Clever triggers on the
  fixed group line plus short stable fragments of the wording, never the full
  brand name. The Connected flow still requires "Clever Real Estate" and so
  currently matches nothing; that is the deliberate greet-only decision, not
  an oversight.
- **HomeLight's feedback number was unowned and fed the general assistant.**
  +1 415-549-1442 sends "Great job connecting with <Name>! You have N referrals
  that are pending your feedback ... https://hmlt.co/<id>". No flow matched it,
  so it reached the default AI, which on Aug 7 2026 answered HomeLight's
  autoresponder, addressed it as "Aaron", and traded 30 messages over 16
  minutes. The Aug 13 nudge drew no reply only because PR #1239's robot-loop cap
  held. Closed Aug 18 2026 by `seed-amy-homelight-feedback-request.ts`: the
  "HomeLight Update Request" flow claims the number, extracts the link, the
  pending count and the named client, texts Amy, and replies to nobody
  (`suppressDefaultReply`). It submits NOTHING to HomeLight. That is deliberate:
  the prompt asks for a subjective REFERRAL QUALITY rating, which shapes the
  referrals she is sent next, so a canned automated answer is worth less than
  her own and could degrade her lead flow. The factual STAGE update on the agent
  dashboard is a different surface, tracked in `docs/tenants/homelight-flow.md`.
- **HomeLight's login is EMAIL-FIRST, and until Aug 18 2026 the render service
  could not see it at all.** `homelight.com/client/sign-in` asks only for the
  email; **Continue** hands off to `homelight.com/users/login?email=<addr>`,
  which carries the password field; signing in lands on
  `agent.homelight.com/dashboard`. `looksLikeLogin` required a password AND a
  username field on the SAME page, so **neither** HomeLight page qualified and
  no login was ever attempted. Every HomeLight browse step therefore worked only
  because the `hmlt.co` referral link authenticates itself, and once a link
  expired the step landed on a logged-out page and **returned it as a successful
  read**: no `login_failed`, no `auth_config_error`, a marketing page fed
  straight into extraction. Fixed in `vps/aiflow-render/login.mjs` (PRs #1462,
  #1469) and **verified live 2026-08-18**: a credentialed probe of
  `agent.homelight.com/dashboard` now returns 294KB of authenticated content.
  Do not confuse `homelight.com/users/sign_in`, which redirects to a SALES-side
  page carrying only an email box, with the agent login above; that redirect is
  what first made this look passwordless.
- **HomeLight's sign-in markup carries almost no attributes**, which is why the
  first fix shipped green and still did nothing:

  ```html
  <form class="email-field-form">
    <input type="text" placeholder="Enter your email" class="email-field-input">
    <a class="button email-submit">Continue</a>
  </form>
  ```

  The email box has no `type=email`, no `name`, no `id` and no `autocomplete`,
  so the placeholder is the only handle on it, and Continue is an **anchor**
  with no `href`, `role` or `type`. The password page's submit is
  `input[type=submit][name=commit]` value "Sign In". Write fixtures from this,
  not from what a login form usually looks like.
- **Probing the sign-in page itself gives a FALSE `login_failed`.** The render
  service judges success by re-navigating to the REQUESTED url and re-checking
  `looksLikeLogin`. Ask for `homelight.com/client/sign-in` and that re-check
  lands on a sign-in form no matter how well the login went. The diagnostics
  told the true story (`steps=2 advance=form a:has-text("Continue")
  passwordStep=true submit=input[type="submit"] enabled=true blurred=true`);
  the verdict did not. Probe a page BEHIND the login, e.g.
  `agent.homelight.com/dashboard`.
- **The HomeLight agent dashboard is `agent.homelight.com/dashboard`**, not
  `homelight.com/referrals` (which is a logged-out signup funnel). It carries
  the two surfaces a status flow needs: "Provide feedback on N of your recent
  referrals" -> **Submit Feedback**, and per-referral
  "Any updates for <Name>?" with a **Update Referral Stage** button and a
  "Last Update: <stage> (<age>)" line. So HomeLight DOES expose a factual stage
  control, contrary to the earlier read of the referral page alone. Both were
  read live on 2026-08-18 through the credentialed probe: "Provide feedback on 2
  of your recent referrals" -> `Submit Feedback`, and "Any updates for Jose
  King? ... Last Update: Listed (a month ago)" -> `Update Referral Stage`.
- **ReferralExchange's timeline status was always "no interaction yet".**
  `re_update` posts to the referral timeline with a fixed status
  ("No interaction yet" -> "I am still trying to contact <First>"), so the same
  run could place an AI call, have it answered or warm-transferred to the team
  minutes earlier, and still tell RE that nobody had been reached. RE sets
  referral quality and volume from these updates. Fixed Aug 17 2026 by
  `amy-referralexchange-update-honesty.ts`, which wraps `re_update` in a
  `re_update_gate` branch: `call_outcome` answered or transferred posts
  "We are in contact" -> "<First> is open to working with me" instead, and the
  `else` path keeps `re_update` unchanged **under its own id** (a parked run
  stores its cursor as a step id and `resolveResumeIndex` stops the run when the
  id is gone). The trunk does not grow, so the 30-step cap is untouched.
  The modal's real option tree, read live Aug 17 2026:
  `No interaction yet` (-> "I am still trying to contact <First>"),
  `We are in contact` (-> "I have an appointment with <First>" /
  "<First> is open to working with me" / "<First> does not want to work with
  me"), `Listing / showing properties`, `Transaction in progress`,
  `No longer working this referral`. A sub-option is REQUIRED: with only the
  parent selected the submit button keeps its `disabled` attribute. Sub-option
  labels embed the lead's first name, so actions match a stable fragment
  ("is open to working with me"), never the whole label. The gate is positive
  (`equals answered` / `equals transferred`) and never `notEquals no_answer`,
  because a call skipped by the calling window resolves to `not_placed`.
- **RE's update modal has a built-in "Schedule text reminder" (step 3)**, and
  it is the only mechanism that can make RE updates recurring, since a
  `schedule` trigger produces no URL and `browse_action.urlVar` takes no
  literal. Its controls, read live Aug 18 2026, are refreshingly plain:
  `#reminder-selector[value="pickADate"]` reveals
  `input[name="reminderDate"]` (native date, `pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"`,
  so `{{now.in7Days.iso}}` fits exactly), plus
  `select[name="reminderHour"]` (1..12, NOT 09),
  `select[name="reminderMinutes"]` (00/15/30/45) and
  `select[name="reminderAmPm"]`. The one-click presets
  `[value="tomorrowMorning"]` / `[value="tomorrowAfternoon"]` are deliberately
  NOT used: they would text Amy about every open referral every day. Applied
  Aug 18 2026 at 9:00 AM seven days out. This is a bootstrap: the reminder text
  RE sends has never been seen, and the recurring flow that consumes it is
  authored only once a real one lands in `sms_inbound_jobs`, because matching on
  guessed vendor copy has cost this account two flows for weeks.
- **Clever sends two different messages from ONE number, and both flows have
  to say which one they want.** +1 314-207-7635 carries the daily "summary of
  the new customers you received today" AND the weekly "N Active Deals awaiting
  update". "Clever Update Leads" was seeded listening to `3142707635`, a
  transposed digit, so the sweep built for the weekly reminder never ran once.
  The reminder therefore fell to "Clever Update Leads (Chris)", which filters
  the card list to the leads NAMED in the message; the weekly text names nobody,
  so `lead_names` extracted to `""`, the loop matched zero rows, and the run
  finished `done`. **Zero of 29 active deals updated, reported green** (Aug 12
  2026; same on Aug 5 with 7 deals). Clever decides how many leads Amy gets from
  exactly this compliance signal. Fixed Aug 17 2026 by
  `amy-clever-weekly-update-sweep.ts`, which repoints the sender AND adds a
  `contains` needle to BOTH flows. Fixing only the sender would have been worse
  than the bug: both flows would then match both messages, and the sweep would
  blanket-update her whole active book daily.
- **A `forEachLink` sweep is capped by Cloudflare per PASS, and the worker
  chains passes until the list is drained (Aug 19 2026).** The loop's single
  HTTP response crosses a tunnel with no `originRequest` block, so it inherits
  Cloudflare's default ~100s 524; at Amy's measured pace (~5s fixed plus ~13s
  per lead) that is about 6 leads, which is where `MAX_FOREACH_ITEMS` sits
  (down from an undeliverable 25 on Aug 17 2026). Covering a bigger backlog is
  the worker's job now: the render service reports what the cap left unvisited
  (`remaining`), and the worker defers the run ~15s and re-enters the SAME
  browse step for the next slice until nothing is owed. Terminal conditions
  are named, never inferred: `list_drained` (clean, or only per-card failures
  left), `no_progress` (a full pass succeeded on nothing, so re-listing would
  hand back the same stuck head forever), `pass_cap`
  (`AIFLOW_MAX_FOREACH_PASSES`, default 20, the runaway valve), and
  `pass_error` (a later pass failed permanently, e.g. the portal magic link
  expired mid-sweep; the run does NOT dead-letter, because the alert behind it
  must still fire). The step then publishes measured totals as
  `update_each_updated` / `update_each_left`, which is what the alert texts
  (see `amy-clever-sweep-measured-alert.ts`). Failed cards stay in the list
  and are retried on later passes; the first pass keeps the old loud
  semantics (all-fail = run failure). A box whose sidecar predates the
  `remaining` field simply never chains: one pass plus a truthful
  measured-numbers alert. On the first real run before chaining (Aug 19
  2026), Clever stated 41 deals, the list rendered 30 (InfiniteList
  lazy-render), one pass attempted 6, landed 2, and the arithmetic alert said
  "about 35 still need you" when the honest count was 39; the lazy-render
  undercount also self-corrects across chained passes because each pass
  re-lists.
- **Clever's status list is FORWARD-ONLY from the card's current stage, so
  "We Spoke" is not on every card.** Read live 2026-08-18 in a signed-in
  browser. A card at "Tried Reaching Out" offers `We Spoke`; a card already at
  "Spoke" does NOT. Full list, in portal order: `No Status Change`, `We Spoke`,
  `We Scheduled A Meeting`, `We Met In-Person`, `We Signed a Listing Agreement`,
  `We Listed the Home For Sale`, `We're Under Contract`, `We Closed`,
  `Released: No Longer Pursuing`. The WEEKLY sweep runs over every active deal
  and most of the 87-card book is past "Spoke", so the sweep as first shipped
  would have failed its second action on the majority of cards, one `failed` at
  a time. Fixed Aug 18 2026 by `amy-clever-sweep-no-status-change.ts`: the sweep
  posts `No Status Change`, which is the first option at every stage AND the
  truthful one for a compliance ping. Choosing it also SHORTENS the action list,
  because the required "Did you schedule a time to meet in person?" select is
  revealed by `We Spoke` and never rendered on this path, so it is removed
  rather than retargeted. The daily (Chris) flow keeps `We Spoke` deliberately:
  it fires the day a lead arrives, when the card is at "New"/"Tried Reaching
  Out" and that option is offered.
- **Clever's magic link is SINGLE-USE, and an expired one renders an empty
  list rather than an error (2026-08-19).** Replaying that day's weekly
  reminder 1.6h later drove the sweep to
  `/interstitial/?magic_uuid=...`, which returned a page whose only heading is
  "Magic link has expired" and whose only link is "Go Back to Login Page". The
  `forEachLink` selector matched zero rows, the render service reported no
  error, and the run closed `done` having posted nothing. The expired page is
  NOT login-shaped (a link, not a form), so the sidecar's credential login
  never triggers on it. Four consequences, all load-bearing:
  1. **Password login through the sidecar WORKS (fixed 2026-08-19).** It had
     failed deterministically for months, and the dossier used to call it
     broken; the credentials were right all along. server.mjs followed
     performLogin with `waitForLoadState("networkidle")`, a NO-OP on a page
     that finished loading before the click, then instantly re-navigated,
     CANCELLING the in-flight auth (Clever hands the
     `agents.listwithclever.com` session to a cross-subdomain redirect from
     `login.listwithclever.com`, which takes seconds). `waitForLoginToResolve`
     (login.mjs) now waits out the submitted login. Navigating the STABLE
     portal URL logged-out redirects to the login form and signs in with the
     stored "Clever" custom-integration credentials.
  2. **A spent-link replay needs `--portal-url`.** `amy-clever-sweep-rerun.ts
     --portal-url "https://agents.listwithclever.com/portal/<id>/active"`
     seeds `vars.portal_url` with the stable URL and starts the run at the
     browse step, riding the credential login instead of the dead link. A
     bare replay still only works while the link is unspent.
  3. **Zero rows is ambiguous, and the ambiguity is dangerous.** "Nothing to
     do" and "we never got in" produce identical numbers. The engine resolves
     it with context: an empty list that CONTRADICTS a previous pass's "still
     owed" count is reported as `lost_list` carrying that leftover, never as a
     clean finish (`decideForEach`).
  4. **The flow alerts on "posted nothing" separately from "left some".**
     A leftovers-only alert is silent exactly when the automation is most
     broken, and the arithmetic alert it replaced was not, so the measured
     alert ships with a `posted_nothing` arm whose `notEquals "no"` condition
     also fires on a missing var. See
     `amy-clever-sweep-measured-alert-definition.ts`.
- **An updated Clever card DOES leave "Needs Action".** Confirmed live
  2026-08-18: `Needs Action (0)` / `Recently Updated (87)`, the second section
  labelled "Items in this list do not need to be updated". That is the
  precondition the chained sweep passes (built Aug 19 2026, see the
  `forEachLink` bullet above) depend on: each pass re-lists and sees only what
  is still owed. Per-lead URLs are
  `/portal/<portalId>/connection/<connectionId>/`.
- **SOME cards' update modals carry a REQUIRED classification select, and a
  fixed action list must treat it as optional (2026-08-19).** The first
  chained sweep (run `5f6b1075`) drained 6 of 34 and stopped at its
  no_progress terminal: six distinct cards timed out clicking "Submit Update"
  on every pass. Probing one with the modal open showed
  `select[id="How would you classify this customer?"]`
  (`Active/progressing` / `On hold/nurture` / `Cold/stagnant`), REQUIRED
  where present, absent on the cards that succeeded. So the sweep answers it
  with `Active/progressing` via a `select_option` carrying `optional: true`
  (browse-action support added the same day: the render service skips an
  optional select whose target is not attached within ~2s,
  `AIFLOW_OPTIONAL_TARGET_PROBE_MS`). "Active/progressing" is the truthful
  value for this list: the sweep only walks `/portal/<id>/active`, and held
  deals live in the On Hold list it never touches. `optional` is deliberately
  select_option-only, in the schema and in the sidecar: a missing select is
  unambiguous, while an "optional" text click would let hydration lag skip
  real buttons. Applied by `amy-clever-sweep-classify-select.ts`. With it, the
  2026-08-19 drain (run `313c6f3a`) posted 28 of 30 across 5 passes at full
  6-per-pass throughput, terminal `list_drained`.
- **A NEVER-updated card has no "No Status Change" to click.** The 2 cards
  that survived the 2026-08-19 drain failed with
  `click_text "No Status Change": no matching control` (connection `581283`
  probed live): the forward-only status list on a card with no prior update
  starts at `I Tried Reaching Out`, there is no status to keep. The sweep
  deliberately does NOT fall back to clicking "I Tried Reaching Out": whether
  outreach happened is a per-card fact the sweep cannot verify, and posting
  it blind is the same overclaim the "We Spoke" fix removed. These cards fail
  per-card, stay listed, and the measured alert hands them to a human by
  count; once a first update lands (a human, or the daily flow on arrival
  day), the card grows "No Status Change" and the weekly sweep owns it from
  then on.
- **A channel policy set with tool toggles reaches only the channel you set
  it on.** `patch-amy-sms-handoff-and-emoji.ts` decided this account nurtures
  and hands off rather than books, and enforced it by disabling the five
  calendar tools for `agent_key = 'sms'` (Jul 29 2026). Voice was never given
  the same rows, and a MISSING `agent_tool_settings` row means "registry
  default", which for the calendar tools is enabled. So the phone coworker went
  on booking for five more days, correctly following this account's own
  voice-side rule in `memory_md` ("Use the team calendar to schedule
  consultations/showings by default") while `soul_md` told SMS the opposite.
  Chris Bartelot's Aug 3 call surfaced it: a listing consultation offered
  fifteen minutes out, pushed four times, then booked. Closed by
  `disable-amy-voice-booking.ts`. When you set a channel policy here, check
  every channel: `tsx debug/audit-agent-tool-channels.ts` lists every tool that
  is off on one surface and still on for another, fleet-wide.

  That audit's first run showed the policy was still only three quarters
  applied: `webchat` and `email` were left default-on, so both could still
  book. Closed by `disable-amy-customer-booking.ts`, which drives off the tool
  registry rather than a hardcoded list, because the channels do not carry the
  same tools (webchat has 2 of the 5, voice 3, sms and email 5). The audit is
  silent for this tenant now.

  `dashboard` is deliberately still ON, and should stay: that surface is Amy
  asking her own assistant, not the AI acting at a customer unsupervised. She
  enabled booking there herself on Jun 14 2026. The audit compares
  customer-facing surfaces only for exactly this reason, so dashboard does not
  keep her on every run; `--include-dashboard` shows it when you want it.
- **A browse step that "fails" may have already succeeded.** On Aug 4 2026 the
  Clever Lead - Accept flow walked the portal's accept wizard to completion, the
  referral WAS accepted (the stored failure page reads "You just accepted your
  204th Clever Referral"), and the run was dead-lettered anyway: the finished
  wizard left its Next button visible but inert, and the render service's click
  loop was probing for VISIBLE while the click it guarded needs ACTIONABLE. 19
  steps never ran, so a $225K seller was accepted on Clever and never reached
  the QT email or Dave. The engine no longer fails a wizard that advanced and
  then went inert, and step 1 now carries `continueWhenText`, which records the
  step skipped and CARRIES ON (unlike `skipWhenText`, which ends the run and is
  the right answer only when another agent owns the lead). That marker also
  makes the accept step idempotent, so the flow is now safe to re-run for a lead
  it already accepted. Applied by `patch-clever-accept-idempotent.ts`.
- **The spoke-check flow was enabled and had NEVER run (fixed Aug 6 2026).**
  "Clever - Spoke Check & Weekly Call Follow-Up" triggers on `owner_assigned`
  with a `contains "clever"` condition, which reads the `tags: …` line of the
  contact-event text. But the route_to_team claim that assigns the owner only
  knew the lead's phone, so the event rendered as three lines (event / phone /
  owner) with no tags line at all, and the condition could never match:
  `ai_flow_runs` held zero rows for the flow while 34 contacts carried the
  exact `Clever` tag. Fixed at the shared chokepoint, not here, so every
  contact-event write site gets the documented shape:
  `enqueueContactEventRuns` now reads the contact's name/email/tags before
  evaluating conditions. The flow definition was correct all along and needed
  no patch. Two HQ flows ("Demo caller follow-up", "Webchat lead follow-up")
  had the same dependency. If you are counting on this flow as the safety net
  that keeps calling unclaimed leads, note it provided none before this date.
  Confirmed working on Aug 10 2026: 7 runs, each carrying the full
  name/phone/email/tags/owner text, reading real addresses off the lead pages
  and sleeping between weekly calls.
- **The spoke check could not reach a lead nobody ever claimed.** Its only
  trigger was `owner_assigned`, which is backwards for a safety net: leads that
  already got human attention also got the AI follow-up, and untouched leads
  got nothing. On Aug 10 2026 that was 14 of 45 Clever-tagged contacts with no
  owner, every one still tagged only "New Lead, Clever" (never advanced to
  Contacted or Engaged), the oldest untouched for 25 days. Closed by
  `patch-clever-spoke-check-unclaimed-leads.ts`, which adds a `tag_changed`
  trigger on the `Clever` tag so a lead enters at ACCEPTANCE and the existing
  3-day `grace` sleep becomes the timer.

  **Do not "fix" this with a `contact_created` trigger**, which is the
  intuitive choice and cannot work: the accept flow creates the contact at
  step 4 (`save_contact`) and only tags it "Clever" at step 5 (`tag_clever`),
  so a contact_created event fires one step BEFORE the tag exists and nothing
  keyed on "clever" can match it. Two details that make the tag_changed
  trigger need no other edit: a tag_changed event has no `owner:` line, so
  `spoke_owner` resolves to "none" and `spoke_check`'s `agentNameVar` pin
  leaves the step UN-pinned (it offers to the roster rotation, which is right
  for an unowned lead); and the `converted` goal already lists
  `{kind: "claimed"}`, so a lead claimed mid-grace jumps to the goal and is
  never called. The same patch sets `options.allowReentry=false`, which is
  load-bearing, not cosmetic: with two triggers a lead that is tagged and then
  claimed matches BOTH and would get two parallel weekly-call chains.
  The patch does NOT backfill: leads already sitting unowned emit no new
  tag_changed event and need a separate deliberate backfill.
- **Editing a live flow by hand in the UI is how flows get broken here.** It
  has needed a revert at least once. Prefer a ledger-recorded one-shot in
  `scripts/oneshot/`, which is idempotent, dry-run by default, and reviewable.
- **Amy's flows are the fleet's stress case for step counts.** The
  definition-wide step cap went 50 -> 150 for this account (PR #634).
- **Never name a gate field so it reads like a phone field.** `phone_lead_type`
  held buyer/seller/both, but `isPhoneFieldName` matches any phone token in a
  name, so when the engine began validating phone fields (PR #885, Jul 24 2026)
  every value became "none". All three ReferralExchange `route_to_team` steps
  skipped for eight days: 11 leads were texted but never offered to the team,
  and Amy's owner alert claimed "no phone" while naming the number just texted.
  The engine no longer rewrites a value that is not a phone attempt, and the
  fields were renamed (`route_lead_type`, `sms_lead_type`). Audit the fleet for
  the same shape with `tsx debug/audit-phone-field-names.ts`.
- **Every team-facing notice carries `Address: {{vars.lead_address}}`, one
  wording, one placement.** Amy asked in Aug 2026 why only some flows texted
  her the property address. There was no single bug: each flow was authored per
  vendor at a different time with no shared lead-summary block, so the address
  existed only where somebody typed it. Closed by
  `set-amy-lead-address-in-notices.ts`. Three things to keep in mind before
  adding or editing a notice here:
  - **`route_to_team`'s offer / fallback / claim templates do NOT collapse
    empty vars** (the worker renders them with plain `renderTemplate`, no
    `collapseEmpty`), so an address that can be ABSENT must be branch-gated,
    never templated unconditionally, or the team gets a bare "Address:" line.
    That is why ReferralExchange's owner recap is now three `when`-gated
    `notify_owner` steps: a buyer is shopping, not selling, and their referral
    page has no Address row at all.
  - **HomeLight publishes only city/ZIP** ("85205, AZ"), before and after the
    claim. Its Address line is coarse by vendor limitation, not by defect. The
    read was moved to the PRE-claim `open` step because `route_to_team` parks
    before the portal card is ever read.
  - **`lead_address` is not just display text**: it feeds the duplicate-lead
    gate (`duplicateLeadRunExists` in `_shared/ai_flows/reentry.ts`), where two
    runs for the same person at DIFFERENT addresses are treated as different
    leads. Only `Realtor.com Lead` sets `options.dedupeLeadRuns`, so nothing
    moved when the other flows gained the field. New Lead Intake is the one to
    watch: Amy is the source there, so its field returns the literal
    `not given` when she omits an address. Do NOT turn on `dedupeLeadRuns` for
    that flow without changing the field first, or "not given" starts acting
    like a property that differs from a real one.
- **Never delete or rename a step id on a live flow.** A parked run stores the
  step id its cursor pointed at, and `resolveResumeIndex`
  (`_shared/ai_flows/branching.ts`) returns null when that id is gone, which
  STOPS the run rather than guessing. This is why the ReferralExchange notify
  split reuses the existing `notify` id for the seller variant and only ADDS
  `notify_both` / `notify_buyer` beside it. The three sit consecutively, so a
  run resuming at `notify` still walks all of them and exactly one gate fires.

- **One HomeLight alert can arrive twice, and each delivery spawns a run.**
  Aug 11 2026: two runs six seconds apart (15:43:54, 15:44:00 UTC) both
  processed referral `hmlt.co/42a2915a` for seller "Marla". Byte-identical
  `windowText`, same sender, different inbound event ids. Both routed to the
  team, both texted Gabrielle Mota, and both parked in a 60-minute
  `wait_for_reply`. Neither existing guard could catch it: the 15-minute
  correlation window gathers text into one window rather than suppressing a
  second run, and sender-keyed re-entry cannot help because HomeLight sends
  every referral from the same number.

  **`options.dedupeLeadRuns` alone is INERT on this flow**, which is the part
  that catches people out. That gate bails when the run has neither phone nor
  email (`keys.length === 0` returns false), and HomeLight's first comm step
  (`route`) runs BEFORE `card` reads the contact details off the portal, so at
  gate time the run knows only a first name, a city, a price, and the referral
  link. Closed by `homelight-dedupe-and-price-digits.ts`, which pairs
  `dedupeLeadRuns` with `options.dedupeLeadRunsByVar: "leadUrl"`: the referral
  link is unique per lead and is extracted at step 0, so it is the only
  identity available in time. A var-key match is deliberately DECISIVE and
  skips the address comparison, because HomeLight publishes only city and ZIP
  before a claim.
- **`price_digits` is a matching token, not display text.** The same alert
  produced `507` in one run and `507258` in the other. It is one of the two
  `EMAIL_MATCH_TEMPLATES` (see `update-dave-routed-aiflows.ts`) used to match
  HomeLight's portal email back to the lead, so a wrong value means the
  late-arriving contact details never reach the flow. The old wording asked for
  "the leading digits ONLY" with $429K and $264,000 as examples, neither of
  which says what to do with $507,258. Reworded by the same one-shot. Note the
  300-character cap on a field description: the first attempt at the new
  wording was rejected by the validator before anything was written.

- **An unowned lead used to reach Amy and stop there (fixed Aug 15 2026).**
  The urgent-alert ladder in `contact_owner_target.ts` had two rungs, contact
  owner and business owner, so a contact with a null `owner_employee_id`
  resolved straight to Amy. A Clever seller texted "I'm available now" on Aug
  14 and "I have not heard anything from anyone" on Aug 15; the AI's
  `notify_team` tool fired correctly both times and both alerts went to Amy
  alone. Dave and Gabby, who cover sellers, were never told. There is now a
  team rung between the two: an unowned contact alerts every teammate carrying
  the lead-type tag, and only an EMPTY eligible set falls to the owner. The
  `notify_team` tool takes an optional `leadType` ("seller"/"buyer") to narrow
  it. A contact that cannot be found at all still goes owner-direct, on
  purpose: without a contact row there is no lead, and broadcasting on a
  lookup miss is noise rather than rescue.

- **Under-$500K gating and the cadence tag are load-bearing TOGETHER.** The
  same lead exposed the other half. The under-500K gate correctly skipped the
  claim offer (`price_gate: "ai"` at $425K), which hands the lead to the Needs
  Follow Up cadence via an `update_contact` tag step. That step is keyed on
  `lead_phone`, and the Clever referral page yielded an empty one, so the run
  logged `skipped a contact-tag update (no usable phone)` and the lead joined
  no cadence either. No team offer by design, no cadence by accident, and the
  only signal was an owner email reading `Clever lead: () none`. Closed the
  same day by `amy-unreachable-lead-team-alert.ts`: all four arrival flows now
  carry a `<prefix>_no_phone_guard` right after the step that extracts the
  lead, and a lead with no usable number reaches the lead-type-tagged team
  instead of vanishing. `amy-unreachable-lead-claim-offer.ts` then made that a
  real claim offer, so "1" takes it.

- **Turning an alert into an OFFER can double-offer a lead.** An alert is
  fire-and-forget, so an extra one is noise; a parked `route_to_team` is not,
  and two live claim windows on one lead means two deadlines, two races, and
  teammates getting contradictory texts. The no-phone guards hit this on
  exactly two flows: Clever's `route` and Realtor.com's `s4` / `s4_buyer` gate
  ONLY on `price_gate notEquals "ai"`, with no phone condition, so a $500K+
  lead with no number would have been offered twice. The no-phone offers there
  now carry the exact complement, `price_gate equals "ai"`, so the two are
  mutually exclusive by construction. ReferralExchange (`route_lead_type`) and
  New Lead Intake (`route_variant`) needed no gate: both vars answer "none"
  without a phone, so their trunk routes already skip, and adding a gate would
  have suppressed the only offer those leads get.

- **An informational team text still gets replied "1".** Gabrielle Mota did it
  57 seconds after the first unclaimed-lead alert landed, and she was not
  confused: every other team text on this account ends in "Reply 1 to claim",
  so "1" is muscle memory. The claim machinery only understands parked offer
  runs, so her "1" resolved against an unrelated older offer (see the
  bare-digit LIFO rule) and the lead she had just been told about stayed
  unowned. The alert/offer distinction is real in the engine and invisible on
  a phone. When adding any team-facing text that is NOT an offer, decide where
  a stray "1" should land before shipping it.

- **There is no way to ask a flow "is this var blank".** `whenSchema` requires
  a non-empty needle on `equals`/`contains`/`notEquals`, so an emptiness test
  is unexpressible. The no-phone guards test `lead_phone contains "+"` instead:
  every number these flows can act on is E.164. A malformed non-E.164 value
  also trips the guard, which errs toward telling a human, the safe direction.
  If you ever need a real emptiness test, note that `evaluateStepCondition`
  already falls back to a presence check when none of the three is set; the
  schema is what forbids that shape.

- **Inserting a step into a live flow is safe; renaming one is not.** A parked
  run stores `__resume_step_id`, not the flat index, and `resolveResumeIndex`
  maps the id back. The four no-phone guards were inserted mid-flow with no
  runs disturbed (none were parked at the time, and any that had been would
  resume by id).

## Owner notification policy (Aug 17 2026)

Amy's rule, in her words: "Notify owner on all appointments booked. Notify
owner when a lead is not claimed with Red exclamation marks. Turn off all
other notifications to owner (notify owner step if lead was routed to a team
member aka owner isn't needed)."

Applied by `scripts/oneshot/amy-owner-notice-policy.ts` across nine flows. It
edits existing steps and appends sibling branch arms only: nothing is deleted
and nothing is reordered, so no parked run changes instruction. Verified
before applying by flattening live vs patched with the engine's own
`flattenSteps`: the two flows that had runs in flight (the cadence with 9, the
Clever spoke check with 8) came out IDENTICAL, and the five flows gaining an
arm append at the end of the flattened order and had zero parked runs anyway.

**Unclaimed notices carry `‼️‼️‼️‼️‼️`.** Every `ownerFallbackTemplate` (29 of
them) plus the three unclaimed notices that are their own step: HomeLight
`notify_unclaimed`, and the two `notify_no_phone` steps (ReferralExchange, New
Lead Intake) where no phone means nobody was ever offered the lead. Same five
characters as `FINAL_REMINDER_BANNER` in
`supabase/functions/_shared/ai_flows/offer_reminders.ts`, and a test pins them
equal so the account never grows a second "urgent" marker.

**Seventeen routed notices are off**, by an unsatisfiable `when` rather than a
deletion. ReferralExchange `notify`/`notify_both`/`notify_buyer`/`bp_forward`;
Realtor.com `s5`/`bp_forward`; HomeLight `notify`/`lost_notify`/`late_notify`/
`late2_notify`/`bp_forward`/`bp_eta_notify`; New Lead Intake `notify`; Clever
Accept `notify`/`bp_forward`; Clever spoke check `wrap_up`; Clever Group Reply
Connected `notify`.

The guard is the var the step already reads, compared against
`owner-notice-disabled-by-amy-2026-08-17`. It borrows an existing var because
`parseAiFlowDefinition` rejects a `when` naming a var no earlier step
produces, so an invented flag cannot be written at all. To switch one back on,
delete its `when` in the builder.

**Still ON**, because each means Amy has to do something: every unclaimed
notice, the two `notify_no_phone` steps, Clever Accept `call_gap_alert` and
`call_fail_alert` (the AI never dialled / the call failed), Clever Update
Leads `capacity_notify`, HomeLight `late2_never_notify` (HomeLight never sent
the contact details, so no outreach happened at all), and every
`notify_lead_owner` step (those address a teammate, not Amy).

**$1M+ leads.** `ownerDirectTemplate` now opens and closes with the same
`‼️‼️‼️‼️‼️` banner instead of a row of asterisks, and the headline is
capitalised to Amy's wording: `HIGH DOLLAR LEAD ($1M+) KEPT FOR YOU, NOT
OFFERED TO THE TEAM.` (the source name survives where the template had one, so
Realtor.com and HomeLight read `HIGH DOLLAR REALTOR.COM LEAD` and `HIGH DOLLAR
HOMELIGHT REFERRAL`).

The three attempts Amy asked for already existed: `ownerDirectNudges` re-sends
in ALL CAPS at 10 and 30 minutes. What did NOT exist was anything afterwards.
Each `*_team_unclaimed` branch carried one arm (`price_under_1m notEquals
"no"`) and an empty `else`, so a $1M+ lead Amy never claimed fell out of the
flow with no follow-up. A `*_tu_high` arm now tags "Needs Follow Up" so the
cadence picks it up. Added to ReferralExchange, Realtor.com, New Lead Intake,
Clever Accept and Follow Up Requested.

**"Unclaimed by owner" is NOT `claimed_agent`, and this is the trap in the
whole feature.** `ownerDirectResume` says it outright: an owner reply "stops
the reminders; claimed_agent stays 'none' throughout (the owner acking is NOT
a teammate claim)". A takeover gated on `claimed_agent == "none"` would
therefore have swept every $1M+ lead Amy DID acknowledge into the AI cadence.
The arm gates on the marker the worker appends to `actions_taken` when the
alert and both reminders all went unanswered ("owner did not acknowledge the
high-value alert after two reminders"), which is exactly Amy's "three attempts
to owner and unclaimed by owner". A test pins that literal against the worker
source, since a copied string that drifts would stop matching with no failure
anywhere.

That also removes the need for any waiting step on the owner-direct flows: the
park holds the run until she replies or the second reminder lapses at 30
minutes, so the verdict is already in `actions_taken` when the branch
evaluates. A late "1" cannot change it either, because the exhaustion path
deletes `step_index` and the late-claim matcher then skips the run entirely.

**Follow Up Requested is the exception, in two ways.** It has no
`ownerDirectTemplate`, so its $1M+ leads really are offered to the team, the
exhaustion marker can never appear, and its arm gates on `claimed_agent ==
"none"` in the normal way. Because it IS a team offer, it also keeps the
120-minute grace wait its sibling under-$1M arm uses (copied from that arm,
not hardcoded): the wait is what leaves room for a late claim, and tagging the
moment the offer resolves would start the AI cadence while a teammate could
still be picking the lead up.

**HomeLight is exempt from that arm**, same reason it is exempt from the
under-$500K gate: it withholds the lead's phone and email until a claim
happens, so a text-and-call cadence would have nothing to dial. Its banner and
capitals still apply.

**Under $1M needed no change.** `price_under_1m` already gated the takeover in
every flow that has one, and buyers reach it (they always read `price_gate:
"team"`, so they clear the `notEquals "ai"` guard).

### The AI-intake call alert now carries the lead (Aug 24 2026)

Amy's Aug 23 ask, texted to her coworker twice: include buyer or seller,
name, phone, email, website source, and price on notifications like the
"New live-transfer lead (AI intake), the team missed the warm handoff" texts.
The owner-rule capture saved that preference to her memory
(`business_configs.memory_md`, "Owner chat (2026-08-23)"), but the alert
itself is a fixed template in the voice bridge and read none of it. Both of
her examples were OUTBOUND cadence calls to Clever leads that hit voicemail
(Isiah Perez and Linda Elenes, both already carrying name, email and
`lead_source` on their contact rows), so the header's missed-warm-handoff
claim was false and the lead's own number rendered as "Transferred via".

Closed as a PLATFORM change (`composeIntakeLeadSms` +
`sendIntakeLeadSms`, `vps/voice-bridge/src/`), not a tenant patch, since the
mislabeling hit every tenant with outbound `place_ai_call` summaries. An
outbound finished-call alert now reads: an honest "AI follow-up call summary"
header, an "Outcome: reached voicemail..." line when the model's own machine
verdict stamped the session, `Lead: <name> (<number>)` plus
`Lead email:` / `Lead source:` from the central contacts row for the dialed
number (signed caller only), and `Call briefing:` with the flow's
`contextTemplate` note verbatim, which is where buyer/seller intent and the
source site live (the cadence note reads "They inquired about
{{vars.lead_intent}} in {{vars.lead_city}} (source: {{vars.lead_site}})"
since the Aug 27 2026 fallback-composition fix).
Inbound live-transfer alerts are byte-identical to before.

Two limits, both deliberate: price appears only when the flow's briefing
carries one (the cadence's note does not; team offers already quote price),
and her `voice_handoff_chains.capture_fields` were NOT extended to
interrogate live callers about buyer/seller, because her Aug 5 rule says
seller calls are "about winning the lead and not about information
extraction". Remember the bridge is not covered by the root tsc and is live
only after `tsx debug/redeploy-voice-bridge.ts --all`.

## Booking alerts

`maybeAlertUnassignedBooking` already fired on EVERY confirmed booking, not
only unowned ones: it resolves an ownership state (`solo` / `covered` /
`unowned`) and dispatches on all three. The flag name
`unassigned_booking_alerts` is the misleading part. Amy's row has it ON, so
"notify owner on all appointments booked" needed no flow change.

What it could not do was tell anyone except the owner. Two new columns on
`notification_preferences` (migration `20260822180406_booking_alert_audience`):

- `booking_alert_audience`: `owner` (default, and exactly today's behavior for
  every tenant) / `employees` / `both`.
- `booking_alert_member_ids`: null or empty means every active member,
  otherwise just those ids.

The employee leg is an SMS, resolved by
`src/lib/calendar-tools/booking-alert-recipients.ts`. Inactive members are
dropped even when named explicitly, members with no phone are dropped (this
leg is SMS only), and two roster rows sharing a number get one message. A send
that fails is logged per member so one dead number does not cost the others
theirs. Amy is left on the `owner` default; the capability is what shipped.

On `both`, a member whose number is the owner's alert number is dropped from
the employee leg: they already got this booking as the owner alert. **That is
Amy specifically**: she is an active row on her own roster carrying the same
mobile number her `notification_preferences.phone_number` holds, so without
the rule she would get two texts per booking. On `employees` no owner alert
goes out, so the same person IS texted.

**Her AI still cannot book.** `calendar_book_appointment` is enabled only for
`agent_key = "dashboard"` and is FALSE for sms, voice, webchat and email, so
no customer-facing surface can create an appointment. Dashboard bookings are
also excluded from this alert at the call site
(`bookSurface === "dashboard"` passes no `alertSurface`), on the reasoning
that the owner already knows what they just booked. That leaves the public
booking page as the only producer of a booking alert on this tenant today.

## Email as a follow-up vehicle (Aug 18 2026)

A ReferralExchange lead (Valerie Marino) arrived with an email and no phone,
and the team offer said so plainly: "the AI cannot text or call them. Somebody
has to work this one by hand." Brian: "Add email as a vehicle for follow ups
for ai."

**What an email-only lead got before.** Traced on her live run (`89d9025e`):
the flow offered her to the team, sent her ONE intro email, told Amy nobody
could be texted, and stopped. Every SMS and call step skipped, because
`sms_lead_type` and `route_lead_type` both read `none` for a lead with no
phone option. Nothing followed.

**Why the existing cadence could not just be reused.** "Needs Follow Up (AI
cadence)" is triggered by a TAG on a contact, and `update_contact` takes a
`phoneVar`. Contacts are keyed `(business_id, customer_e164)`, so an
email-only lead has no contact row at all (confirmed: Valerie has none) and
cannot be tagged. Every round of that cadence is call + text +
`wait_for_reply`, and `wait_for_reply` is phone-only too. So the email cadence
lives INSIDE the lead-source flows, where `{{vars.lead_email}}` is in scope.

`scripts/oneshot/amy-email-followup-cadence.ts` appends one block to
ReferralExchange Lead, Realtor.com Lead, New Lead Intake and Clever Lead -
Accept. HomeLight Referral is deliberately excluded: it already runs its own
three-rung email ladder to the lead.

**Shape.** Gated on `lead_phone` not containing `+` (the SAME predicate the
flows' own no-phone guards use) and `lead_email` containing `@`. Then three
rounds a day apart: wait, read the mailbox, send unless something came back.

**Reading replies without `wait_for_reply`.** The check is an `email_extract`
poll of Amy's connected Outlook, the mechanism the bad-phone branch already
uses for bounce detection. It carries NO `fromContains` on purpose: a bounce
notice comes from a postmaster, not from the lead, so matching on the lead's
ADDRESS APPEARING in the message catches a reply and a delivery failure alike,
and one Gemini field says which (`replied` / `bounced` / `none`).
`lookbackMinutes` maxes at 1440, which is exactly the gap between rounds.

An opening read runs BEFORE the first sleep. The block sits at the end of the
flow, after a team offer and a park that can last hours, so round one's window
would otherwise open a day after that and miss a prompt reply to the intro
email entirely, sending three more emails to somebody who had already
answered.

**Two traps this design is shaped around:**

- `noMatchVars` is load-bearing, not polish. Without it a quiet mailbox writes
  nothing, the gate var never exists, and every step reading it sits inert.
  Amy's HomeLight reveal ladder failed exactly that way on 2026-08-16.
- Each round gets its OWN stop var (`efu_stop_1..3`) rather than sharing one.
  A shared var is sticky once it reads `replied`, so a flat cadence gated on
  it would re-alert the owner on every later round for a single reply. The
  per-round var also carries the stop cascade without a branch per round,
  which matters because the schema caps branch nesting at three levels.

**A known bound, accepted on purpose.** The mailbox fetch returns at most 25
inbox messages in the window, newest first, and `fromContains` filters AFTER
that fetch rather than narrowing it. Amy takes lead alerts from four portals,
so on a busy day a reply can sit outside those 25 and read as `none`. The
consequence is one extra follow-up and no proactive alert; the reply itself is
not lost, because it is sitting in the inbox that poll just read. The same
exposure already applies to the bounce check the bad-phone branch has run for
months. If it bites, the fix is in `src/lib/ai-flows/email-fetch.ts` (raise
`EMAIL_FETCH_MAX_MESSAGES`, or push the sender filter into the Gmail/Graph
query), not in the flow.

A reply goes to whoever owns the lead (`notify_lead_owner`, falling back to
the team); a bounce goes to Amy with the standard `‼️‼️‼️‼️‼️` banner, because
an address that does not work plus no phone means nobody can reach that lead
at all.

**A claim does not stop it**, matching her standing rule that a claim is a
teammate saying they will work the lead, not evidence anyone was reached.
Valerie's run is claimed by Gabrielle Mota and still gets the emails.

Leads WITH a phone are untouched: Brian chose email-only over adding email to
every round, so a lead getting calls and texts keeps getting exactly those.

### The same arm inside the cadence (Aug 18 2026)

Once a contact can be identified by email as well as phone, an email-only lead
can be tagged and so can reach "Needs Follow Up (AI cadence)" itself. The
cadence therefore carries the same block, from the same shared builder
(`scripts/oneshot/_amy-email-followup-block.ts`), so the copy and timing
cannot drift between the two places.

Three things made that safe to add to a flow that always has runs parked
mid-cadence:

- **Nothing before flat index 30 moved.** The block goes in immediately before
  `converted`, and a pinned test asserts the first 30 flattened ids are
  unchanged. When applied there were 8 parked runs, the furthest at step 13.
- **It sits BEFORE the `converted` goal, deliberately.** A goal step is a
  fast-forward TARGET: the run jumps to it and skips everything between.
  Placed after it, this arm would be the first thing a lead who had just
  BOOKED walked into, and it would start emailing them.
- **The phone rungs need no gating and get none.** Each already degrades on
  its own with no dialable number: `place_ai_call` resolves to `not_placed`
  rather than failing, `r{n}_text` is gated on `no_answer`, and
  `wait_for_reply`'s planner resolves straight to the `no_reply` sentinel
  instead of parking a run that could never be resumed. An email-only lead
  reaches the arm in one pass, with `lead_reply` reading exactly as it would
  for someone who did not answer.

  An earlier draft added a model-extracted `reply_wait_minutes` fed to each
  wait through `timeoutMinutesTemplate`, on the belief that a phone-less lead
  would park three days per rung. That belief was wrong (the planner
  short-circuits), and the mechanism carried a real risk: a model answering
  "1" for a lead who DOES have a phone would collapse the three-day cadence
  into three minutes of calls and texts. Removed.

**That gap is closed (Aug 19 2026, PR #1497).** `applyGoalEvent` matched runs by
phone only, so an `appointment_booked` event never reached an email-only run
and the `converted` jump never fired: a phoneless lead who booked kept getting
the remaining follow-ups. It now also matches the contact key on
`trigger.from` (engine-set, so it is the reliable half) and `vars.lead_email`
case-insensitively. `fireGoalEvent` used to drop anything that was not a phone
one level above that, so the milestone never fired at all; it takes an address
or a contact key now. The AI booking path passes the attendee's email when
there is no phone. The public booking page needs no change: it rejects a
booking without a valid E.164 number outright.

An email reply resolves to the claiming teammate by NAME (`nameVar:
"lead_name"` on the notify): the step keys on a phone var first, and an
email-only lead has none, so without it every reply would take the unowned
fallback and go to the whole team.

### An emailed lead now becomes a contact (Aug 18 2026, platform)

Both arms above reach an email-only lead, but until PR #1486 that lead still
had no row in Contacts at all, so Valerie was emailed for three days and
claimed by Gabrielle while appearing nowhere in the CRM.

The cause was an asymmetry, not anything tenant-specific: lead filing hung off
the `send_sms` path only (`recordLeadCustomerProfile`), so a lead we could only
email was never filed. `send_email` now files the lead the same way, keyed by
their phone when the flow captured one and by `email:<addr>` when it did not.
It applies to every tenant and needed NO change to any of Amy's flows.

**The tagging steps in the lead-source flows stay phone-only, and that is now a
different decision than it looks.** With the cadence carrying its own email arm,
tagging an email-only lead is no longer a no-op. It is a DOUBLE: these flows
already run the identical block in-flow, so a tagged email-only lead would get
the cadence's three emails and the flow's three emails, same copy, same mailbox,
same person. The split above is the whole design. The lead-source flows serve
their own email-only leads in-flow; the cadence's arm serves an email-only lead
that arrives tagged from somewhere else.

**Resolved Aug 19 2026: there is now ONE copy, in the cadence.** Brian: "Remove
the unneeded one to avoid confusion and drift. Email cadence should start if
have a case like Valerie. It is only used as a fallback if there is no phone
number." `amy-email-followup-via-tag.ts` swaps the inline rounds in the four
lead flows for a single `update_contact` behind the same two gates, so an
email-only lead is TAGGED and the cadence runs the emails.

The tag is gated on reachability and nothing else, deliberately unlike the
flows' other tag steps: the unclaimed ladders only fire while `claimed_agent`
is "none", and the call-outcome tags only after a call a phoneless lead never
gets. Jack Briggs, claimed by Gabrielle and mid-cadence when this shipped,
would have been tagged by none of them, so reusing those steps would have
quietly dropped exactly the leads this is for.

It FILES the lead (`upsert_customer`, keyed by the address) before tagging.
`update_contact` skips when there is no contact row, so tagging alone would
have depended on an earlier `send_email` in the same flow having succeeded,
which is what files an emailed lead. A skipped or failed intro email would then
have silently ended all outreach, and the inline rounds it replaces needed no
contact at all.

It carries an honest note rather than the shared `AUTO_TAG_NOTE`, which says
the AI "already called and texted" and would be false for a lead with no phone.
The cadence's round-1 call is a harmless no-op for them, so there is nothing to
suppress and no reason to lie in a line a human reads.

A person tagging an email-only contact from the Contacts page reaches the arm
today, and that path was quietly broken until PR #1489: `contactEventText`
printed the contact KEY under a `phone:` label, so the window the cadence's
`read_lead` extraction reads said `phone: email:valm0417@gmail.com`. A contact
with no phone now gets no phone line. `trigger.from` deliberately stays the
KEY, because the worker seeds `{{vars.contact_language}}` by looking the
contact up with it; `from_matches` lines up from the other side instead, with
`resolveRefIdentityValues` listing the key alongside the address.

## One-shots

**`amy-shorten-offer-templates.ts` (applied Aug 29 2026):** shortens
every `route_to_team` offer template on the eight enabled flows so an unclaimed
lead costs fewer billed SMS segments, without dropping a fact. Written while
tracing the Telnyx jump from $30.78 (July) to $50.95 (Aug 1-28): the per-segment
rate did not move, Amy's `agent_offer` sends did, 101 -> 464, because the Aug
10-15 team-routing work (#1270, #1272, #1317, #1397) fans every offer out to all
four roster members instead of one. That fan-out is what Amy asked for and the
script does not touch it.

Four mechanical transforms, all idempotent: the two-line reply-syntax
boilerplate becomes one line, the 126-character call-summary sentence is
shortened, non-ASCII characters are removed (a single emoji re-encodes a whole
message as UCS-2 and cuts every segment from 153 characters to 67), and
trailing whitespace goes. It deliberately does NOT touch the first-to-claim vs
next-agent wording (load-bearing, see `amy-broadcast-realtor-and-offer-copy.ts`)
or `Details: {{trigger.windowText}}` on the Clever route, which is the single
largest line in any offer at roughly nine segments per send: cutting the raw
vendor blob is Amy's editorial call, not a mechanical saving, and the dry run
prints a note saying so.

The compact reply line names all three forms a reply can carry, including
`"1, <Name of lead (if multiple)>"`, which the old copy never mentioned even
though it has worked since PR #1270. That costs some of the saving on purpose:
a bare "1" with several offers pending asks WHICH lead, so a teammate who does
not know the name form has to answer a second text.

Measured by replaying her 450 real August offer sends through the transforms:
2,072 billed segments -> 1,964, about $0.91 a month (it was $1.54 with the
terser line that omitted the name form). TWO ENGINE FIXES ARE WORTH
MORE and are not tenant copy, so they are not in this script: `{{offer.deadline}}`
renders through `formatInTimeZone`, whose `Intl.DateTimeFormat` emits U+202F (a
narrow no-break space) before "PM" on the Edge runtime's ICU, forcing UCS-2 on
every offer that names a deadline (-475 segments, $3.99/mo for Amy alone, and it
hits every tenant); and the final-reminder banner in
`_shared/ai_flows/offer_reminders.ts` is an emoji, which does the same to every
final reminder (-55 segments, $0.46/mo).

**`amy-email-followup-cadence.ts` (Aug 18 2026):** appended the three-round
email follow-up block to ReferralExchange Lead, Realtor.com Lead, New Lead
Intake and Clever Lead - Accept. Pure append, so parked runs kept their
`current_step`. SUPERSEDED by `amy-email-followup-via-tag.ts` below, which
removes that block again; run this one only to reconstruct history.

**`amy-email-followup-via-tag.ts` (Aug 19 2026):** replaces those inline rounds
with one `update_contact` that tags an email-only lead "Needs Follow Up", so
the cadence runs the emails and there is exactly one copy of them. REMOVES
steps, so unlike the append above it is not automatically index-safe: it reads
the live runs per flow and REFUSES to apply while any is parked at or after the
block, naming each one (`--force` overrides deliberately). `--revert --apply`
puts the inline rounds back.

**`amy-cadence-lead-type-from-note.ts` (Aug 24 2026):** "Needs Follow Up (AI
cadence)" could not tell a buyer from a seller. It triggers on a `tag_changed`
event, whose text is the contact's fields (name / phone / email / tags /
source / tag / change / note), and none of those says which. So its `lead_type`
field fell to its written default on all 42 of the flow's first 42 runs: every
`r*_route_buyer` branch was unreachable, a ready-to-talk buyer went to the
seller trio instead of the buyer rotation, and Jason Lane (roster tag `buyer`
only) could not be reached by this flow at all. Found via Sandy Baldwin (Aug 23
2026), a ReferralExchange BUYER whose parked cadence run says seller.

The fix has two halves. The upstream flows that DO establish a type
(ReferralExchange Lead, Realtor.com Lead, New Lead Intake) now append
`lead_type: {{vars.lead_type}}` to the `noteTemplate` of every
`update_contact` that adds the tag, and the cadence's `read_lead` reads that
note first. Appended, never replacing: round 1's call gate tests the note for
the exact phrase `auto_first_contact`, so a note that has it keeps it and a
note that lacks it must not gain one. Clever Lead - Accept and "Follow Up
Requested" are skipped by rule (no `lead_type` field), so they keep today's
seller default; changing that is Amy's call.

Two ordering notes. The same PR taught `contactEventText` to emit a `source:`
line from `contacts.lead_source`, which is what the reworded `lead_site` field
reads, so run this only after that merge deploys. And the flow BUILDERS still
emit the base note, so re-seeding any of those flows drops the marker: re-run
this script (it is idempotent) after any re-seed. `--revert --apply` undoes it.

**`amy-heal-parked-cadence-lead-type.ts` (Aug 24 2026):** the companion to the
above, for runs already in flight. A cadence run sits in `wait_for_reply` for
three days at a time, so a `lead_type` written before the tag carried one is
not history: it decides which half of the roster hears about the lead when they
answer. Evidence-only. For each `awaiting_reply` cadence run it reads every
OTHER run mentioning the same `lead_phone` that established a `lead_type`, and
rewrites the parked run only when those agree on exactly one value AND it
differs. No evidence, or evidence that disagrees with itself, leaves the run
alone and says so.

Clever runs are skipped by that rule rather than by a special case: "Clever
Lead - Accept" extracts no `lead_type`, so it offers no evidence. That is the
right answer for them. Clever Offers is a seller program, its referral text
carries a bare "Seller" line, and every field in that flow reads "the
seller's", so their seller is correct rather than a default that happened to
land. The exception worth knowing: Clever DOES occasionally send a buyer
referral through the same "Clever referral" format (Kristy White Jul 8 2026,
Donna Robinson Jul 31 2026), and that flow handles them as sellers end to end.
Giving it a `lead_type` field is the open follow-up.

The write is a compare-and-swap on `ai_flow_runs.revision`, so a worker that
resumed the run since the read wins and the script reports a skip. First
applied Aug 24 2026 to two runs: Sandy Baldwin (seller -> buyer) and Frank
Demarco (seller -> both).

**`amy-heal-parked-cadence-lead-site.ts` + cadence re-seed (Aug 27 2026):**
the cadence's fallback copy composed into gibberish on live calls. Its
templates said "your enquiry through {{vars.lead_site}} about
{{vars.lead_intent}} in {{vars.lead_city}}", and when extraction knew nothing
the written fallbacks filled that in as "your enquiry through your recent
enquiry about your move in the area", which is what the AI actually opened
with on call 68ca8cdb (Sandy Baldwin, Aug 26 2026,
`voice_handoff_sessions.context`). The fallback case is the COMMON one:
`lead_city` fell back on 14 of 14 in-flight runs that day.

(The quotes in this paragraph keep their original British spelling of
"inquiry" because that is what the flow actually said at the time. The
spelling itself was fixed platform-wide on Aug 28 2026, see below.)

The fix splits the site into two vars, because its two audiences need
different grammar and different fallbacks. `lead_site` stays the bare network
name for team-facing copy ("source: Clever"), now falling back to "unknown"
instead of a sentence fragment; the new `lead_site_ref` is the phrase spoken
TO the lead ("your inquiry through Clever"), falling back to "your recent
inquiry", so the sentence survives an unknown source. Spoken surfaces
(persona, round-1 voicemail and text) read the phrase var; team surfaces
(`contextTemplate`, which the outbound call summary quotes as "Call
briefing", the FOLLOW-UP REPLY notice, the promote offer and owner fallback)
read the label. Two dormant copy entries that composed "The the area market"
and "recent the area sales" were reworded in passing (unreachable at
ROUNDS=3, live again the day ROUNDS grows). Step ids and count are unchanged,
so parked runs keep their `current_step`; the flatten-live-vs-new check still
ran before the apply, per the standing rule. A composition test now renders
every template against the full fallback scope and fails on "through your
recent inquiry" (and on the pre-Aug-28 British spelling of it), double
spaces, or a `vars.*` placeholder nothing produces.

Apply order matters: `amy-heal-parked-cadence-lead-site.ts --apply` FIRST,
then `seed-amy-needs-follow-up-aiflow.ts --apply`. The heal seeds
`lead_site_ref` on parked `awaiting_reply` runs (nothing in the OLD
definition reads it, so healing first is invisible; the other order leaves a
window where the new persona reads a var parked runs never extracted) and
fills a fallen-back `lead_site` from `contacts.lead_source`, which the
platform stamps from the filing flow and which all twelve parked runs'
contacts carried, so Sandy's remaining round names ReferralExchange instead
of reading naturally but vaguely. Evidence first, fallback second: a run
whose extraction produced a real site keeps it, the contact row only fills
gaps. Revision-CAS like the lead-type heal above; idempotent, dry-run by
default, ledger-recorded.

**`heal-inquiry-spelling.ts` (Aug 28 2026, platform):** Amy's leads were being
called about "your enquiry through Clever". "Enquiry" is the British spelling;
to an Arizona homeowner it reads as a typo, and it was being spoken aloud on
every cadence call that knew its source site. It came from two independent
places, so it needed two fixes.

The stored copy is what this one-shot fixes. Both of Amy's ENABLED flows had
the spelling baked in: "Needs Follow Up (AI cadence)" carried it in the spoken
persona, the round-1 voicemail script, three team `contextTemplate` notes, the
follow-up email body, and the `lead_site_ref` extraction-field instruction
that literally told the model "answer exactly: your recent enquiry".
"ReferralExchange Lead" carried it in two spoken personas and its team note.
Seventeen strings across three flows in all (KIN's disabled "New Lead Intake"
was swept in the same pass). Fifteen runs parked in `awaiting_reply` also held
`lead_site_ref` "your enquiry through <site>" in their variable bags, written
by the pre-fix extraction, and those would have spoken the old wording on
their next call no matter what the definition said.

It is a text substitution, not a re-seed: the definition modules regenerate a
whole flow, which is the wrong tool for a six-letter change on a live
automation. The script walks the stored JSON and rewrites only the matching
substrings, leaving structure and ids untouched. Flow writes stamp
`edit_source`/`edit_actor`, so the definition-versions trigger snapshots the
prior bytes and the change is reversible; run writes are revision-CAS.
Idempotent, dry-run by default, ledger-recorded.

The models' own drift is the other half, and a one-shot cannot fix it: the AI
also produced the spelling on turns no template scripts. `US_SPELLING_PROMPT_LINE`
(`supabase/functions/_shared/sms_prompt_lines.ts`) now rides every AI surface's
system prompt, with lockstep copies in the voice bridge (`usSpellingLine`, the
surface this was heard on) and the document agents.
`tests/inquiry-spelling.test.ts` fails CI if the spelling reappears in a
guarded copy-first surface, including every `scripts/oneshot/*-definition.ts`,
so a re-seed cannot put it back.

**`amy-clever-lead-type.ts` (Aug 24 2026):** "Clever Lead - Accept" could not
tell a buyer from a seller, and that is structural rather than careless: Clever
Offers IS a seller program, so every `read_details` field reads "the seller's
...", the AI call opens "about your request through Clever about selling your
home on {{vars.lead_address}}" and pitches listing against a cash offer, and
the unreachable-lead broadcast was pinned to the literal `seller` tag. Clever
nonetheless sends BUYER referrals through the same "Clever referral" format the
flow triggers on: two real ones, Kristy White (Jul 8 2026) and Donna Robinson
(Jul 31 2026), both handled as sellers end to end.

Three changes. `read_type`, a new `extract_text` at the FRONT, sets
`lead_type` from the referral TEXT, not the browsed page: the bare "Seller" /
"Buyer" line is a property of the SMS (116 seller, 2 buyer, 1 silent across the
flow's 119 runs), while `read_details` is a browse_extract against the portal.
`clever_call_gate` wraps `ai_call_1` so a buyer never receives the listing
pitch; the step keeps its id and its own `price_under_1m` guard and simply
moves into the else arm, because a `when` holds exactly one condition. The
retries need no gate, they sit behind `call_outcome equals no_answer` and a
skipped call leaves it unset. And `clever_no_phone_offer.teamTagTemplate` moves
from `seller` to `{{vars.lead_type}}`: on this roster `seller` still reaches
Gabrielle and Dave exactly as the literal did, while `buyer` also reaches Jason
Lane, whose only tag is `buyer`.

Two things deliberately NOT done. No buyer persona was written: this stops the
wrong call rather than inventing a right one, and the buyer pitch is Amy's copy
to write. And `route` keeps its pinned `agentNames`, because the schema refuses
`teamTagTemplate` beside pinned recipients, and switching that step to
`broadcastAll` would silently drop Amy, whose `team_broadcast_enabled` is false
because she is the backstop.

Because the flow now DECLARES `lead_type`, `amy-cadence-lead-type-from-note.ts`
stops skipping it by rule; re-running that script marked its six "Needs Follow
Up" tag writers, so Clever leads now reach the cadence with their type. Both
were applied Aug 24 2026, in that order.

**`amy-clever-buyer-rotation.ts` (Aug 24 2026):** finishes what
`amy-clever-lead-type.ts` started. Gating the AI call stopped a buyer getting
the listing pitch but left two things: every Clever lead was still OFFERED to
the pinned seller trio (Gabrielle, Amy, Dave), so Jason Lane, whose only roster
tag is `buyer`, never saw one; and the offer copy still promised "the AI calls
again in about 2 hours, then once more tomorrow morning", which for a buyer is
now false and invites a teammate to leave the lead believing the AI has it.

`clever_route_gate` forks the offer on `lead_type`, mirroring `rt_route_gate`
in Realtor.com Lead rather than inventing a second shape for the same decision.
The buyer arm holds `route_buyer`, a route_to_team with NO `agentNames`, which
is what the rotation IS on this engine: offered to one teammate at a time in
rotation order rather than broadcast to a named list. Its copy states in every
team-facing template (offer, claimed, owner fallback, owner direct) that the AI
has not contacted the lead and will not, so whoever claims knows they are the
only contact. The else arm holds `route` byte for byte as it was; sellers are
116 of 119 and nothing about them changes. The branch carries no `when`, each
route keeps its own `price_gate` guard, again matching Realtor.com. The $1M+
keep-for-Amy rule rides along on the buyer route: it is a price rule, not a
seller rule.

Known and not fixed there, and see the CORRECTION in the entry below: the
price gates are worded for a seller's single figure and say nothing about a
buyer's range.

**`amy-clever-buyer-price-range.ts` (Aug 24 2026):** the price gates now read a
buyer's budget RANGE. `price_gate` ($500K+ to the team, under is AI-owned) and
`price_under_1m` (from `price_digits`, $1M+ kept for Amy) between them gate five
steps. Both were worded for a seller's single figure ("Est. Home Value:
$825,000.00"); a buyer referral shows "Est. Price Range: 0 to 200000" instead,
and neither description said what to do with two numbers, so `price_gate` fell
to its own default of "ai" and a buyer was AI-owned whatever their budget.

The rule, added to `price_gate` and `price_digits`: judge a RANGE by its TOP.
That is the buyer's ceiling, and it is the human-first direction, so a wide
range on a high-dollar buyer is not quietly handed to the AI. `price` keeps the
range verbatim because no gate reads it, only team-facing notices, where
"300000 to 450000" is honest and one end would state a number the referral
never gave. `price_band` is left alone: nothing in the flow reads it.

**CORRECTION to the entry above.** It cited the two real buyer runs (Jul 8 and
Jul 31 2026) as evidence that the extraction comes back empty for buyers. That
evidence does not support it. `price_gate` first appears in a run on 2026-08-13
and `price_digits` on 2026-08-14, so on those July runs the fields did not exist
yet, which is why they are blank, and there has been NO Clever buyer since. How
the old wording behaved on a real buyer page was untested, not known broken.
What was certain, and what this fixes, is the wording itself.

Downstream, and it is a real behavior change: a $500K+ buyer now reaches
`route_buyer` and the rotation (today they never do), a $1M+ buyer is kept for
Amy by `route_buyer.ownerDirectWhen` (today it never fires for a buyer), and an
under-$500K buyer becomes AI-owned per Amy's own rule. Traced against the live
definition, that last case is not a hole: `clever_gated_after_call` runs, no
call arm matches because the AI call is gated off for buyers, so its else tags
them "Needs Follow Up" carrying `lead_type: {{vars.lead_type}}` and the cadence
works them as a buyer.

Trap worth keeping: `extractFieldSchema` caps a field description at 300
characters and a breach surfaces only as "Invalid AiFlow definition" naming no
field. The first draft of this patch was rejected for exactly that;
`tests/oneshot-amy-clever-buyer-price-range.ts` now pins the length.

**`amy-clever-buyer-ai-call.ts` (Aug 24 2026):** the AI works a Clever BUYER
the way it works a Clever seller. Amy asked for Clever buyers to be treated
"similar to the response for a realestateagent.com buyer lead", and separately
asked whether it made more sense for the AI to work them "until they're serious
and want to either make an appointment or do a Live transfer". Those read as
two options and are one: RealEstateAgents.com is not a flow, all 119 runs whose
`web_source` names it run on ReferralExchange Lead, and that flow's
`ai_call_buyer` already does exactly the second thing.

`clever_call_gate`'s empty buyer arm now holds `ai_call_buyer`, copied from
ReferralExchange's buyer persona with the source named outright (Clever has no
`web_source`) and the budget and search area declared as already known.

The trap this exists to avoid: `ai_call_2` and `ai_call_3` are seller-worded
and fire on `call_outcome equals no_answer`, which a buyer call sets too, so
filling only the first arm would have called a buyer twice more with a listing
pitch. They could NOT be wrapped in gates like round 1: they sit at
`call_followups[cf_no_answer] > retry_2.else > retry_3.else` and the schema
rejects branches nested more than three deep. They use the idiom the schema
documents instead, two gated siblings: the seller rung gains
`lead_type notEquals buyer` and the buyer rung sits beside it. No nesting added.

**The transfer ladder is capped at THREE** (`reachTeammate.refs`), and Amy named
four people ("me or Dave or Gabby or Jason"). This is a warm transfer, so the
lead is held on the line while each rung is dialled; the cap is a hold-time
budget. The buyer ladder is Dave, Gabrielle and Jason. Amy is the least-loss
name to drop because this account already treats her as the BACKSTOP rather
than part of the audience (`team_broadcast.ts`, and her
`team_broadcast_enabled` is false by design): she still gets an unclaimed buyer
through the owner fallback, and a $1M+ buyer never reaches the ladder because
`ownerDirectWhen` keeps them hers. Jason has no other route onto a live
transfer, since `buyer` is his only roster tag.

Jason was ALREADY in the round-robin rotation and needed no change there: an
unpinned `route_to_team` offers to every ACTIVE roster member in
least-recently-offered order, not a tag-filtered subset, and he has been
offered 18 leads that way since Jul 1, including Sandy Baldwin's where he was
rung first. Only the explicit transfer list excluded him.

Not changed, both decided Aug 24: `route_buyer` keeps its `price_gate` guard
(Amy chose to keep the under-$500K AI-owned rule for buyers rather than adopt
ReferralExchange's ungated buyer routing), and no lead-facing SMS was added
because this flow texts the lead nothing for sellers either; the texts come
from the follow-up cadence. Seller calls and their ladders are untouched.

The ReferralExchange half is OPT-IN behind `--with-referral` and was NOT
applied: that ladder is already full, so seating Jason there unseats Amy on a
live path with 119 runs behind it, which should be a decision somebody typed
rather than a side effect.

**Voicemails: `amy-voicemail-scripts.ts` was finally RUN (Aug 24 2026).** Amy
asked for voicemails on the Clever seller calls. The script that does it had
existed since Aug 19 and had simply never been applied: no ledger row, and
every `place_ai_call` on the account still silent. It covers all thirteen in
one pass, Clever Accept's three rungs, Spoke Check's eight weekly rungs, and
New Lead Intake's English AND Spanish calls. After running it: 22 AI calls
carry a voicemail, 0 do not.

Recorded because it cost a wrong turn: a duplicate one-shot covering only the
three Clever rungs was written and applied before the existing script was
found, then reverted and deleted (it never reached main). The live flow was
checked for voicemails; the REPO was not checked for a script that adds them. The existing copy is also the better copy, being built on rules this
account already holds (never ask when to call back, never quote the network's
price estimate back at a seller) and leading on the cash offer, which is what a
Clever seller actually filled in.

**Jason is on every buyer live transfer (Aug 24 2026).** Amy: "Jason should be
on all buyer aiflows. Amy should be last."
`amy-clever-buyer-ai-call.ts --with-referral` was run, so
ReferralExchange's `ai_call_buyer` ladder moved from Dave / Gabrielle / Amy to
Dave / Gabrielle / Jason, matching the three Clever buyer rungs. All FOUR
buyer-facing AI calls on the account now reach him.

"Amy should be last" is implemented as the OWNER FALLBACK rather than a ladder
seat, because the two instructions do not both fit: `reachTeammate.refs` caps
at three and she named four people. Dropping Dave or Gabrielle to seat her
would remove an active buyer agent, while Amy already receives any buyer no
rung answers, through the fallback, and a $1M+ buyer never reaches the ladder
at all. So she is last in the order that actually runs. If she meant a literal
third seat instead, that is a one-line change to `BUYER_REACH_NAMES`.

The SELLER ladders keep Dave / Gabrielle / Amy: Jason's only roster tag is
`buyer`. "Both" leads are treated as sellers everywhere on this account
(`route_both` pins the trio in all four flows that have one), so
`ai_call_both` was left alone too.

**Voice infra (Aug 2026):** `migrate-tenants-to-dedicated-telnyx-apps.ts` moves
this tenant off the shared Telnyx Call Control app/profile onto a DEDICATED
app + outbound voice profile (both named with the searchable marker
`[nc:<business id>]`): carrier-enforced concurrent-call cap equal to the plan
tier, a per-tenant $25/day spend fuse, the full destination whitelist, and the
DID re-pointed onto the tenant app. Idempotent (re-runs adopt by marker).
Whether it has run is in the applied_oneshots ledger.

**Follow-up repair (Aug 24 2026):** `repair-misclaimed-lead-followups.ts`
restarts the AI follow-up on runs closed by a mis-routed `"1, <name>"` claim
(see Sharp edges). Evidence-only, on two fingerprints: a recorded claim whose
ETA does not read as a timeframe, or the script's own repair marker next to
`routing.owner_assigned` (a repair the owner-assign path closed again). Clears
`contacts.owner_employee_id` FIRST as a precondition (guarded on it still
naming the mis-claimer, verified by re-read, and skipping any run whose
ownership it cannot positively clear), then clears the claim, resets the `claimed_agent*` vars and requeues at the
step AFTER the route step: it does NOT re-ask the team, because the claim was
fabricated by a bug and the answer is already known (`--reask` rewinds onto the
route step for a case where it is not). `tried`/`offered_log` are left intact
so nobody is re-offered a lead they already passed. Fleet-wide by default; all
four affected runs were this tenant's. Idempotent.

**Transcript repair (Aug 18 2026):** `repair-clobbered-ai-transcripts.ts`
restores AI transcript rows that the forwarded-call record overwrote on a warm
transfer (direction, model, and the stamped `summarized_at` that kept the call
out of the summary sweep). Fleet-wide by default; both affected rows were this
tenant's, calls 24c3a49c (Jul 14) and 5634b7f0 (Aug 18). Evidence-only: each
field comes from the reservation or the call's telemetry, and the Jul 14 row's
model is unrecoverable because its telemetry has aged out. Idempotent.

Which of these actually ran, and when, is in the ledger, not here:
`select script, applied_at from applied_oneshots where business_id =
'621a5b0d-c2ad-449f-9d74-9d50e7b27fa3' order by applied_at desc`.

Account-wide owner notices: `amy-owner-notice-policy.ts` (Aug 17 2026, nine
flows: banners, silenced routed notices, the $1M+ path; `--revert --apply`
restores every definition from the ledger).

Clever: `seed-clever-lead-accept-aiflow.ts`,
`seed-clever-lead-group-reply-aiflow.ts`, `seed-clever-cue-aiflow.ts`,
`seed-clever-spoke-check-aiflow.ts`, `seed-clever-homeward-aiflow.ts`,
`seed-clever-update-leads-aiflow.ts`,
`seed-clever-update-leads-chris-aiflow.ts`,
`seed-clever-voice-transfer-rule.ts`, `clever-spoke-check-definition.ts`,
`patch-clever-accept-followup.ts`, `patch-clever-cue-arm-transfer.ts`,
`patch-clever-group-reply-name-desc.ts`, `fix-clever-existing-flows.ts`,
`clever-start-immediately.ts`,
`patch-clever-group-reply-second-intro.ts`,
`patch-clever-accept-idempotent.ts` (Aug 4 2026: `continueWhenText` on the
accept step, see Sharp edges),
`patch-clever-accept-whisper-budget.ts` (Aug 27 2026, fleet
fallback-composition audit: the buyer live-transfer whisper composed
"looking around X at about {{vars.price}}" while `price` falls back to the
literal 'none' on roughly a quarter of runs, so the teammate picking up a
live call would read "at about none". The price is a labelled
"Budget: {{vars.price}}" now; template-only, three whisper sites, pinned by
`tests/oneshot-fallback-copy-patches.test.ts`),
`clever-spoke-check-unclaimed-patch.ts` +
`patch-clever-spoke-check-unclaimed-leads.ts` (Aug 10 2026: the spoke check's
second trigger, see Sharp edges),
`amy-clever-sweep-no-status-change.ts` +
`amy-clever-sweep-no-status-change-definition.ts` (Aug 18 2026: the weekly
sweep posts "No Status Change", the only status Clever offers at every stage,
see Sharp edges),
`amy-clever-weekly-update-sweep.ts` +
`amy-clever-weekly-update-sweep-definition.ts` (Aug 17 2026: repoints
the weekly sweep at the real sender, separates the two flows by needle, and
adds the capacity alert; see Sharp edges),
`amy-clever-sweep-measured-alert.ts` +
`amy-clever-sweep-measured-alert-definition.ts` (Aug 19 2026: the alert reads
the chained sweep's measured `update_each_updated`/`update_each_left` vars
instead of backlog-minus-6 arithmetic, and the `sweep_remainder` math step is
removed; a clean sweep of any backlog stays silent; see Sharp edges),
`amy-clever-sweep-classify-select.ts` +
`amy-clever-sweep-classify-select-definition.ts` (Aug 19 2026: the sweep
answers the classification select, optional so cards without it keep working;
see Sharp edges),
`amy-clever-sweep-rerun.ts` (Aug 19 2026: replays the most recent weekly
reminder's trigger as a fresh queued run, so the week the chaining shipped
got finished instead of waiting for Clever's next text; refuses when a run is
active or the source is older than 48h, since the magic link dies in under a
day).

Unowned-lead recovery (Aug 15 2026): `amy-unowned-lead-team-alert.ts` texts
the lead-type-tagged team about ONE unowned lead by hand, using the same
selection rule as the dispatcher fix that shipped alongside it (active,
`team_broadcast_enabled` not false, has a phone, tag match, and a tag matching
nobody widens to everyone). It exists for leads already stranded by the old
owner-direct behavior; carries no customer PII (every lead detail is an
argument) and skips a recipient who was already alerted about that lead, so a
re-run converges. Applied once, Aug 15 2026, for a Clever seller whose two
`notify_team` alerts had both gone to Amy alone. See Sharp edges.

Unreachable-lead guard (Aug 15 2026): `amy-unreachable-lead-team-alert.ts`
inserts a `<prefix>_no_phone_guard` branch into all four ARRIVAL flows (Clever
Lead - Accept, ReferralExchange Lead, Realtor.com Lead, New Lead Intake), right
after the step that extracts the lead. When `lead_phone` carries no "+", the
lead-type-tagged team is alerted via `notify_lead_owner` +
`unownedFallback: "team"`. Purely additive: ReferralExchange and New Lead
Intake keep their existing owner-addressed `notify_no_phone` steps, so Amy
loses no notice she gets today. Pinned by
`tests/amy-unreachable-lead-team-alert.test.ts`, which asserts the copy only
uses vars each flow really produces. Applied to all four, Aug 15 2026.
`--revert --apply` restores the exact previous definitions from the ledger.

**Superseded the same day by `amy-unreachable-lead-claim-offer.ts`**, which
turns that alert into a real `route_to_team` claim offer (`broadcastAll` +
`teamTagTemplate`), so "1" claims it exactly like every other team text. The
guard's condition is untouched; only its consequence moved. Brian, Aug 15
2026, after a teammate replied "1" to the alert 57 seconds after it landed and
the claim machinery had nothing to attach it to: "Can we allow for both?" Two
things it cannot do, both inherent rather than defects: ownership is keyed on
the lead's phone, so a claim here sets `claimed_agent` but stamps no
`contacts.owner_employee_id` (there is no contact row without a phone), and
the owner-addressed `notify_no_phone` steps on ReferralExchange and New Lead
Intake are still left alone.

Other networks: `seed-referralexchange-aiflow.ts`,
`amy-referralexchange-weekly-reminder.ts` +
`amy-referralexchange-weekly-reminder-definition.ts` (Aug 18 2026: the RE
update also schedules RE's own text reminder 7 days out, so a referral stops
going quiet after arrival day, see Sharp edges),
`amy-referralexchange-update-honesty.ts` +
`amy-referralexchange-update-honesty-definition.ts` (Aug 17 2026: the posted
ReferralExchange status stops saying "no interaction yet" after an answered or
transferred AI call, see Sharp edges),
`realtor-retrigger-guard.ts`,
`homelight-dedupe-and-price-digits.ts` (Aug 11 2026: the duplicate-run and
`price_digits` fixes, see Sharp edges),
`seed-amy-homelight-feedback-request.ts` +
`amy-homelight-feedback-request-definition.ts` (Aug 18 2026: gives HomeLight's
feedback number a named owner so it stops reaching the general assistant, see
Sharp edges),
`amy-homelight-portal-note.ts` +
`amy-homelight-portal-note-definition.ts` (Aug 19 2026: after the HomeLight
Referral flow works a lead, it now posts a progress note on the agent
dashboard's drawer, the honest `actions_taken` wording, via a templated
`click_text "{{vars.lead_name}}"` row click; selectors and the reasoning live
in [homelight-flow.md](homelight-flow.md), pinned by
`tests/amy-homelight-portal-note.test.ts`),
`amy-homelight-integration-label.ts` (Aug 17 2026: repoints all ten HomeLight
browse steps from the `Home Light` credential label to `HomeLight` after the
row was renamed, see below) over the pure builder
`amy-homelight-integration-label-definition.ts` (pinned by
`tests/amy-homelight-integration-label.test.ts`). HomeLight's others are listed in
[homelight-flow.md](homelight-flow.md).

Portal credentials (Aug 17 2026). All four of this account's
`custom_integrations` rows were exercised end to end through the render sidecar
with `tsx debug/portal-dom-probe.ts`, a read-only prober added the same day.
What it found is worth knowing before touching any browse step here:

- **Renaming a credential label breaks every flow that names it.** The lookup
  is `ilike` on the trimmed label: case-insensitive, NOT space-insensitive. The
  `Home Light` -> `HomeLight` rename orphaned ten live steps in one edit. See
  the sharp edge in [homelight-flow.md](homelight-flow.md).
- **HomeLight's stored secret can never authenticate anything.** Its agent
  portal has no password form at all (sign-in is passwordless), so
  `looksLikeLogin` never fires and no login is attempted. Every HomeLight
  session comes from the one-time `hmlt.co` link in the inbound SMS: navigating
  to the expanded `agent.homelight.com/referrals/claim?...` URL directly lands
  on a sign-in page. That is a single point of failure with no fallback, and it
  is why a stale link cannot simply be re-fetched.
- **Clever is the same shape, deliberately or not.** Its magic links expire in
  well under 24 hours, and password login through the sidecar fails (see the
  render-service login fix, same date). The daily and weekly flows work only
  because they consume the SMS link promptly.
- **Referral Exchange and Realtor.com both log in with the stored password.**
  Realtor.com takes ~46s to render `dashboard.realtor.com/contacts` (a 1.7MB
  page), which is uncomfortably close to the ~100s Cloudflare edge ceiling the
  tunnel imposes, so it must never be used for a multi-page `forEachLink` sweep.

Speed-to-lead (Aug 8 2026): `amy-speed-to-lead-definition.ts` (pure
builders) driven by `amy-speed-to-lead-patch.ts` (same mechanics: dry-run
default, per-flow `--only`, `--revert` from the ledger's stored previous
definition). Normal seller leads stopped being pinned to Dave: the claim
offer now goes to Gabrielle Mota, Amy, and Dave SIMULTANEOUSLY
(`agentNames` broadcast, one shared deadline, "First to reply 1 gets it.")
on Clever Lead - Accept, ReferralExchange route_seller/route_both, and New
Lead Intake route_seller/route_both; HomeLight's existing Dave-and-Amy
broadcast gained Gabrielle. The reach ladder on Clever's ai_call steps
became [Dave, Gabby, Amy] with `rotateFirst: 2`: Dave and Gabby take turns
ringing first call by call (cursor:
`ai_flow_team_members.last_reach_first_at`), Amy stays the last resort,
and the post-call summary follows whoever rang first
(`notifyFirstReachTarget`). The Clever spoke check swapped its Dave pin
for `agentNameVar: "spoke_owner"` (extracted from the owner_assigned
notice), so the day-3 "did you speak with them?" question reaches whoever
actually claimed the lead; runs already parked in the 3-day grace at apply
time never extracted the var and cascade to owner fallback for up to ~3
days, by design. Still Dave by static ref, deliberately out of scope: the
spoke check's WEEKLY calls' `transfer.toRef`/`notifyRef` (no dynamic
transfer-ref mechanism exists yet). The offers must stay `agentNames`:
`broadcastAll` would silently exclude Amy (`team_broadcast_enabled`
false), and broadcast name matching is full-name ("Gabrielle Mota";
"Gabby" reaches nobody).

Seller auto-call (Aug 7 2026): `amy-seller-ai-call-definition.ts` (pure
builders) driven by `amy-seller-ai-call-patch.ts` (idempotent, dry-run by
default, `--revert` restores the exact previous definition from the ledger).

**Only the Clever half of this is live.** The builder carries a
ReferralExchange variant and the intent was both seller sources, but the ledger
shows the patch applied twice, 2026-08-07 at 20:17 and again at 22:48, both
times against `Clever Lead - Accept` alone. The live `ReferralExchange Lead`
definition still has zero `place_ai_call` steps (verified Aug 11 2026), so a
ReferralExchange seller gets the intro SMS/email and the team offer and no AI
first contact at all. Closing it is a `--only "ReferralExchange Lead"` run, not
new code. Read the rest of this paragraph as the DESIGN, not as production.

On Clever, where it did land, the AI owns FIRST contact: it dials the seller
within a minute of the lead landing (skipping $1M+ leads, which stay with
Amy), pitches the listing with Amy's approved script (the Clever variant
carries the cash-offer angle and a new `cash_offers` extraction field copied
verbatim from the spoke check; ReferralExchange does not), then the flow
continues to the unchanged `route_to_team` chain so Dave still owns the
follow-up. Misses redial at +2h and next morning at 08:30, both inside
08:30-21:00 Phoenix with `outside: "skip"` so an overnight lead never parks
the run, and every rung stops the moment anyone claims the lead or the
seller replies or books (`lead_reached` goal). The same patch sweeps the
"best time to reach them" capture field out of New Lead Intake: Amy's rule
is that nobody ever asks a lead when to call back. Since Aug 7 2026 the
call steps carry `reachTeammate` (Dave, then Amy, 20s each) instead of the
single-target transfer: the AI keeps the seller talking while each phone
rings on a second leg and bridges only a genuine answer
(`upgradeCallsToReachLadder` swapped the already-live Clever flow in
place). Team offers now say what
the AI already did (`actions_taken`), how the call went
(`call_outcome_label`), and what the ladder does next, with the schedule
sentence generated from the same constants as the sleeps so copy and
behavior cannot drift apart.

Voicemails (Aug 11 2026): `amy-voicemail-scripts.ts` gives all 13
`place_ai_call` rungs a `voicemailTemplate`, so a lead who never picks up now
hears from us instead of only being texted. Before PR #1297 the engine hung up
on an answering machine and there was no field to put a message in.

- **A voicemail nobody DETECTS is worse than one nobody answers, and carrier
  AMD misses them.** The outcome of an AI call is derived from whether a
  machine was detected, and the cadence's follow-up text is gated on
  `call_outcome equals no_answer`, so an undetected voicemail records
  "spoke with them", sends no text, stops the ladder, and parks the run for
  three days waiting on a reply that cannot come. Three calls landed that way:
  a Mesa seller on Aug 14 (premium AMD returned `human_business`), Jim
  Inderberg on Aug 17 (`human_residence`: a personal greeting is one human
  voice, which is exactly what that class sounds like), and Jennifer Kline on
  Aug 17, where AMD was RIGHT and the greeting-end handler cancelled the
  correct verdict (see homelight-flow.md's note on `prompt_ended`). Two of the
  three are carrier AMD simply being wrong, which no code change removes. The
  assistant now has its own way to say so: a `voicemail_reached` tool that
  records the machine verdict on the call and hands back the step's authored
  script to read. The three already-broken calls were corrected by
  `amy-voicemail-misrecorded-calls.ts`, which stamps the call records and
  texts Amy the three names to call back. It deliberately does NOT resume the
  runs: two were `done` and the third was parked mid-cadence, and rewriting a
  live run's vars to re-drive a completed step risks double-texting the very
  leads it is rescuing.

- **HomeLight is absent from that script by design, not by oversight.** It
  places no outbound AI call at all: its AI ANSWERS HomeLight's inbound
  live-transfer call. The "a person is on the line by definition" half of
  that reasoning broke on Aug 16 2026: after the accept keypress HomeLight
  bridges ONWARD to the client's own phone, and Thomas L.'s was off, so the
  AI spent four minutes chatting with his carrier voicemail. The inbound
  intake persona now recognizes carrier announcements ("is not available",
  "please record your message", "at the tone") and leaves ONE scripted
  detail-free message instead (`inboundVoicemailMessageLine` in
  `vps/voice-bridge/src/intake.ts`); outbound calls keep their authored
  `voicemailTemplate` policy. ReferralExchange gets its scripts when it gets
  its call steps.
- **Every rung is worded differently**, because a ladder that redials leaves a
  message each time and three identical recordings from one number reads as a
  malfunction. The Clever accept ladder's third rung and the spoke check's
  eighth say plainly that they are the last, and week 7 warns that one more is
  coming.
- **The copy obeys the account's existing rules and its tests pin all of
  them:** no callback-time question (Amy calls back fast rather than booking an
  appointment to call), no em dashes, no "receptionist", and no price. That last
  one is the same decision `amy-price-every-lead-notice.ts` records: the figure
  is the referral network's estimate, and quoting it back at a seller in an
  unsupervised voicemail is a valuation claim.

Who hears an unowned lead's reply (Aug 12 2026):
`amy-roster-lead-type-tags.ts` writes what each teammate handles onto the
ROSTER (`ai_flow_team_members.tags`), and the cadence's reply notice uses
`notify_lead_owner`'s new `unownedFallback: "team"` with
`teamTagTemplate: "{{vars.lead_type}}"`.

- **The rule was true in exactly one place before this.** "Dave and Gabby for
  sellers, plus Jason for buyers" lived in the two arms of
  "Follow Up Requested (Unclaimed Leads)"; the other twelve route steps knew
  nothing about it and Jason appeared nowhere else on the account. On the
  roster it is one edit when someone joins or changes.
- **Amy is deliberately untagged**, and that is not an oversight. Her row
  already carries `team_broadcast_enabled=false`, which is what keeps her out
  of team alerts; a tag would not change that and would imply she belongs to an
  audience she does not. She stays on the CLAIM OFFERS exactly as the Aug 8
  speed-to-lead patch set them, which none of this touches.
- **A tag matching nobody alerts EVERYONE.** Tags are free text with nothing
  validating them, so the filter fails safe: a typo costs noise, never a lead.
  Same reason an empty render means "no filter" rather than "a tag nobody has".
- **This is an alert, not an offer.** Nobody is asked to reply, no deadline
  runs, and the flow does not park. `route_to_team` with `broadcastAll` is the
  offer-shaped alternative and remains a different thing.

Needs Follow Up cadence (Aug 11 2026): `seed-amy-needs-follow-up-aiflow.ts`
(applier) over `amy-needs-follow-up-definition.ts` (pure builder, pinned by
`tests/amy-needs-follow-up-definition.test.ts`). A lead tagged
"Needs Follow Up" gets an AI call every three days; when nobody picks up the AI
leaves a voicemail and then texts. Three rounds, each worded differently, the
last saying it is the last. The tag comes from a teammate texting `F` (see
`follow_up_reply.ts`) or from any other tagger.

**Amy changed two rules on 2026-08-17, and they are a pair.** A claim no
longer ends the cadence, and the cadence came down from eight rounds to three.
Her words: "if someone claims it and they don't reach them it will work out.
If someone claims it and they do reach them then it can stay on follow up
because it's only three times." Keeping eight rounds while dropping the claim
stop would have kept the AI calling a lead a teammate already owns for over
three weeks, which is not what "only three times" tolerates. Change one and
you have to revisit the other.

Four things worth knowing before touching it:

- **The wait IS the gap between rounds, and that is load-bearing.** The obvious
  build is a `sleep` plus a `goal` on `replied`, and it does not work: a goal's
  reached-marker is `__goal_<id>`, and a `when` guard's var must start with a
  letter, so nothing downstream can branch on whether the goal fired. Since a
  goal step is a JUMP TARGET, the steps after it also run when the ladder
  merely finishes, so an ungated notice would page the team about every cold
  lead: the exact opposite of the ask. `wait_for_reply` saves an ordinary var
  ("no_reply" on timeout, the lead's words otherwise), which is gateable.
- **Later rounds are FLAT branches**, each gated on `lead_reply` still being
  "no_reply", the same shape the Clever spoke check uses. Branch nesting is
  capped at 3 levels, so nested rounds was never an option.
- **`appointment_booked` stays a goal, `claimed` does NOT (changed Aug 17
  2026).** Booking is a milestone nothing in the flow observes, so it jumps the
  run out of a parked wait. A claim used to do the same and no longer does: it
  is a teammate saying they will work the lead, not evidence anyone reached
  them, and ending the follow-up on that promise is what left leads with none.
  The event is business-wide by lead phone (`applyGoalEvent`), so the claim
  that used to end this cadence was usually raised by a DIFFERENT flow's
  `route_to_team`. Re-adding it here hands that power back.
- **Booking is the stop Amy asked for, and on her account it barely fires.**
  `calendar_book_appointment` is off for sms, voice, webchat and email (PRs
  #1153, #1158 and the disable one-shots), on only for dashboard. The goal is
  correct and wired; it just has almost no producer on this tenant.
- **The sign-off copy is selected by POSITION, not index.** `copyForRound`
  gives the LAST round the final entry of `VOICEMAILS`/`TEXTS` whatever
  `ROUNDS` is. Indexing straight by round number is what the 8-to-3 cut would
  have broken: the cadence would have ended on "Want us to send recent sales?"
  and the "this is our last message" wording would never be reached.
- **Calling hours use `outside: "defer"`, and "skip" would break the whole
  feature.** Every round waits exactly 72 hours, so all eight land at the same
  clock time as the first. With "skip" a lead tagged at 2am resolves round 1 to
  `not_placed`, which is not `no_answer`, so the text does not send either, and
  three days later it is 2am again: one unlucky tagging time and the lead is
  never contacted at all. "defer" parks the first round until 08:30 and every
  later round inherits that daytime phase.
- **Shrinking the round count is an index migration, not a config edit.**
  `ai_flow_runs.current_step` is a flat index over the flattened definition, and
  this cadence always has runs parked mid-flight (nine on the day of the 8-to-3
  cut). Removing trailing rounds only truncates the tail, so the prefix holds,
  but prove it rather than assume it: flatten the live definition and the new
  one with the engine's own `flattenSteps` and check the first differing index
  is past the highest live `current_step`. On Aug 17 they matched to index 29
  against a highest live step of 13, so all nine runs stayed on the same step
  and simply finish at the new round 3.
- **A later round stops ONLY when the lead was actually reached**: empty arms
  for `transferred`/`answered` with the work in `else`, the same shape the
  Clever spoke check uses. Both inverses are wrong. Gating only on the reply
  var lets a lead who SPOKE to the AI (possibly to say stop calling) keep being
  dialed; gating on `call_outcome equals no_answer` instead ALSO ends the
  cadence on a transient `failed` or a `not_placed` from the fleet-wide dial
  cap, abandoning a lead nobody ever reached because one dial did not go out.
- **The reply notice sits INSIDE each round, right after that round's wait.**
  One notice at the end gated on `lead_reply notEquals "no_reply"` looks
  equivalent and is not: a missing var reads as "", which is also not equal to
  "no_reply", so the guard PASSES. A `claimed` jump during the very first call
  would have sent the owner a "they came back to us" notice quoting nothing,
  for a lead who never said a word.
- **The unclaimed half of Amy's notify rule is faithful now, on both paths.**
  `notify_lead_owner` resolves the owner at RUN TIME (so a lead claimed
  mid-cadence reaches the right person, which a var read at step 0 could not
  do). With no owner it broadcasts to the tagged team via
  `unownedFallback: "team"` + `teamTagTemplate`, and the URGENT-ALERT
  dispatcher does the same as of Aug 15 2026 (see the sharp edge on the
  unowned alert ladder). Both call one selector,
  `supabase/functions/_shared/team_broadcast.ts`, so they cannot drift.
  This is still an ALERT, not an offer: `route_to_team` broadcasts a claim
  offer with a deadline and a fallback, which remains a different thing.

ReferralExchange on the AI worker (Aug 11 2026):
`referralexchange-ai-first-contact.ts` (applier, `--revert` restores the exact
previous definition) over `referralexchange-ai-first-contact-definition.ts`
(pure builder, pinned by `tests/referralexchange-ai-first-contact.test.ts`).
The AI now calls a ReferralExchange lead BEFORE the team is offered it, the way
Clever and HomeLight already work. 23 steps to 25.

- **All three lead types, each with its own script.** ReferralExchange delivers
  buyer, seller and both, unlike the seller-only sources, and the existing
  `amy-seller-ai-call-definition.ts` ReferralExchange variant is seller-gated,
  so it could never have covered this.
- **This is the ONE place the callback-time question is allowed.** The standing
  rule is that we never ask a lead when to call back, and Aug 7's
  `removeBestTimeCaptureField` swept it out of New Lead Intake. Amy narrowed
  the rule on Aug 11: it is fine in the single moment where the lead ASKED to
  be connected and nobody picked up. `captureFields` cannot be conditional, so
  the SCRIPT carries the condition, and the tests assert both halves of it.
- **A no-answer hands the lead to the cadence by TAG**, not by repeating a
  ladder here. `update_contact` adds "Needs Follow Up", the same chokepoint the
  `F` reply and the tag editor use, so there is one follow-up sequence and one
  place to change it. Since Aug 12 the tag step also carries
  `noteTemplate: AUTO_TAG_NOTE` ("auto_first_contact: ..."), which rides the
  tag event's note line: the cadence extracts it as `tag_auto` and skips round
  1's call when it sees it. Without the marker, Jessica Gutierrez got the
  first-contact call at 6:30pm and the cadence's round-1 call at 6:32pm, two
  voicemails in two minutes. A manual tag (teammate `F`, dashboard editor)
  carries no note, so it keeps the immediate call a human asking for follow-up
  expects. The marker string is a lockstep copy in both builders, asserted
  equal in `tests/amy-needs-follow-up-definition.test.ts`.
- **The script arms gate on `route_lead_type`, not `lead_type`.** Both exist on
  this flow and only one says anything about REACHABILITY: `route_lead_type` is
  "the page shows a text or call option, meaning the lead has a real phone
  number, and here is the type", answering "none" for an email-only lead.
  Gating a DIAL on `lead_type` validates fine and then tries to call leads with
  no phone. It is also the field the three route steps already gate on.
- **First contact carries NO `callWindow`**, matching Clever's attempt-1 dial.
  A window with `outside: "skip"` resolves an overnight lead to `not_placed`,
  which is not `no_answer`, so the follow-up tag never fires either and the
  lead misses both the AI call and the cadence. Only RETRY rungs get windows,
  because a redial is the thing that must not land at 3am.
- **`captureFields` are not flow vars.** `place_ai_call` produces its outcome
  var and the two companions and nothing else; what the AI collected rides the
  POST-CALL SUMMARY to whoever the ladder rang first
  (`notifyFirstReachTarget`). Templating `{{vars.timeline}}` into an offer
  would be rejected by the authoring validator, and would render empty if it
  were not. The offers therefore quote `call_outcome_label` and point at the
  summary.

Broadcast copy and Realtor.com (Aug 12 2026):
`amy-broadcast-realtor-and-offer-copy.ts`. Amy, pointing at a Clever offer:
"why was this lead not broadcasted then?"

- **It WAS.** That run's own outcome line reads "offered simultaneously to
  Gabrielle Mota, Amy Laidlaw, Dave Lane, first to claim". What she was reading
  is the offer COPY, which still ended "or it goes to the next agent": wording
  left behind when `amy-speed-to-lead-patch.ts` converted that step from a
  rotation to an `agentNames` broadcast on Aug 8. The same message already said
  "First to reply 1 gets it" three lines later, so it contradicted itself and
  the stale half read like a cascade. **An audit of all eleven live route steps
  found Clever was the ONLY broadcast still saying it**; the three rotation
  offers say it correctly, because for them it is true.
- **Realtor.com was the only real routing gap.** Its single route has NO
  lead-type gate and was still a rotation, so any SELLER arriving through
  Realtor.com would have been round-robined. It now broadcasts to the same trio
  every other seller route uses, and its copy gained the first-to-claim line.
- **Buyer routes are deliberately untouched.** Amy: "Do not change buyer
  leads." New Lead Intake `route_buyer` and ReferralExchange `route_buyer` keep
  their rotation AND their "next agent" wording, which is accurate for them.
  Broadcasting those would text three people for every buyer lead, a cost she
  weighed and declined the same day. **Superseded for Realtor.com on Aug 14**
  (`amy-realtor-buyer-rotation.ts`, below): its buyer half is a rotation again,
  Jason included. The seller broadcast is exactly as this patch left it, and
  the other two buyer routes still are.
- **Check the COPY when you change routing.** This is the second time a
  behavior change left its description behind (the first was the dossier's own
  claim about the seller AI-call). A run's outcome line is the source of truth
  for what happened; the offer template is just what somebody wrote.

HomeLight contact reveal (Aug 12 2026): `homelight-contact-reveal.ts`. Amy:
"it broadcasts the lead to everyone but we never have the contact information
or the price." FOUR causes, found by reading Kevin Duford's run (`85d1bd1f`)
against the portal screenshot she sent.

- **OUR OWN CLAIM READ AS A RIVAL'S, and this was most of it.** The portal
  renders one flat `Claimed By: <name>` row whether the claimer is this team or
  another agency, and `already_claimed` asked whether it was "claimed by ANOTHER
  agent". On Kevin's run the card said `Claimed By: Amy Laidlaw`, the model
  answered `yes`, the flow took the we-lost-it path, and **39 of 61 steps were
  skipped**: `save_contact`, `to_agent`, `qt_email`, `lead_sms`, `lead_email`
  and `notify` all never ran. The question now names the team, so our own claim
  reads as ours. It names the TEAM rather than four individuals, because a
  roster list in a prompt goes stale the moment somebody joins.
- **The email was never read unless somebody had already claimed**, which is
  backwards: the team needs the details in order to DECIDE whether to claim.
  Fixed with a SEPARATE `unclaimed_email_read` step, and `email_card` KEEPS its
  gate. Dropping that gate is the obvious move and is wrong: the late-retry
  ladder gates on `contact_status equals missing`, and that is only a claim
  gate BECAUSE `email_card` never ran for unclaimed leads. Ungating it walks
  unclaimed leads into `late` / `late2`, where every delivery step addresses
  `{{vars.claimed_agent_phone}}` and there is no claimer. The new step copies
  email_card's connection and matching so the two cannot drift, and carries
  `fillOnlyEmpty` so it never overwrites an earlier read.
- **No price from the email.** The alert says "$560K", the email says
  "$560,000" plus the timeframe. `email_price`, `email_timeframe` and
  `email_summary` are read on all three passes (`email_card`, `late_read`,
  `late2_read`), so the retry rungs that already handle HomeLight's delay carry
  them too.
- **Revealed details reached nobody on an unclaimed lead**, since every
  contact-info text addressed `{{vars.claimed_agent_phone}}`.
  `late_unclaimed` is ONE top-level branch holding the whole unclaimed tail:
  an immediate alert, then two more mailbox reads at 15 and 60 minutes, each
  followed by its own alert.

  Four things about it are load-bearing. **It retries**, because HomeLight's
  reveal is delayed and the claimed path's late rungs gate on `contact_status`,
  which only the claimed read sets, so a single unclaimed read finds nothing
  and nothing looks again. **Every wait and re-read is gated on the previous
  read NOT having answered "found"**, so it delivers the moment details land:
  an unconditional sleep made the team wait the full 75 minutes even when the
  FIRST read already had the number. (As built on Aug 12 the rungs gated on
  `equals "missing"`, which never fired: `email_extract` writes NO vars when
  the mailbox has no matching message, so the status was unset, not
  "missing", and the ladder silently skipped. Both Aug 16 runs hit it.
  `homelight-verified-claim.ts` re-gated the rungs on `notEquals "found"`;
  see homelight-flow.md.) **Each read has its OWN status var**
  (`u1_status`, `u2_status`, `u3_status`), mirroring
  contact_status/late_contact_status/late2_contact_status, because the reads
  carry `fillOnlyEmpty` and a shared status written "missing" could never be
  updated to "found". **It is nested**, because definitions cap TOP-LEVEL steps
  at 30 and this flow is near it: the flat version was rejected by the
  validator before anything was written.

Two things deliberately NOT done:

- **A screenshot of the email is not possible.** `attachScreenshot` attaches a
  BROWSE screenshot; nothing screenshots an email. The full client-details
  block is captured as text into Amy's QT email instead, which carries
  everything an image would and is searchable in her inbox.
- **The failed live transfer is not made to look recoverable.** HomeLight
  reveals details ONLY after a successful transfer or a connected call, so when
  a seller hangs up before connecting, none are ever coming.
  `late2_never_agent` now says that outright rather than implying the wait
  continues.

Who owns the lead, in Amy's own emails (Aug 12 2026):
`amy-owner-in-lead-emails.ts`. Five emails to amy@amylaidlaw.com never said who
took the lead, and all five sat BEFORE their flow's `route_to_team`, so no
template could have shown it from where they stood: Clever `qt_email`,
Realtor.com `s2`, and ReferralExchange `email_buyer` / `email_seller` /
`email_both`. They now sit after the route and carry
`Lead owner: {{vars.claimed_agent}}`.

- **HomeLight was the model, not an exception.** Its `qt_email` already sat
  after the route and already opened "HomeLight referral claimed by ...". The
  other four had simply never caught up.
- **On Clever the delay can be the NEXT DAY, and that is an accepted trade.**
  The goal anchor also sits after `call_followups`, the redial ladder that
  sleeps two hours and then until morning, so an unclaimed no-answer Clever
  lead's QT email can arrive the following day. Amy chose this on Aug 12 2026
  with the alternative in front of her: anchoring on the route sends promptly
  but skips the email entirely for any lead who engaged during the AI call, and
  a late email beats a missing one. Realtor.com and ReferralExchange have
  neither a goal nor a ladder and wait only for the claim window.
- **The cost is real and worth knowing:** these emails now wait for the claim
  window instead of sending on arrival. A lead claimed quickly (the common case
  on this account, and the point of speed-to-lead) delays the email a minute or
  two. A lead NOBODY claims delays it by the full ladder, roughly ninety
  minutes: a 10 minute offer, three 20 minute reminder rounds, then the owner
  fallback.
- **Deliberately NOT copied from HomeLight:** its `qt_email` is gated on
  `claimed_agent notEquals none`, so an unclaimed HomeLight lead sends Amy no
  QT email at all. These stay ungated, because a lead nobody claimed is the one
  she most needs to see. The owner line reads "none" rather than the mail
  silently not arriving.
- **`claimedNotifyEmail` was already set** to amy@amylaidlaw.com on all four
  route steps, so she was already getting a SEPARATE claim email. This puts the
  fact in the lead email itself rather than leaving her to cross-reference two.
- **The anchor is the last top-level GOAL when a flow has one**, not merely the
  last route, and on Clever that is the whole ballgame. Its ladder parks in
  `ai_call_1` BEFORE the route, and `lead_reached` (replied /
  appointment_booked) sits after it, so a lead who replies or books DURING that
  call jumps straight to the goal and skips everything in between. Anchoring on
  the route would have put the email in the skipped span: Amy would have got no
  QT mail for exactly the leads who engaged, the best ones, silently. A goal is
  a jump TARGET, so steps after it run on both paths.
- Failing that, the last route step, not the first: ReferralExchange has three
  gated by lead type and only one fires, so after all of them is the only
  position from which the claim is known whichever arm ran.
- **The owner line explains its own blank.** On the goal-jump path the route
  never ran, so `claimed_agent` is UNSET rather than "none", and `send_email`
  renders with plain `renderTemplate` and no `collapseEmpty`: a bare
  "Lead owner:" would be the same dangling-label trap the price and address
  work hit twice. The label says what a blank means instead.

Notice content: `set-amy-lead-address-in-notices.ts`,
`amy-lead-price-in-notices.ts` (Aug 7 2026: Clever never extracted a price at
all, only the over/under-$1M routing token, so no Clever notice could show
one; Realtor.com had the figure but only on some of its notices. Both were the
same shape as the address gap #1202 closed. Watch the collapseEmpty trap
documented in both scripts: route_to_team templates render with no
collapseEmpty, so any price var must extract with a "none" fallback or a
teammate gets a bare "Price:" label).

`amy-price-every-lead-notice.ts` (Aug 11 2026) finishes that job across the
whole account: 47 templates on all seven lead flows, so every team-facing text
about a lead carries the figure. The Aug 7 script had patched the two flows Amy
happened to have a notice from, which left the same partial coverage everywhere
else: 15 `claimedNotifyTemplate` / `ownerFallbackTemplate` where the offer named
the price and the "you got it" / "nobody took it" follow-ups did not, all 13
`unclaimedReminders.detailsTemplate`, and the AI-call gap/failure alerts, the
late-contact notices and every `bp_forward` relay. Four things worth knowing
before touching it:

- **Its per-flow target lists are exhaustive on purpose**, naming templates that
  already carry the price as well as the ones that did not. Nothing is patched
  twice (see the next point), so the lists double as a standing assertion of
  coverage, and a step id that disappears aborts the run rather than repeating
  the three-quarters-applied outcome the tool-toggle policy had.
- **Presence is tested on the price VAR, not on a "Price:" line.** Most of these
  notices state the figure in prose ("(~{{vars.price}})", "in Mesa, around
  {{vars.price}}"), so the Aug 7 script's exact-line test would have added a
  second labelled copy underneath the sentence. The dry run is what caught it.
- **Two flows had no price to template, so the script adds the extraction
  first.** Clever Spoke Check browses the SAME Clever lead page the accept flow
  does, so its `read_page` gets the identical field, worded verbatim from
  `CLEVER_PRICE_FIELD`. Follow Up Requested reads a contact-event or Amy's
  Run-now text and usually has no figure, so its field answers "none" more often
  than not; a real figure there would mean recalling and browsing the lead page
  on a same-day urgent path, deliberately not done.
- **Lead-facing copy is deliberately untouched.** None of the 15 SMS bodies
  addressed to a lead carries a price, and that is a decision, not a gap: the
  figure is the referral network's estimated home value, and quoting it back at
  a seller is a valuation claim sitting directly beside Amy's own "I have an
  appraiser to price your listing with precision" pitch.

The same PR fixed the guard that should have caught the reminder gap:
`unclaimedReminders.detailsTemplate` was missing from `templateStringsForStep`
in `src/lib/ai-flows/schema.ts`, so alone among outbound templates it was never
scope-checked, and a var no step produced would have rendered as a bare label on
every nudge with nothing flagging it at author time. It also fixed `--revert` on
`amy-seller-ai-call-patch.ts` and `amy-speed-to-lead-patch.ts`, which filtered
the ledger on a `script_path` column that does not exist (it is `script`, the
basename), so both rollbacks exited 1 on a PostgREST error instead of restoring
anything.

Show the team what the lead said (Aug 10 2026): the same
`amy-unclaimed-reminders-patch.ts` also sets `shareContactHistory` on all 13
route steps. A teammate used to see structured fields plus a status label
("The call: spoke with them") and never a word the lead actually said, so an
ask the AI agreed to on their behalf never reached the person who had to honor
it. Daniel Villanueva, Aug 7: he asked on the call for comparables by email and
a Monday conversation, and Dave's offer text carried none of it.

Now the lead's OWN words ride along: a short excerpt appended to every offer
(2 lines) and a fuller one texted to whoever claims it (4 lines). Three things
worth knowing:

- **The claimer used to be told nothing at all.** The owner got a claim notice,
  the losing offerees got a courtesy note, the claimer got silence. The history
  text is the first message the platform sends the person who took the lead.
- **It reads `voice_call_transcript_turns` where `role = 'caller'`, NOT
  `voice_call_transcripts.summary`.** The summary is written by a five-minute
  sweep and only for standard/enterprise tenants, so it is empty exactly when a
  just-finished call matters most; the turns are written live by the bridge.
  `_shared/ai_flows/contact_said.ts` is the first edge-side reader of that table.
- **Only the lead's side is shown, never our outbound.** That is the deliberate
  difference from `_shared/contact_context.ts`, which is model-facing and
  includes our own sends. Per-call the last three substantive caller turns are
  kept, dropping two-word pleasantries, because a lead states what they want at
  the END of a call ("Thank you." must never displace the ask).

Unclaimed-lead reminders + claim by name (Aug 10 2026):
`amy-unclaimed-reminders-patch.ts` (applier, `--revert` strips both back off)
over `amy-unclaimed-reminders-definition.ts` (pure builder, pinned by
`tests/amy-unclaimed-reminders.test.ts`). Turns on `unclaimedReminders`
(3 rounds, 20 minutes apart) for all 13 `route_to_team` steps across her seven
lead flows, so a lapsed offer nudges the SAME teammates three more times
before Amy inherits it, one interval after the last round. Two behaviors worth
knowing before touching this:

- **Reminders fire on silence only.** An explicit "2" from every teammate is a
  decision, so the everyone-passed path still hands the lead over
  immediately. Only a timeout (or an exhausted rotation) starts the ladder.
- **Reminders are compact by design and never re-send the offer body.** Her
  Clever offer is the full referral blob, roughly ten billed SMS segments;
  re-sending it three more times per recipient would quadruple the messaging
  cost of every unclaimed lead. Each step carries a short `detailsTemplate`
  instead, built from vars that flow actually produces (the schema rejects a
  template naming a var no earlier step writes, which is the guard that will
  catch you if you copy one flow's line into another).

The same PR changed the CLAIM REPLY fleet-wide, not just for Amy. A teammate
holding two or more live offers used to have a bare "1" resolve to whichever
run row was touched most recently, which is usually but NOT always the newest
offer (an escalation re-park or quiet-hours deferral moves an older run to the
front), with nothing texted back to say which lead they got. Now a bare "1"
with several pending asks which one, and `"1, <name>"` picks by partial name
match (accents folded, first name or surname both work) with a confirmation
text naming the lead. The suffix falls through to the ETA parser when it
matches no lead, so `"1, 20 min"` is unchanged. Before this, `"1, Daniel"` was
silently stored as an ETA and texted to Amy as `ETA to contact lead: Daniel`,
and its non-empty suffix also switched off the first-to-claim yank.

Follow-up requests (Aug 10 2026): `seed-amy-followup-request-aiflow.ts`
(applier) over `amy-followup-request-definition.ts` (pure builder, pinned by
`tests/amy-followup-request-definition.test.ts`). Seeds the
"Follow Up Requested (Unclaimed Leads)" flow after a Clever seller's Friday
"email me comparables, talk Monday" reached Monday with the lead unclaimed
and nothing scheduled: the spoke check's unclaimed track (above) starts at
acceptance with a 3-day grace and no backfill, so day-of commitments and
already-sitting leads had no home. Entry is the "Follow Up Requested" tag
(tag_changed, added) on the day the follow-up is due, or a manual Run now
whose input text carries name/phone/type/context. Seller and both-type leads
broadcast to Dave + Gabrielle, buyers add Jason, Amy stays out of the race
(her roster row has routing_enabled=false) and is the owner fallback. A claim
auto-assigns the owner, which chains into the spoke check's weekly track for
Clever-tagged leads: intended. The offer SMS uses *asterisk* emphasis on the
header, "today", and the reply digits, per Amy's ask.

Realtor.com buyer round robin (Aug 14 2026): `amy-realtor-buyer-rotation.ts`,
pinned by `tests/amy-realtor-buyer-rotation.test.ts`. Brian, reading Carlos
Gonzalez's run (`86383e8c`): "Why isn't Jason getting offered this buyer lead
too? Not simultaneously but round robin for buyer."

- **Jason could never be offered a Realtor.com lead.** The flow has exactly ONE
  team-routing step, and the Aug 12 patch above made it an `agentNames`
  broadcast to the seller trio. His only other appearance in a route step on
  this account is the buyer arm of "Follow Up Requested (Unclaimed Leads)". The
  roster was never the blocker: his row is active, `routing_enabled=true`, and
  tagged `buyer`.
- **`route_to_team` has no tag filter.** The roster tags
  (`amy-roster-lead-type-tags.ts`) feed `notify_lead_owner` team alerts and
  nothing else. Tagging somebody "buyer" does not put them in a race; a
  rotation's only subset controls are the roster's own switches (active,
  `routing_enabled`, time off, schedules).
- **`s4` is now an `rt_route_gate` branch** in the same trunk position: arm
  `rt_rg_buyer` (`lead_type` equals "buyer") holds the new `s4_buyer`, and the
  else holds `s4` unchanged. A step `when` carries ONE condition and the seller
  path needs two (not a buyer, not AI-gated), which is why this is a branch and
  not two gated steps: the same shape `re_seller_gate` and `nli_seller_gate`
  already use.
- **The buyer step names NOBODY.** A rotation resolves the roster per run, so
  the race is Dave + Gabby + Jason today and whoever carries `routing_enabled`
  tomorrow. A new hire with lead rotation on joins buyer leads with no flow
  edit; the script's pre-flight lists anyone eligible beyond the expected trio
  so it is at least visible at apply time. Amy stays out of the race and stays
  the owner fallback through `routing_enabled=false`, untouched.
- **`lead_auto_assign` becomes load-bearing the moment a step stops
  broadcasting.** Broadcast deliberately ignores it; rotation honors it and
  would HARD ASSIGN buyer leads ("it's yours, no reply needed") instead of
  offering them. It is false on this account, and the script aborts if it is
  ever true.
- **Both routes keep `price_gate notEquals "ai"`**, so the under-$500K
  AI-owned gate outranks either path, including a self-contradicting
  extraction: `price_gate` "ai" with `lead_type` "buyer" offers nobody, exactly
  as before.
- **Rotation is slower, and that is what "not simultaneously" costs.** 10
  minutes per teammate in turn, then the 3-round, 20-minute reminder ladder
  over everyone already offered, then Amy: up to roughly 90 minutes, against 10
  plus the ladder while it was a broadcast. It is the same shape the
  ReferralExchange and New Lead Intake buyer routes already run.
- **Copy moved with the routing**, the third time of asking on this account.
  The rotation offer regains ", or it goes to the next agent" and loses "First
  to reply 1 gets it"; the broadcast keeps first-to-claim and its title stops
  calling every Realtor.com lead a buyer. **The offer copy now lives in TWO
  steps**: a later script that rewords `s4` has to reword `s4_buyer` too.
- **This supersedes the Aug 12 "buyer routes are untouched" line for
  Realtor.com only.** New Lead Intake and ReferralExchange `route_buyer` are
  still exactly as Amy left them.

Account-level: `seed-amy-new-lead-intake.ts`,
`backfill-amy-lead-stages.ts`,
`disable-amy-voice-booking.ts` (Aug 3 2026: voice stops booking, see Sharp
edges), `disable-amy-customer-booking.ts` (Aug 3 2026: finishes the same
policy on webchat + email; dashboard stays on by design),
`set-amy-claim-notify-email.ts`, `set-amy-roster-availability.ts`,
`set-amy-lead-address-in-notices.ts` (Aug 5 2026: the property address in every
team-facing notice on all six lead flows, see Sharp edges),
`patch-amy-sms-handoff-and-emoji.ts`,
`patch-amy-handoff-single-alert.ts` (step 3 rewrite: notify_team OR reasoning
handoff, never both for one request; the Jul 28 block's "and/or" double-paged
the claimed agent on four leads Jul 30-31),
`update-dave-routed-aiflows.ts`, `add-price-band-routing.ts`,
`add-bad-phone-agent-report.ts`, `enrich-owner-notify.ts`,
`fix-staff-contact-rows.ts`, `strip-em-dashes-flows.ts`,
`recover-amy-biennial-switch.ts`,
`rename-phone-named-gate-fields.ts` (also touches KYP; renames the gate fields
that the phone-field validator was clobbering, see Sharp edges).

## Billing

Switched monthly -> Standard biennial on Jul 28 2026. The switch's Hostinger
purchase "failed but charged" (HTTP 402 while the order completed server-side
about a minute later), the orchestrator aborted, and the recovery was applied
by `scripts/oneshot/recover-amy-biennial-switch.ts`: the paid 2-year box was
adopted directly and the plan bookkeeping completed manually.

**The switch changed her box id**, which is the part that catches people out
later. A term change buys a NEW machine rather than re-terming the old one, so
`1800980` (monthly, provisioned Jul 5) became `1863856` (biennial, adopted Jul
28). Same cutover shape as KYP and Scar Fairy; Amy's was the first, which is
how her Identity row went a week pointing at the wrong box. Read
`businesses.hostinger_vps_id` rather than this file when it matters.

The old box was returned cleanly: `vps_inventory` has `1800980` as
`state=available` with no assigned business, and Hostinger has it `suspended`
with its subscription `cancelled`, `is_auto_renewed=false`, `next_billing_at`
null. Nothing is still being charged for it.

One wrinkle it leaves behind: its `vps_ssh_keys` row is still unrotated under
Amy's `business_id`, so tooling that iterates BOXES rather than tenants still
lists it under her name. `debug/update-all-vps.ts` (chat-worker) is the one
that does, deliberately, and it will now fail to SSH a suspended box and report
that per box. The per-tenant sidecar sweeps are unaffected: they resolve
through `getActiveVpsSshKeyForBusiness` / `newestKeyPerBusiness`, which pick
the newest row per business and so land on `1863856`.

One durable caveat: the Stripe subscription OBJECT backing the biennial
contract is canceled (the abort path canceled it; the $2,376 payment itself
was captured and kept). That means the dashboard's contract auto-renew toggle
and `ensureCommitmentSchedule` are inert for this term. At the 24-month mark
(renewal Jul 28 2028) the plan card's "Start a new contract" CTA is the path
back onto a contract rate; it creates a fresh Stripe subscription.

Aug 28 2026, the loose end that caveat left behind: `contract_auto_renew` was
still `true` on the row, which is impossible without a live subscription. It
showed auto-renew ON on her plan card, and it excluded her from the pre-term
rollover nudge, so the term would have lapsed in Jul 2028 with no warning
email at all. Cleared to `false` by
`scripts/oneshot/clear-stale-contract-auto-renew.ts` (ledger row 247). Neither
value is literally accurate for a canceled-sub term, but `false` produces the
behaviour that matches reality: nothing auto-renews, and the nudge now fires
in the 5-business-day window pointing at the "Start a new contract" CTA. The
sweep itself was hardened in the same change so a `true` flag is verified
against Stripe before it can suppress a nudge.

Under-$500K sellers are AI-owned (Aug 12 2026):
`amy-under-500k-ai-owned.ts`. Amy: "if the lead price is unknown or below
$500,000 then the AI worker will own this follow up (unclaimed) until they
are ready and serious to speak with Amy's team... her employees are
overwhelmed."

- **Sellers only.** Buyers almost never carry a price, so "unknown" would
  have gated every buyer; buyer routing is untouched. The seller-only scope
  lives in the `price_gate` EXTRACTION on the three mixed flows ("answer ai
  ONLY when this lead is selling..."), plus structural guards where routes
  are lead-type keyed.
- **Every guard fails toward the team.** Routes gate on
  `price_gate notEquals "ai"` (extraction miss routes as today); gated extras
  gate on `equals "ai"` (miss adds nothing). $1M+ leads always read "team",
  so `ownerDirectWhen` owner-direct behavior is preserved by construction.
- **Gated leads ride the cadence BY TAG**, the account's one follow-up
  chokepoint. Where a call just happened the tag carries `AUTO_TAG_NOTE`
  (round 1 skips straight to the 3-day wait); where none did (Realtor.com
  has no call step; a dial that never went out) the tag is plain and the
  cadence's immediate round-1 call IS the first contact.
- **Promotion is either signal.** On a live call, `transferred` fires a claim
  offer on the spot (`clever_route_promote` / `re_route_promote`, cloned from
  the flow's own seller route, ownerDirect config dropped as unreachable). On
  SMS, the cadence classifies every reply (`reply_intent`) and a
  ready_to_talk reply earns the offer INSTEAD of the informational alert
  (first-match branch): sellers/both broadcast to the trio, buyers keep the
  rotation. A not-ready reply keeps today's alert; a timeout does nothing.
- **Amy's emails keep flowing.** The owner line now reads "Unassigned when
  blank", and the SECOND email, when someone claims after promotion, rides
  the `claimedNotifyEmail: amy@amylaidlaw.com` every route step (including
  the promotion routes) carries.
- **HomeLight is exempt.** Contact info is revealed only after a connected
  call and its connect call needs a human: gating that broadcast would lose
  the lead outright.
- **Known wart:** a gated Spanish-speaking New Lead Intake seller joins the
  English-language cadence (the cadence has one language). Same limitation a
  manual "F" tag on a Spanish lead always had.
- The Clever gated branch sits AFTER the `lead_reached` goal on purpose:
  steps after a goal run on BOTH paths, so a reply that goal-jumps out of the
  retry ladder still passes the gate and lands in the cadence instead of
  silence.

Unclaimed $500K+ sellers become AI-owned too (Aug 13 2026):
`amy-team-unclaimed-ai-followup.ts`. Amy: "When the lead comes in above $500K
and no employee claims it then ai will own the follow up process." The other
half of the under-$500K gate: the claim offer still goes out, but when it
runs its whole course unclaimed the flow no longer ends at "It's back to
you". A `{p}_team_unclaimed` branch at the END of each of the four lead
flows (never delaying emails or the bad-phone chain) waits 120 minutes past
flow end, re-checks `claimed_agent`, and tags the lead into the cadence.

- **Sellers only, $500K to $1M.** Buyers untouched as always; $1M+ is
  excluded because ownerDirect means it was never offered to the team, so
  "no employee claims" never describes it and Amy keeps it personal.
- **Realtor.com gained a `lead_type` extraction** that answers seller ONLY
  when the message clearly says selling; ambiguity (most Realtor.com traffic
  is buyer inquiries) fails safe to buyer and no tag.
- **Note choice mirrors the gate:** Clever and RE tags carry AUTO_TAG_NOTE
  (their calls run for every under-$1M lead, cadence starts at the 3-day
  wait); Realtor.com and NLI tag plain (mostly never called, the cadence's
  immediate call IS the takeover; a rare call-gated NLI lead gets re-called
  ~3h later, which beats delaying the majority 3 days).
- **Copy matches behavior:** the seller offers' `ownerFallbackTemplate` now
  says the AI keeps working unclaimed leads. Realtor.com's s4 fallback is
  deliberately untouched (it offers buyers too, the line would be false).
- **Candidate follow-up, not yet asked for:** the "Follow Up Requested
  (Unclaimed Leads)" flow has the same disease (unclaimed request → "back to
  you" → nothing); flagged to Brian rather than silently included.

The $1M band is arithmetic now (Aug 14 2026):
`amy-deterministic-price-band.ts`. Corinna Bennett (run `36f319be`), a $613K
RealEstateAgents.com seller, was extracted price "$613K" AND price_band
"over_1m" IN THE SAME extraction call. Three gates keyed on the judgment, so
one flake silenced everything at once: no AI call (gated under_1m), no team
offer (ownerDirectWhen kept it for Amy as "$1M+", who did not acknowledge two
reminders), no unclaimed takeover (its arm required under_1m). An audit of
118 recent runs with a parseable price found exactly one mismatch: rare, but
it lands on the only path with no recovery.

- Each reader now extracts `price_digits` (bare digits, "0" when none), and a
  `math` step with the new `less_than` operation computes `price_under_1m`
  deterministically. Every band gate keys on the computed var: call gates
  `notEquals "no"` (unknown still gets the call), ownerDirectWhen
  `equals "no"` (only a PROVEN $1M+ is kept from the team), takeover arms
  `notEquals "no"`.
- `price_band` and `price_gate` extractions remain (templates and the
  seller-scoping half of the gate are inherently extraction), but nothing
  gates on `price_band` any more, and `assertNoBandGates` in the script
  aborts if a straggler gate survives.
- Corinna herself was remediated by hand the same day: tagged into the
  cadence (run `0ee2e205`) with a plain tag, since she was never called.

Unclaimed follow-up REQUESTS become AI-owned (Aug 14 2026):
`amy-followup-request-takeover.ts`. Brian: "Yes extend it to the Follow Up
Requested flow too." Same `{p}_team_unclaimed` shape appended to
"Follow Up Requested (Unclaimed Leads)": two hours after flow end, still
unclaimed and not a proven $1M+, the lead is tagged into the cadence. The
tag is PLAIN (the lead asked for a follow-up TODAY; the cadence's immediate
call is that follow-up). Its seller variant matches
`route_lead_type notEquals "buyer"`, mirroring the flow's own seller route;
the takeover branch carries NO `price_gate` when (nothing produces the var
here, and the validator rejects a when on an unproduced var), and the
reader gains the same `price_digits` + computed band the arrival flows use.
`route_seller`'s fallback copy gains the takeover line; `route_buyer` is
untouched.

`tests/tenant-dossiers.test.ts` fails if a tenant-named script exists without
a mention here, so adding a one-shot means adding a line.

## Demonstration mode is live on this box (Aug 20 2026)

Her render sidecar carries the `/demo/*` paths (PRs #1550, #1554, #1555,
#1559), so a browse step on this account can be taught by doing the workflow
once instead of hand-writing selectors. Verified live on the box that day,
READ-ONLY, with no action performed on any portal:

- Public page: a click on a screenshot pixel resolved to `click_text("Learn
  more")`, verified back to that element, executed, and the page navigated.
  That is the whole loop, proven.
- Her Clever login: a session opened with the stored "Clever" credentials and
  landed on her real signed-in dashboard (Needs Action, Clever Offers), with
  the announcement modal that `dismissBlockingOverlays` exists for sitting
  over it. Zero acts were sent, and the session was stopped.
- A stale demoId answers `unknown_demo`; a box without the paths 404s, which
  the dashboard reports as "not updated yet".

Worth knowing before demonstrating on this account: every click is REAL.
Prefer a record whose update does not matter, and note that the four labels
here ("Clever", "HomeLight", "Referral Exchange", "Realtor.com") are the same
logins the flows already use many times a day.

## History

Notable PRs: #936, #927, #913, #911 (HomeLight), #877 / #876 / #854 (dynamic
teammate pin and New Lead Intake), #856 (group-reply greeting), #790
(broadcast route_to_team), #697 (bad-phone report), #613 (act on the answer,
not just acknowledge it).
