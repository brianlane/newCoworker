---
name: oneshot-patch
description: >-
  Write and apply a ledger-recorded one-shot that changes a live tenant's
  AiFlow, config, or data on New Coworker. Use when patching a tenant's flow,
  seeding a flow, fixing tenant data, or applying a white-glove change.
---

# Tenant one-shot patch

Changing a live tenant's flow by hand in the UI is how flows get broken here;
it has needed a revert at least once on Amy's account. The durable form is a
script in `scripts/oneshot/`: reviewable in a PR, idempotent, dry-run by
default, and recorded in a ledger so "did this already run?" is a query rather
than a re-audit. Seventy-odd of them exist. Follow their shape.

## Before writing anything

1. Read the tenant's dossier in `docs/tenants/`. It lists the flows, the
   sharp edges, and every one-shot already applied. The change you are about
   to write may already exist, or may have been superseded.
2. Read the live definition, do not assume the dossier is byte-current:

```bash
tsx debug/audit-account.ts --business <uuid>     # flows, runs, errors, spend
tsx debug/flow-poll.ts <uuid>                    # what the engine just did
```

3. Decide whether this belongs to one tenant at all. If the next tenant will
   want it too, it belongs in the starter-flow library or the engine, not in a
   one-shot. One-shots are for the genuinely tenant-specific.

## The shape of a one-shot

Copy an existing one (`patch-kyp-offer-branch.ts` is a good model). Required
properties, all of them learned the hard way:

- **Dry-run by default; `--apply` to write.** Print the diff or the previous
  definition first so a rollback is possible from the script's own output.
- **Idempotent.** Re-running `--apply` must converge on the same known-good
  shape, not stack another change on top. If it genuinely cannot be
  idempotent, guard the destructive part behind an explicit top-of-file flag.
- **No hard-coded customer PII.** Read business ids, phones, and emails from
  argv or env. Bugbot has flagged this twice; the file must stay PII-free even
  if it lingers in git history.
- **Ledger the apply**: call `recordOneshotApplied` from `_ledger.ts` on
  success. It is append-only and non-fatal on failure by design.
- **Deterministic over clever.** Prefer an explicit branch to an LLM classify
  step when the rule is knowable (the KYP offer routing branches on the
  Facebook lead form name, with no model call).

## Applying it

```bash
tsx scripts/oneshot/<script>.ts --business <uuid>            # dry run, read the diff
tsx scripts/oneshot/<script>.ts --business <uuid> --apply    # land it
```

One-shots are **not** run by CI. Merging the PR does not apply the change:
running it is a separate, manual post-merge step (README, "Post-merge: what CI
does vs what you still do"). Say explicitly whether you applied it.

## After applying

1. **Verify against the live tenant**, not against the script's own output:
   re-run `audit-account.ts`, or `flow-poll.ts` after a real trigger.
2. **Update the tenant's dossier in the same PR.** Naming the script under the
   dossier's One-shots section is enforced by
   `tests/tenant-dossiers.test.ts`, which fails the build otherwise.
3. **Tell the owner what changed** when it affects live customer messaging.
4. Retire it when the situation is fixed upstream: delete the script rather
   than leaving dead code, and note it under "Removed" in
   `scripts/oneshot/README.md`.

## Sharp edges

- **Roster names change.** Never hardcode a teammate's name into a flow step;
  use `agentNameVar` for a dynamic teammate pin.
- **A teammate is never a lead.** A step that texts a roster member must not
  file them as a customer (`fix-staff-contact-rows.ts` cleaned up the rows
  from when it did).
- **Quiet hours and business-hours gating are real.** A patch that ignores
  them texts leads at night.
- **Flows that are off may be off on purpose.** KYP has three awaiting the
  owner's approval. Do not "fix" them by enabling them.
