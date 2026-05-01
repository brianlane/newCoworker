# scripts/oneshot

One-shot operational scripts. Each file in this directory is a single-use
recovery / migration tool that targets a specific business or VPS by ID
and is **not** part of any automated path.

## Convention

* The file is run with `tsx`, e.g.:
  ```bash
  tsx scripts/oneshot/ensure-tunnel-subzone.ts
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

### `ensure-tunnel-subzone.ts`

Idempotent driver that delegates `<TUNNEL_LABEL>.<ROOT_DOMAIN>` to its
own Cloudflare zone (default: `tunnel.newcoworker.com`). Collapses
two-level tunnel hostnames (`<biz>.tunnel.<root>`) to one wildcard
level on the new child zone, which Cloudflare's free Universal SSL
covers automatically — sidesteps the $10/mo Advanced Certificate
Manager that Total TLS otherwise requires for multi-level
wildcards. End-to-end logic + token requirements live in
`src/lib/cloudflare/subzone.ts`. Reads every config value from env or
argv (no PII embedded).

## Removed

A previous generation of customer-specific one-shots
(`finish-provision-stuck-business.ts`, `live-apply-bootstrap.ts`,
`seed-rowboat-and-fix-config.ts`, `smoke-brianlanefanmail.ts`,
`manual-provision-stuck-business.ts`) was deleted once the situations
they fixed were mitigated upstream:

* The PKCS#8 → OpenSSH key-format migration now runs automatically on
  every read of `vps_ssh_keys` (see `migrateRow` in
  `src/lib/db/vps-ssh-keys.ts`).
* Rowboat per-tenant project seeding now happens inside
  `vps/scripts/deploy-client.sh` (phase 3b).
* Cloudflare Total TLS automation lives in
  `src/lib/cloudflare/tunnel.ts` (`ensureZoneTotalTls`), with a
  dedicated `CLOUDFLARE_SSL_API_TOKEN` for the SSL scope.
* Apt-lock contention between Hostinger PIS and the orchestrator's
  SSH-bootstrap is resolved via `DPkg::Lock::Timeout=300` on every
  apt-get + `cloud-init status --wait` gating in
  `buildBootstrapSshCommand` (SSH path only — never inside the
  cloud-init runcmd body, which would self-deadlock).

Customer PII (email, public IP, business UUID) was hard-coded in those
deleted scripts — a Cursor Bugbot Low warning surfaced this exposure.
Future one-shots that target a specific tenant should read IDs from
env or argv instead of hard-coding them so the file itself stays
PII-free even if the script lingers in git history.
