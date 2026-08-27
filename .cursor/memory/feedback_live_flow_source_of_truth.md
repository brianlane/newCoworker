---
name: live-flow-source-of-truth
description: "When a tenant flow builder and the live definition drift, Brian rules the LIVE flow canonical; reconcile the builder to live, never re-apply a stale builder"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 525a10b8-a55e-4ae4-8502-d79784d63d1c
  modified: 2026-08-05T21:47:00.661Z
---

Aug 1 2026, KYP Ads: the "canonical" builder (then kyp-offer-definition.ts) no
longer matched the live Lead follow-up flow because the live flow had been
reshaped outside the one-shot ledger (flat steps, trigger-condition offer
selection, 21:00 nudge window, new copy). Brian's call: "The live ai flow is
the source of truth."

**Why:** the live flow has been operating on real leads; a stale builder
re-applied on top would silently revert weeks of tenant-visible behavior (the
exact failure the one-shot convention exists to prevent).

**How to apply:** before writing any one-shot that touches a tenant flow,
diff the live `ai_flows.definition` against the repo builder (fetch live via
REST or `debug/flow-run-autopsy.ts`). If they diverge, patch live surgically
(transform in place, like `patch-kyp-bad-phone-intake.ts`) and reconcile the
builder to the live shape in the same PR, with an equivalence test binding
transform output to builder output. Retire stale appliers per the Removed
convention in `scripts/oneshot/README.md`. Also safe to know: parked runs
re-anchor by `__resume_step_id` (resolveResumeIndex), so inserting steps is
safe for marked runs; only marker-less runs are at risk from index shifts.

**Drift runs the OTHER way too (Aug 5 2026, HQ inbox triage).** This memory
was written for a builder that had fallen BEHIND live. The opposite also
happens and is easier to miss: `setup-hq-inbox-triage-flow.ts` defined 8 steps
while live ran 5, because three `email_organize` steps had been committed but
never applied. Nothing was stale, the labeling had simply never existed, and
`docs/tenants/new-coworker-hq.md` described the builder's intent as if it were
live behavior. So a dossier is not evidence either; only the `ai_flows` row is.
Applying the builder in that state is not a no-op, it turns on behavior for
the first time, which needs Brian's say-so when it is user-visible (that one
moved his mail out of the inbox).

That one-shot's dry run now prints a per-step ADD/CHANGE/REMOVE diff against
the live row before `--apply`. Worth copying into any flow one-shot rather than
re-deriving the diff by hand each time.

Related: [[aiflow-phone-field-trap]]
