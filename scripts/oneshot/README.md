# scripts/oneshot

One-shot operational scripts. Each file in this directory is a single-use
recovery / migration tool that targets a specific business or VPS by ID
and is **not** part of any automated path.

## Convention

* The file is run with `tsx`, e.g.:
  ```bash
  tsx scripts/oneshot/finish-provision-stuck-business.ts
  ```
* IDs and other parameters are hard-coded near the top of each file —
  edit them in-place rather than passing CLI flags. This keeps the
  intent (and audit trail) inline with the run.
* Scripts are idempotent where possible. Re-running a successful one
  should be a no-op rather than re-charging a card / re-creating a
  resource. If a script can't be made idempotent, it must guard the
  destructive section behind a top-of-file boolean.
* When a one-shot is no longer needed (the situation it was written to
  fix is permanently mitigated upstream), delete it rather than leaving
  it as dead code.

## Inventory

### `finish-provision-stuck-business.ts`

Manually finishes orchestration for a business whose Stripe webhook ran
but whose Hostinger provisioning was interrupted (e.g. `403 [VPS:2000]`
on `/post-install-scripts` for a fresh account; orchestrator threw
before recording a terminal `failed` row).

Targets an existing VPS by ID (no `purchaseVirtualMachine` call). Will:

1. Detect whether `vps_ssh_keys` already has a row for this business —
   if so, reuse it and skip `/setup`.
2. Migrate any persisted PKCS#8 ed25519 PEM to OpenSSH format (required
   for `ssh2` v1.17+; see `src/lib/hostinger/keypair.ts` header).
3. Call `orchestrateProvisioning` with a custom `vpsProvisioner` that
   returns the existing VPS metadata, so the orchestrator runs SSH
   bootstrap → Cloudflare tunnel → DID provisioning → deploy → notify
   without touching the Hostinger purchase APIs.

### `manual-provision-stuck-business.ts`

Validates the Hostinger post-install-scripts hypothesis end-to-end (was
the 403 we hit a "fresh-account chicken-and-egg" gate or a deeper
account-level lock?). Provisions a brand-new VPS with PIS attached,
records the API responses, and tears down the script resource on exit.

Kept in the tree as a future Hostinger-API regression harness — if PIS
ever 403s again on a non-fresh account, run this script to capture a
clean repro before opening a Hostinger support ticket.
