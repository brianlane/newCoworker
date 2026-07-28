# scripts/oneshot

One-shot operational scripts. Each file in this directory is a single-use
recovery / migration tool that targets a specific business or VPS by ID
and is **not** part of any automated path.

## Convention

* Scripts read every business-specific value (IDs, emails, IPs, etc.)
  from env or argv — never hard-code customer PII. Cursor Bugbot has
  flagged this twice now; stick to the convention.
* Scripts are idempotent where possible. Re-running a successful one
  should be a no-op rather than re-charging a card / re-creating a
  resource. If a script can't be made idempotent, it must guard the
  destructive section behind a top-of-file boolean.
* When a one-shot is no longer needed (the situation it was written to
  fix is permanently mitigated upstream), delete it rather than leaving
  it as dead code.

## Inventory

| Script | What it does |
| --- | --- |
| `patch-kyp-offer-branch.ts` | Rewrites KYP Ads' "Lead follow-up (white-glove build)" flow to route by Facebook lead form: form name containing "Simple form setup 5/7/26" or "100/week" → the $100/week greeting/Calendly link, everything else → $200/week. Deterministic branch (no LLM classify); idempotent — re-running `--apply` resets the flow to this known-good shape. `--business <uuid>` (or `KYP_BUSINESS_ID`). Applied 2026-07-17 (ledger-recorded). |
| `recover-amy-biennial-switch.ts` | Completes a change-plan whose Hostinger purchase "failed but charged" (HTTP 402 while the order completed server-side): re-derives the paid checkout from Stripe metadata, backs up the old box, adopts the already-paid VM as the orchestrator's injected provisioner, restores data, creates the new sub row (pointing at the canceled-but-paid Stripe sub), cancels the old monthly Stripe sub, and pools the old box with auto-renew off. `--business <uuid> --adopt-vm <vmId>`; dry-run by default, ledger-recorded. |
| `fix-staff-contact-rows.ts` | Deletes contact rows a pre-fix AiFlow send filed for a ROSTER MEMBER (the Dave Lane defect, Jul 25 2026: a post-claim hand-off addressed the teammate through a phone var, so the engine filed them as a new customer and stamped the LEAD's name on the row). Audits every roster number for a business, or just the given `--phone` ones (repeatable); deletes only while the row still looks like the untouched artifact (type `customer`, `name_source` auto, no aliases/tags/owner/email/memory) and re-asserts that shape in the DELETE. Idempotent (a deleted row simply reports clean), dry-run by default, ledger-recorded. |

## Removed

A previous generation of customer-specific one-shots
(`finish-provision-stuck-business.ts`, `live-apply-bootstrap.ts`,
`seed-rowboat-and-fix-config.ts`, `smoke-brianlanefanmail.ts`,
`manual-provision-stuck-business.ts`, `ensure-tunnel-subzone.ts`) was
deleted once the situations they fixed were mitigated upstream:

* The PKCS#8 → OpenSSH key-format migration now runs automatically on
  every read of `vps_ssh_keys` (see `migrateRow` in
  `src/lib/db/vps-ssh-keys.ts`).
* Rowboat per-tenant project seeding now happens inside
  `vps/scripts/deploy-client.sh` (phase 3b).
* Cloudflare Total TLS automation lives in
  `src/lib/cloudflare/tunnel.ts` (`ensureZoneTotalTls`), with a
  dedicated `CLOUDFLARE_SSL_API_TOKEN` for the SSL scope. This is now
  an OPTIONAL paid-plan opt-in: the default hostname pattern is
  `<businessId>.<zone>` (one wildcard level), which free-tier Universal
  SSL already covers — Total TLS is only required if an operator
  deliberately nests hostnames deeper.
* Apt-lock contention between Hostinger PIS and the orchestrator's
  SSH-bootstrap is resolved via `DPkg::Lock::Timeout=300` on every
  apt-get + `cloud-init status --wait` gating in
  `buildBootstrapSshCommand` (SSH path only — never inside the
  cloud-init runcmd body, which would self-deadlock).
* The Cloudflare subzone-delegation helper (`subzone.ts` +
  `ensure-tunnel-subzone.ts`) was deleted in the same change that
  flattened tunnel hostnames to one wildcard level. Free-plan accounts
  cannot add a subdomain as a delegated zone (the dashboard explicitly
  rejects "subdomain.example.com" with "ensure you are providing the
  root domain") and the corresponding API permission group is
  paid-only — so the helper could never run on the production account
  it was written for. Single-level hostnames + Universal SSL
  obsoletes the entire migration story.

Customer PII (email, public IP, business UUID) was hard-coded in those
deleted scripts — a Cursor Bugbot Low / Medium warning surfaced this
exposure twice. Future one-shots that target a specific tenant must
read IDs from env or argv instead of hard-coding them so the file
itself stays PII-free even if the script lingers in git history.
