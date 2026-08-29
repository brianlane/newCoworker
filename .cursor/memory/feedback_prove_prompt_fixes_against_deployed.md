---
name: feedback_prove_prompt_fixes_against_deployed
description: "Reverting one line to prove a prompt guard bites gives a false negative: LLM rules are jointly load-bearing, so run the DEPLOYED prompt against the real input instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40416682-0de3-4391-a713-4b717801572b
  modified: 2026-08-07T16:19:29.366Z
---

For code, I prove a new test is real by reintroducing the bug and watching it
fail. For **prompts that bug is spread across several sentences**, so
line-by-line reverting proves nothing.

Aug 7 2026, the HQ inbox classifier. Brian got a billing text about a
Hostinger plan expiring on a box we had deliberately retired. I edited three
category descriptions, added a live-model e2e, and then reverted each edit in
turn to check the test would catch a regression. **All three reverts still
passed.** The obvious read is "my test is worthless".

The real answer came from running **origin/main's** category set against the
actual email: `billing`, 5 out of 5, reproducing the reported text exactly.
The fix was genuine; the three edits were jointly load-bearing, and any one
surviving was enough to tip the model.

**Why:** a model weighs the whole prompt. Removing one of several
mutually-reinforcing rules usually leaves enough signal, so a single-line
revert is a false negative about the test AND about the fix. Code has sharp
edges and one-line reverts flip behavior; prompts do not.

**How to apply:** to prove a prompt change fixes a live bug, run the
**deployed** prompt (`git show origin/main:<file>`, or the live row) against
the **real** input, several samples at the production temperature, and confirm
it reproduces the reported failure. Then run the new one. That is the before
and after; a partial revert is neither.

Two things that made this cheap and are worth reusing:
- Put the probe in `tests/e2e/` as a throwaway `zz-*.e2e.test.ts` rather than
  fighting `tsx` (top-level await breaks under the cjs output format). Delete
  it after. To import an old version of a module, `git show` it into a
  subdirectory under `tests/e2e/` and fix up its relative imports.
- Make the model **write its check out loud** when it is ignoring a rule. That
  is what exposed the actual Bobby bug: it was not skipping the recipient
  check, it emitted `CHECK: James james@kypads.com, Bobby jobarmsteam@gmail.com`,
  i.e. it had decided a generic address WAS the absent person. The fix that
  followed (an address counts only when it visibly carries the person's name)
  was not one I would have guessed from the wrong output alone, and the final
  instructions did not need the check-line at all.

Aug 28 2026 added the missing ingredient for a CHAT-persona incident: the
**tenant persona**. Replaying R V's reminder ask against the production prompt
lines alone did not reproduce the failure at all, so the new e2e passed with
the fix deleted and proved nothing. Adding a warm, eager tenant persona
("Samantha, James's assistant, upbeat, keeps leads keen"), which every real
tenant ships, reproduced it 8 of 10 draws at temperature 1 and 3 of 3 runs at
temperature 0. The bare shared lines are the SAFEST possible prompt; the
incident lives in the interaction between them and the persona pushing the
model to please. Reproduce with a persona, or the control is not the control.

Also worth knowing: production does NOT pin a temperature on the SMS turn
(Rowboat uses the provider default), so score a wording at BOTH temperature 0
and 1. Today the two disagreed: the first wording scored 1 of 10 at 0 and 3 of
10 at 1, and picking either alone would have misjudged it.

Also say so plainly in the PR and to Brian when a guard is jointly rather than
individually load-bearing: it is a real limit on what the test catches.

Related: [[feedback_assert_the_producer_not_the_fixture]] is the code-side
version of the same question, "would this test fail if the thing I changed
were gone". [[feedback_live_flow_source_of_truth]] is why the deployed
definition, not the repo builder, is the baseline worth diffing against.
