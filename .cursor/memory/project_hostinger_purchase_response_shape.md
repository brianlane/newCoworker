---
name: project-hostinger-purchase-response-shape
description: Hostinger's VPS purchase returns { order, virtual_machine } singular; we read the wrong shape for months, so "fail-but-charge" was partly our own bug
metadata:
  type: project
---

`POST /api/vps/v1/virtual-machines` returns `BillingV1OrderVirtualMachineOrderResource`:

```json
{ "order": { "id": 49658724, "subscription_id": "..." }, "virtual_machine": { "id": 1936826, ... } }
```

An `order` OBJECT and a SINGULAR `virtual_machine`. Hostinger's OpenAPI spec has said so since 2025-06-09 (`hostinger/api-python-sdk`, `docs/BillingV1OrderVirtualMachineOrderResource.md`, which is the fastest way to check any endpoint's real shape).

`src/lib/hostinger/client.ts` was written against `{ order_id, virtual_machines: [] }`, which the API never sends. **Every purchase therefore threw on a reply that had already succeeded and been charged.** Fixed 2026-08-28 in [#1696](https://github.com/brianlane/newCoworker/pull/1696): the client now reads both spellings and normalizes to `{ orderId, virtualMachines }`.

**Why nobody noticed for months.** The whole "Hostinger fail-but-charge" story was partly this bug. `vps_inventory` had ZERO rows from a cleanly parsed purchase; every box the fleet owned arrived via the error-recovery path, labelled "adopted fail-but-charge orphan" or "adopted from pool". When Hostinger genuinely errors the box sits in `initial` with no template, the reconciler catches it, and provisioning limps to success; when Hostinger SUCCEEDS, we hard-failed with a paid orphan. The unit fixture hand-fed the invented shape, so 25k green tests never touched the real contract. See [[feedback-assert-the-producer-not-the-fixture]].

**Two gates decide whether a stranded paid box gets recovered.** Both matter when debugging a "purchase failed but we were charged":

1. `isHostingerPurchaseFailure` (`src/lib/provisioning/orchestrate.ts`) requires `err.name === "HostingerApiError"` AND `endpoint === "/api/vps/v1/virtual-machines"`. A plain `Error` thrown anywhere in the purchase path skips the reconciler entirely. This is why the client now throws `HostingerApiError` (status 200) carrying the raw body on an unreadable reply.
2. `carriesOrphanSignature` (`src/lib/provisioning/reconcile-orphans.ts`) accepts a box that is `initial` with no template (purchase errored BEFORE setup ran) or one wearing this business's own purchase hostname `nc-<uuid12>.newcoworker.com` via `defaultPurchaseHostname`. Signature 1 alone cannot see a box stranded by a SUCCESSFUL purchase, because that box is running with a template.

**Still open:** a failure between the purchase returning and the inventory write (e.g. `waitForVpsReady` timing out) strands a box the same way, and gate 1 will not recognize it either.

**Recovering a stranded paid box** (KIN Integrated Child Health, 2026-08-28, VM 1936826): the private key is only persisted AFTER the purchase, so a stranded box is un-SSH-able. Do not try to repair it in place. Instead:

```bash
npx tsx debug/migrate-vps-size.ts --business <uuid> --size <same-size> --adopt-vm <vmId> --apply
```

`--adopt-vm` buys nothing: it recreates the box with a fresh keypair we keep, bootstraps, deploys, swings the tunnel, restores the tarball, repoints billing, then stops the old box and disables its auto-renew. Same-size is allowed in adopt mode (the refusal only guards against an accidental refresh that would CHARGE). It passes `vpsPool: null`, so finish with [[project-vps-inventory-write-traps]]'s `scripts/oneshot/reconcile-migrated-vps-inventory.ts` or the boxes stay untracked.
