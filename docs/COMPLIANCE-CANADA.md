# Canadian data residency & PII compliance (enterprise)

Authoritative data-flow inventory for Canadian-residency deals (PIPEDA,
Quebec Law 25) and insurance/legal clients. This is the source document for
a customer's Privacy Impact Assessment or Law 25 cross-border assessment.

**Compliance posture (what we promise):** tenant customer content **at rest
in Canada** (or on the customer's own box), with **documented, disclosed
cross-border processing** for the control plane and AI/telecom subprocessors.
This is the PIPEDA "comparable protection + transparency" model — it is NOT
full in-Canada processing (see §Cross-border processing).

## Placements

| Placement | `vps_provider` | `vps_region` | Box ownership |
|---|---|---|---|
| US fleet (default) | `hostinger` | `us` | Platform (Hostinger, Boston) |
| Canada, platform-owned | `ovh` | `ca` | Platform (OVHcloud, Beauharnois QC) |
| Bring-your-own-server | `byos` | `us` or `ca` | Customer (SSH handover) |

Non-hostinger placements are enterprise-only (`src/lib/vps/provider.ts`).
**Residency is mandatory for BYOS and `ca` placements**: provisioning fails
closed unless `data_residency_mode` is at least `dual`
(`src/lib/residency/enforce.ts`), so the box comes up with the on-box
datastore, data API, and backup timer in the same deploy. Then follow the
standard runbook (README §Data residency): `dual` → backfill → parity gate →
`vps` → purge central history.

## What lives WHERE

**On the tenant's box (Canada / customer hardware), once mode = `vps` +
purge:** every table in `RESIDENCY_MOVED_TABLES`
([src/lib/residency/tables.ts](../src/lib/residency/tables.ts)) — contacts +
AI memory, dashboard chat, email content, voice transcripts, SMS content,
notifications, tenant automations. Also on-box: Rowboat vault
(soul/identity/memory/website knowledge), chat-worker state, and the
residency Postgres.

**Central (US Supabase), by design — control plane, not tenant content:**

- Billing/subscriptions/Stripe ids, provisioning state, gateway tokens, SSH
  keys (see custody caveat below), posture reports, telemetry.
- `sms_opt_outs` — STOP compliance must keep working when a box is down;
  availability there is a legal requirement, so the compliance ledger stays
  central (rationale in `tables.ts`).
- Engine/job tables (`ai_flow_runs`, `sms_inbound_jobs`,
  `dashboard_chat_jobs`, `telnyx_webhook_events`) — written by webhooks,
  drained by Edge workers. Their customer-visible OUTPUT lands in the moved
  tables on the box.

**In transit through central (not at rest):** in `dual`/`vps` modes, content
writes journal through `residency_write_journal` and are deleted once the
box confirms them (~1 min lag). Disclose as transient processing.

## Backups (per-deal knobs)

Set via `POST /api/admin/residency-backup` (admin, enterprise-gated); both
take effect on the tenant's next deploy.

- **Destination** (`businesses.residency_backup_destination`):
  - `central` (default) — the box AES-256-encrypts `pg_dump` locally and
    uploads **ciphertext only** to central Storage. US at-rest exposure is
    ciphertext without a key.
  - `onbox` — dumps never leave the box (rotated locally, default 28 copies
    ≈ 7 days at the 6 h cadence). In-region even for ciphertext. DR depends
    on the box surviving — disclosed trade.
- **Passphrase custody** (`residency_backup_keys.custody`):
  - `escrowed` (default) — platform escrow; support can restore a dead box
    (`debug/residency-restore.ts`).
  - `customer_held` — the platform **drops the plaintext forever** (SHA-256
    fingerprint retained for audit) and uninstalls its backup timer on the
    next deploy; the customer owns DR end-to-end. Requires
    `acknowledgeIrreversible: true`. Flipping back to `escrowed` mints a
    NEW key (the old one is unrecoverable by design).

## Cross-border processing (subprocessors — disclose in the DPA)

| Subprocessor | Role | Region | Tenant content exposure |
|---|---|---|---|
| Supabase (AWS) | Control plane, engine/jobs, journal in transit | US | Transient content in jobs/journal; opt-outs; control plane |
| Google (Gemini / Gemini Live) | AI replies, voice conversations | US/global | Message text + live call audio during processing |
| Telnyx | PSTN voice + SMS carrier | US | Call media + SMS content in carriage |
| Cloudflare | Tunnel ingress, email routing | Global edge | Traffic in transit (TLS) |
| Stripe | Billing | US | Owner billing PII only (no tenant customer content) |
| Resend | Owner transactional email | US | Owner notification content |
| Nango | Calendar/email OAuth proxy | US | Calendar/email payloads during tool calls |
| Hostinger / OVHcloud | Box hosting (per placement) | US / Canada | Full box contents (platform-owned placements) |

**Voice caveat (state it plainly in the deal):** live call audio is
processed by Gemini Live and carried by Telnyx — voice AI is cross-border
by nature. It is disclosed processing, not Canadian-resident data. A deal
requiring in-Canada AI processing is out of scope of this program (would
need region-pinned models — roadmap, not committed).

## Security controls (verified, not just asserted)

- Per-box isolation: unique gateway token, unique SSH key, root-only `.env`
  secrets, UFW default-deny, outbound-only Cloudflare tunnel (README
  §Security: per-VPS box hardening).
- BYOS boxes additionally pass a **preflight hard gate** before bootstrap
  (Ubuntu 24.04, hardware floor, no co-tenancy, outbound 443, disk
  encryption detected or provider-level encryption attested by the
  operator) and report **hourly posture snapshots** (UFW, sshd password
  auth, fail2ban, unattended-upgrades, public listeners) to
  `vps_posture_reports`; drift alerts (`vps_posture_drift` telemetry) and
  shows on the admin page. See `vps/scripts/byos-preflight.sh`.
- Terminal BYOS wipe: on grace expiry the platform removes its containers,
  images, and shredded secrets from the customer's box
  (`src/lib/provisioning/byos-wipe.ts`); OVH boxes lapse via
  delete-at-expiration.

## Refunds (disclose in every Canadian/BYOS deal)

These placements are **excluded from the standard 30-day money-back
guarantee** (Terms of Service §9, enforced in `/api/billing/cancel`):
OVHcloud US bills the underlying Canadian boxes month-to-month with **no
refunds** ("all Fees are non-cancelable and non-refundable"; cancellation
takes effect at the end of the current term), and BYOS enrollment work is
performed specifically for the customer. Any refund, credit, or
early-termination right must come from the enterprise agreement / order
form. Support retains an admin-only escape hatch
(`/api/admin/force-refund`) for genuine edge cases. Never purchase OVH
boxes on 12/24-month commitments unless the deal prepays them — OVH term
commitments can only be exited by paying the full remaining balance.

## Contract artifacts (per deal)

- **DPA + subprocessor list**: use the table above; commit to notice of
  subprocessor changes.
- **Minimum security requirements addendum (BYOS)**: fresh Ubuntu 24.04,
  no co-tenancy, disk encryption (or provider attestation), OS patching SLA
  (unattended-upgrades stays enabled — posture-verified), breach
  notification window, and acknowledgment that hardware/DR of the box is
  the customer's responsibility. The preflight + posture checks verify
  what is technically verifiable; the addendum covers the rest.
- **Law 25 cross-border assessment support**: this document + the
  data-flow tables are the platform inputs; the customer's privacy officer
  owns the assessment conclusion.

## Honest limits

1. The platform remains the root of trust for platform-managed placements
   (escrowed SSH keys/tokens); `customer_held` custody removes backup-key
   escrow but not box SSH escrow (BYOS customers can rotate our key out at
   the cost of platform support).
2. `dual` mode keeps content flowing THROUGH central until the journal
   drains; only after the `vps` flip + purge is central content history
   physically gone.
3. Voice/AI/telecom processing is cross-border (see caveat above).
