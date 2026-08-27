---
name: feedback_assert_the_producer_not_the_fixture
description: "Fixtures that do not match reality mislead in both directions: hand-fed values hide a broken seam, and an under-built fixture makes a correct patch look broken"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40416682-0de3-4391-a713-4b717801572b
  modified: 2026-08-11T06:39:05.374Z
---

Three times in one workstream (Aug 5-6 2026, the HQ inbox reply loop) I added
a value at one end of a seam, consumed it at the other, and wrote a test that
**supplied the value itself**. Each passed while production had nothing.

- `message_ref`: emitted into the trigger scope, never added to
  `TRIGGER_SCOPE_KEYS`. My test asserted the scope emits it; authoring a flow
  that references it would have failed. (Caught by Bugbot. It was also a
  repeat: I had fixed the identical gap for `subject`/`thread_id` days
  earlier in the same session.)
- `email_log_id`: the flow's `send_email` resolved its reply thread from
  `{{trigger.email_log_id}}`. My plumbing test passed the id into `planStep`
  by hand and asserted it was carried through. In production
  `emailTriggerScope` never emitted it and the poller wrote the `email_log`
  row *after* enqueueing, so the template rendered empty: the reply went out
  as a NEW conversation with a `Re:` subject, un-cc'd and unclaimed, looking
  perfectly correct in the sent folder. Only Brian opening Gmail found it.
- `run_agent` from a flow: never worked in production at all (`agent_runs`
  had zero rows with `source = 'flow'` across the feature's whole life),
  because Vercel 403s an origin-less POST. Every test mocked the platform
  call.

The mirror image, found Aug 10 2026 in `tests/email-organize.test.ts`: a
fixture that emits what the producer **cannot**. 17 mocks resolved
`{ status: 403 }` from the Nango proxy, which rejects on any non-2xx, so all
~14 `res.status >= 400` branches in `src/lib/email/organize.ts` were dead code
and every assertion on them was vacuous. Same tell as the cases above (green,
specific, realistic) and coverage read 100% because the branches ran under the
fake value. Detection question is the inverse: not "would a test fail if the
producer emitted nothing", but **"can the producer emit this shape at all?"**
Answer it by reading the producer, including into `node_modules` when the
producer is a library.

**The third variant, a FALSE NEGATIVE (Aug 24 2026).** An under-built fixture
makes a correct patch look broken. Writing one-shots that restructure Amy's
flows, `expect(() => parseAiFlowDefinition(patched)).not.toThrow()` failed four
separate times, and every time the patch was fine and my fixture was missing
something the live flow has: a required `ownerFallbackTemplate` on
`route_to_team`; a `personaTemplate` naming `{{vars.lead_address}}` that no
fixture step produced; a `when` on `price_under_1m` with no math step to
produce it; and `attachScreenshot: true` with no earlier browse step carrying
`screenshot: true`. Each read as "my patch broke the definition" and cost a
debugging round.

Fix, cheap and permanent: **assert the fixture is valid BEFORE asserting the
patched output.**

    expect(() => parseAiFlowDefinition(fixture())).not.toThrow();   // fixture is sound
    const def = fixture(); patch(def);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();          // so this is about the patch

Now a fixture gap fails on its own line and names itself. The faster
confirmation while iterating is to run the one-shot's DRY RUN against the live
tenant: it parses the real definition, so it answers "is this the patch or my
fixture?" outright.

**Why:** a fixture that provides the value is a test of the consumer only.
The seam, "does anything actually put this here", is the part that breaks,
and it is the part no consumer test can see. Worse, the shape feels
thorough: the assertion is specific, the value is realistic, the test is
green.

**How to apply:** when a change spans a producer and a consumer, write one
test that starts at the PRODUCER and reads the value out the far end, with
nothing hand-fed in between. Concretely: assert `emailTriggerScope(...)`
returns the key rather than passing the key to `planStep`; author a real
definition through `parseAiFlowDefinition` rather than trusting the
allowlist; assert the poll's `enqueueAiFlowRun` call carries the field. If
the only way to prove it end to end is a live call, make one during
verification and paste the result, as with the `curl` that exposed the CSRF
403.

Ask before shipping: **"if the producer emitted nothing, would any of my
tests fail?"** If not, the seam is untested no matter how many assertions
sit on either side of it.

Related: [[check-for-a-shared-mechanism-first]] is the sibling failure (a
correct decision expressed in a form the receiving system cannot act on);
this one is the correct form never being sent at all. [[feedback_testing]]
pins coverage, which does not help: every line here was covered.
