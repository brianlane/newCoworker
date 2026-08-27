---
name: verify-the-constant-not-the-comment
description: "Validate a doc/README claim against the exported constant that executes, never a prose comment; \"historical\" in a comment means superseded"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: be5e4054-0cf9-4b46-8332-dbc61fe7d8f8
  modified: 2026-08-27T06:30:36.806Z
---

While auditing the README pricing table (Aug 2026), I declared "starter=KVM2 / standard=KVM8 unchanged" citing a comment in `src/lib/hostinger/provision.ts` that read "the tier's historical mapping (starter→kvm2, standard→kvm8)". Brian challenged it. The live record, `DEFAULT_TIER_VPS_SIZE` in `src/lib/vps/size.ts`, had been `starter: kvm1, standard: kvm2` since the Jul 2026 fleet-economics relaunch (PRs #360/#369). The word "historical" meant SUPERSEDED, and I read it as "long-standing". Worse, the same file held two contradictory comments (kvm1/kvm2 in one docblock, kvm2/kvm8 in another), which alone proves comments there cannot arbitrate.

**Why:** Comments and docs drift; the exported constant, DB default, or record that code actually reads at the decision point cannot. Validating one document against another document (README against a comment) is circular; both can be stale together.

**How to apply:** When confirming "X is still true" about defaults, mappings, or prices, grep to the constant/record/function that EXECUTES the choice (e.g. `DEFAULT_TIER_VPS_SIZE`, `MEMBERSHIP_PACK_DISCOUNT_PERCENT`, `PRICING` in `tier.ts`) and read its current value. Treat the words "historical", "legacy", or "kept for callers" in a docblock as a flag that the live answer lives elsewhere. Related: [[measure-the-machine-not-the-plan]], [[research-before-asking]].
