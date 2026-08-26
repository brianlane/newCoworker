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
