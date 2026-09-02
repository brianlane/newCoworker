---
name: e2e-bug-hunt
description: >-
  Run the live-model bug hunt on New Coworker: find real AI-behavior defects
  through the e2e suite, prove each one with a failing test, then fix it. Use
  when asked to "find as many bugs as you can", to hunt bugs through e2e
  testing, or to harden AI behavior before a release.
---

# E2E bug hunt

The recurring ask is "read the README then find as many bugs in the
application as you can, proved through our e2e testing". It has been run
several times and produced real fixes (PRs #550, #560, #563, #543, #723). This
is the procedure, so it does not get re-derived each time.

## What makes this hunt different

The bugs worth finding here are **AI-behavior** bugs, not type errors. `npm
test` is hermetic (credentials are stripped in `tests/setup-env.ts`) and will
never catch the assistant promising a phone call it cannot place, parroting a
full name, truncating an answer, or replying twice. Those live in
`tests/e2e/**`, which calls real Gemini.

So: unit tests prove logic, the e2e suite proves behavior, and this hunt is
about behavior.

## Cost discipline first

Live e2e spends real money on the engineering key.

- `GOOGLE_API_KEY` on the laptop must be the `internal-ci-debug` key, never
  `GOOGLE_API_KEY_TENANTS`. See `docs/GEMINI-SPEND.md`.
- Run one suite at a time; `fileParallelism` is off deliberately, because
  bursty parallel calls trip rate limits and turn real regressions into 429
  noise.
- In CI, e2e is a **gated** job that runs after everything else passes. Do not
  push a branch repeatedly to run e2e remotely; run it locally.

## The loop

1. **Orient.** Read `docs/CONTEXT-PACK.md`. If the hunt targets a tenant, read
   that tenant's dossier in `docs/tenants/` first: several past "bugs" were
   documented, deliberate behavior.

2. **Pick a surface and read its contract.** The README documents the ones
   that are contracts, not preferences: the coworker-tool parity contract, KG
   source coverage, i18n, no-em-dashes, "a teammate is never a lead". A
   violation of a written contract is a real bug with a known correct answer.

3. **Reproduce against the real model.**

```bash
npm run test:e2e                                   # whole suite
npx vitest run --config vitest.e2e.config.ts tests/e2e/<file>.e2e.test.ts
```

   `tests/e2e/flow-walker.ts`, `flow-run-replay.ts`, and `judge.ts` are the
   shared harness: walking a flow, replaying a real run, and judging model
   output. Reuse them rather than writing a new driver.

4. **Prove the bug with a failing test BEFORE fixing it.** This is the step
   that makes the hunt worth anything. A bug found and fixed without a test
   comes back; the whole point of the exercise is converting a discovered
   behavior into a permanent guard. Name the test after the observed
   behavior, not the fix.

5. **Distinguish a bug from a flake.** Live-model tests fail for boring
   reasons: 429s, empty completions, thinking-token caps truncating output
   (PRs #658, #690, #768). Before declaring a bug, re-run the single test. If
   it passes, you found flakiness: fix the flake, do not report a defect.

6. **Fix, then re-run the proof.** One PR per coherent group of bugs, as past
   hunts did ("Fix six extraction/classify/trailer bugs proven by the live e2e
   bug hunt").

7. **Report honestly.** Say which bugs are proven by a test, which are
   suspected but unproven, and which turned out to be intended behavior. A
   suspicion presented as a finding wastes the next session's time.

## Where bugs have actually been found

Worth checking first, because these have all yielded real defects:

- **Trailer / reply-reasoning round trip** (`reply-reasoning.e2e.test.ts`):
  trailer leakage into customer text, multi-line and fenced variants.
- **Promises the system cannot keep** (`sms-call-promise.e2e.test.ts`): the
  assistant offering a call it cannot place.
- **Duplicate sends and double bookings** (`sms-duplicate-replies.e2e.test.ts`,
  worker retries).
- **Extraction and classification** (`bad-phone-classify`,
  `truly-branch-matrix`): invented phone prefixes, misread renewal replies.
- **Names** (`clever-seller-name`, `preferred-name-and-lifecycle`): extracting
  our own agent's name, parroting full names.
- **Human handoff** (`truly-human-handoff`): "speak to a representative"
  turns where the model says `handoff:false`.

## Finish

Per the repo flow: worktree, branch, PR, babysit CI and Bugbot to green,
mark ready (`.github/workflows/cursor-automerge.yml` squash-merges),
post-merge steps, remove the worktree. Label the PR `blog: skip`
(bug fixes are internal work). Do not stop at "waiting for merge."
