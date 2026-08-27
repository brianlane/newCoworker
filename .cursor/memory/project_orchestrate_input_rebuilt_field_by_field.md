---
name: project-orchestrate-input-rebuilt-field-by-field
description: "Every wrapper feeding orchestrateProvisioning rebuilds its input field by field, so a newly added field is silently dropped with no type error"
metadata: 
  node_type: memory
  type: project
  originSessionId: e034095f-5412-4df8-a8f3-131c22432ce1
  modified: 2026-08-15T16:27:39.780Z
---

`orchestrateProvisioning`'s input is reconstructed **field by field** at five
places, never spread. Add a field to `ProvisioningInput` and every one of them
silently drops it: the fields are optional, so it typechecks cleanly, and
nothing fails at runtime. The provision just quietly does the wrong thing.

The five:

- `orchestrateProvisioning` itself → `runOrchestrator` (inside
  `src/lib/provisioning/orchestrate.ts`)
- `src/app/api/internal/provisioning-retry/route.ts` (the watchdog)
- `src/lib/vps/migrate-size.ts`
- `src/lib/vps/term-renewal-sweep.ts`
- `src/app/api/webhooks/stripe/route.ts` (signup)

Adding `hostingerTerm` in PRs #1391/#1393 hit this **three times**: once
caught by a test that asserted the term reached the purchase, twice by
Bugbot. The failure mode is the worst kind: a contract tenant gets a MONTHLY
box instead of the term the sweep computed, the sweep reports success, and
the only symptom is a fleet slowly costing more than it should.

**Why it stays this way:** the wrappers deliberately override fields
(`migrate-size` substitutes `targetSize` for `vpsSize`), so a blanket spread
is not a safe mechanical fix.

**How to apply:** when adding ANY field to the provisioning input, grep
`orchestrateProvisioning(` and `orchestrate: ` and update every call site, then
pin at least the sweep-driven ones with a test that asserts the value arrives
at the purchase. A type change alone will not tell you. Each site now carries
a comment saying it is rebuilt rather than spread.

Related: [[project-worktree-build-needs-real-node-modules]],
[[feedback-check-for-a-shared-mechanism-first]].
