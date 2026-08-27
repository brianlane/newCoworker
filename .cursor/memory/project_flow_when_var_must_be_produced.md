---
name: project_flow_when_var_must_be_produced
description: "A step `when` can only name a var an EARLIER step produces, so you cannot silence a step with an invented flag; borrow a real var and compare to an impossible value"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8dcda517-09ad-41db-9cef-57a78776ed70
  modified: 2026-08-18T01:57:30.962Z
---

`parseAiFlowDefinition` runs `validateDefinitionSemantics`, which rejects:

> Step "notify" has a "when" condition on {{vars.owner_notice_enabled}} which
> no earlier step produces.

So the obvious way to turn a step off (invent a flag nobody sets) **cannot be
written at all**. Same rule catches an unproduced placeholder in a template:
"Step X uses {{vars.lead_type}} before any step produces it."

**The technique that works**, used by `amy-owner-notice-policy.ts`: reuse the
var the step ALREADY reads (the validator has accepted it) and compare it to a
value nothing can hold, e.g.
`{ var: "route_lead_type", equals: "owner-notice-disabled-by-amy-2026-08-17" }`.
For a step with no `when` of its own, pick a var its own message renders.
`evaluateStepCondition` trims and lowercases both sides, and resolves a
missing/non-scalar var to `""`.

**Why not just delete the step.** `ai_flow_runs.current_step` is a flat index
over the flattened definition, so deleting renumbers everything after it and
walks parked runs onto the wrong instruction. A step that stays put and
evaluates false costs one skipped index and moves nothing.

**Always prove it before applying**: flatten live vs patched with the engine's
own `flattenSteps` and compare id lists. Appending a branch ARM is a pure
append (old list is a prefix of the new), which is why adding an arm is safe
even when editing in place is not.

Related: [[project_amy_followup_cadence_rules]] (the ROUNDS index-migration
check), [[feedback_live_flow_source_of_truth]].

## A branch arm matches ONE substring, and there are only four arms

Two hard limits that together decide how any routing flow has to be shaped:

- `MAX_BRANCH_ARMS = 4` (`src/lib/ai-flows/schema.ts`). Three real categories
  plus the `else` fallback already fills a branch.
- `whenSchema` refuses anything but **exactly one** of
  `equals` / `contains` / `notEquals`. There is no OR, no array, no regex.

So an arm **cannot** match several phrasings of the same thing. If a routing
table carries aliases, the flow can only ever use one of them, and any helper
that matches the full alias list is claiming a routing the live flow cannot
perform. That is a silent divergence: the tests pass, the docs read fine, and
the leads quietly fall to the fallback arm.

**Fix:** give each category ONE canonical token that both the branch condition
and the reference resolver use, and assert in a test that the live arm's
`condition.contains` equals that token. Push richer phrasing into the
coworker's prose knowledge, where reading meaning is the actual strength.

Found on PR #1619 (KIN booking-link routing), caught by Bugbot: the branch
used `matches[0]` while the resolver matched every alias.

**Corollary worth keeping:** when a word is genuinely ambiguous across
categories (KIN's "assessment" fits OT, speech AND psychology), it must be
nobody's token. Route it to the fallback and have the coworker ask. Same
principle as an age-scoped link: do not guess when the signal does not decide.

## lead_notes concatenates every answer, so fields can steal each other's tokens

`extract_text` puts ALL of a lead form's answers into one `lead_notes`
string. A `contains` rule meant for field A therefore also sees field B's
value, and a token that is unique within one field can be ambiguous across
the blob.

KIN, 2026-08-26: routing matched the service on `teen`, then the ad form
added an AGE field whose value was `teen_13_to_17`. Every service combined
with a teenager routed to teen counselling, so a 15-year-old needing
occupational therapy was sent to book counselling. 5 of 12 combinations
mis-routed, and nothing failed loudly.

**Fix pattern:** match the DECIDING field's vocabulary at the top level, and
nest any secondary dimension inside the arm where it actually applies (age
only inside counselling, the one age-split discipline). Then a secondary
value cannot reach a primary arm at all, which is structural rather than a
matter of arm ordering.

**Before shipping a routing change, enumerate the whole matrix.** Every
service crossed with every age took ten lines of script and surfaced all
five defects at once; reading the arms by eye had missed them.

## A shared tail undoes a per-arm exception

When one branch arm exists specifically to NOT do something, check every step
that runs after the branch. The tail is shared by all arms, so it silently
re-does the thing the arm was created to avoid.

KIN, 2026-08-26: speech is a waitlist, so its arm deliberately sent no
booking link. The nudge cascade after the branch then texted the general
booking link two hours later, to the same lead who had just been told there
was nothing to book. Bugbot caught it; the arm alone read as correct.

**Fix pattern:** gate the tail with a second branch. `contains` has no
negation, so the exception arm holds the tail's ABSENCE (`steps: []`, which
validates fine) and the `else` holds the real tail. Resolve the matching
token into one shared constant so the greeting arm and the gate cannot drift.

**Two schema facts learned doing it:** a `goal` step may NOT sit inside a
branch ("goals must sit on the main path"), so hoist it back out after the
gate; and an empty `steps: []` arm is valid.

Generalizes past flows: any per-case exception implemented early in a
pipeline is only as good as the shared stages downstream of it.

