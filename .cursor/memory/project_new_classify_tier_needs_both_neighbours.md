---
name: project-new-classify-tier-needs-both-neighbours
description: "Adding a classify category must pin the neighbour ABOVE and BELOW; naming platforms without saying 'and it is finished' swallows the asks"
metadata:
  node_type: memory
  type: project
---

Adding a category to an AiFlow `classify` step silently steals mail from the
categories on BOTH sides of it. PR #1433 added `automated_review` (silent tier
for platform outcomes) and tested only the neighbour below (hosting renewals
must stay `automated_notice`). The Aug 18 2026 nightly caught the neighbour
above: "Your app submission needs changes / Respond with an updated build"
classified `automated_review` and went silent instead of texting, while the
ChatGPT app and Meta App Review were both in flight.

The copy defect is generalizable: a description that names the SUBJECTS it
covers ("app review, marketplace publication, OAuth or domain verification")
reads as "any mail about these", not "a case that is over". Fix was to state
the terminal condition: "A platform outcome that is DONE and needs no reply".
The tier that pages owns anything still asking for a response, whatever its
topic.

Two other things this cost:

- `tests/e2e/hq-inbox-classify.e2e.test.ts` asserts the FULL sorted category
  list off the real definition. Adding a category fails it by design, and
  #1433 never updated it, so the nightly reported two failures for one change.
  Expect that assertion to break, and treat it as the reminder to test the
  new tier's neighbours.
- PR CI cannot catch any of this: the Admin "CI live e2e" toggle is
  nightly-only, so no PR run classifies against the real model. See
  [[project-run-itest-and-live-e2e-locally]].

**How to apply:** when adding or reworing a classify category, write a live
e2e case for each ADJACENT category, in both directions, and a deterministic
unit test pinning the phrase that separates them. Probe candidate wordings
with a standalone tsx script over `buildClassifyPrompt` + `geminiJson` before
editing tests: it is far cheaper than iterating the suite. Related:
[[feedback-a-failing-old-test-is-evidence]],
[[feedback-prove-prompt-fixes-against-deployed]].

## The 200-character cap decides the edit (Aug 28 2026)

Category descriptions are capped at 200 chars by the schema
(`src/lib/ai-flows/schema.ts`, `parseAiFlowDefinition` enforces it), and the
HQ triage tiers were already at 192. So sharpening a tier is not "add a
clause", it is a TRADE, and which words you spend is the real decision.

The nightly failed on "Incident: elevated API error rates / We are
investigating ... Updates to follow" landing in `automated_notice` (measured
31/44, about 70%, not a wobble). The tier below opens with "asks nothing of
us" and an incident notice asks nothing, so both tiers had a fair claim.

Adding "incident" cost "broken integration", which became "breakage". The
cheaper-looking trade, dropping "we are in" from the conversation clause,
scored IDENTICALLY on all seven cases and was still wrong: the test "teaches
every tier that an ongoing conversation is not routine" pins that phrase
across all three automated tiers as the wording-independent half of the Aug 17
OAuth fix. **A measured tie is not permission to break a property nothing
measured.** See [[feedback_a_failing_old_test_is_evidence]].

Scored 12 samples per case, before -> after, both neighbours in both
directions: incident 11/12 -> 12/12, security alert 12/12 -> 12/12, broken
integration 12/12 -> 12/12 (so "breakage" cost nothing), hosting renewal
12/12 -> 12/12, hosting EXPIRED 12/12 -> 12/12 (the Aug 6 Hostinger
regression), Slack digest 12/12 -> 12/12.

REMEMBER THE LIVE FLOW. Editing the definition module does NOT change
behaviour: `ai_flows` "Team inbox triage (HQ)" holds its own copy. Refresh it
with `npx tsx scripts/oneshot/setup-hq-inbox-triage-flow.ts --apply`. Its
dry-run diff prints nearly every step as CHANGE, but that is key-ORDER noise
from a serialized comparison; deep-compare ignoring key order to see the real
change. See [[feedback_live_flow_source_of_truth]].
