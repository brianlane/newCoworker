# Incident review: KYP Ads onboarding (Jul 14–15, 2026)

KYP Ads (business `056034a7-e84c-444d-8d15-747eeb1fa899`, owner James Lee,
Canadian tenant, standard tier) was the second real-money signup, and the
first to be provisioned onto an **adopted pool box** (the ex-pilot KVM1,
vm 1800985). The signup surfaced seven latent defects. Every one was
hot-fixed for KYP the same day AND fixed permanently at the root, so no
future tenant hits it. This doc is the single place that lists them all.

Format per incident: **what broke → hot fix for KYP → permanent fix**.

---

## 1. Provisioning died mid-run (Stripe webhook teardown)

- **What broke**: the checkout webhook dispatched `orchestrateProvisioning`
  as a bare floating promise under a 300s `maxDuration`. Provisioning takes
  8–12 minutes, so Vercel tore the function down mid-provision and the run
  froze at ~40% ("It looks stuck"). Second real signup in a row to hit this.
- **Hot fix**: `scripts/oneshot/provision-kyp-ads-retry.ts` re-ran the
  orchestrator locally; the idempotent pool claim reused the box already
  assigned to KYP instead of burning a second VM.
- **Permanent fix (PR #598, restamp #601)**: `maxDuration = 800` +
  `after()` on the Stripe webhook route; a durable `provisioning_jobs`
  ledger (migration `20260805000300`) with heartbeats from
  `recordProvisioningProgress`; a `provisioning-watchdog` cron that claims
  stalled jobs by heartbeat staleness and re-runs them; `claimAvailableVps`
  returns the already-assigned box on retry (no double-claim).

## 2. Auto-DID assignment failed for a Canadian owner

- **What broke**: Telnyx had no CA/514 numbers with SMS+voice; the
  availability search returned HTTP 400 code `10031` ("No numbers found"),
  which `searchAvailable` treated as a fatal API error — the whole DID
  search cascade aborted instead of trying broader tiers. KYP came online
  with no phone number.
- **Hot fix**: `scripts/oneshot/assign-kyp-ads-did-438.ts` ordered and
  assigned +1 438 803 5806 (CA/438) manually.
- **Permanent fix (PR #598)**: `TelnyxNumbersClient.searchAvailable` maps
  400/10031 to an empty result, so the cascade continues to the next
  search spec (other CA area codes → any CA → US fallback) instead of
  aborting.

## 3. `TELNYX_MESSAGING_PROFILE_ID_CA` unset in local runs

- **What broke**: the orchestrator warned the CA messaging profile was
  unset during the local retry run. Without it, Canadian tenants' outbound
  SMS fails with Telnyx 40309 (the earlier Truly incident). Vercel already
  had it; the local `.env` (used by one-shot provisioning retries) did not.
- **Hot fix / permanent fix**: mirrored the value into the repo `.env`
  with a comment documenting why it must exist in every environment the
  orchestrator can run in. KYP was provisioned onto the CA-capable
  profile (`telnyx_messaging_profile_id` = US+CA profile).

## 4. "Your Coworker is live" SMS failed (dead platform sender, wrong recipient)

- **What broke**: two defects in one send. The SMS went out from
  `TELNYX_SMS_FROM_E164` — a platform number released months earlier
  (Telnyx 10010, "not associated with your account"); and because checkout
  passes no `ownerPhone`, the recipient fell back to the platform ops
  phone, not James.
- **Hot fix**: `scripts/oneshot/send-kyp-live-sms.ts` replayed the SMS
  from KYP's own DID (+14388035806) to James (+15145188192); Telnyx
  confirmed delivered.
- **Permanent fix (PR #605)**: the live SMS now sends **from the tenant's
  own DID** (`business_telnyx_settings.telnyx_sms_from_e164`) with NO env
  fallback — a tenant without a DID skips with an honest log rather than
  borrowing another tenant's number. The recipient resolves
  `ownerPhone` param → the owner's onboarding phone (E.164-coerced) →
  ops phone last. `TELNYX_SMS_FROM_E164` was blanked in every environment
  (the platform owns no shared sender).

## 5. Owner phone stored un-normalized ("5188192")

- **What broke**: James's free-form onboarding phone was seeded into
  `businesses.phone` / `notification_preferences` as a 7-digit local
  number, which Telnyx rejects — owner alerts and the live SMS could
  never have reached him.
- **Hot fix**: SQL update to `+15145188192` across `businesses.phone`,
  `notification_preferences.phone_number`, and
  `business_telnyx_settings.forward_to_e164`.
- **Permanent fix (PR #605)**: `initialNotificationPreferenceContactsFromSeeds`
  E.164-coerces phone seeds (drops uncoercible values instead of storing
  garbage), and the orchestrator coerces the SMS recipient the same way.

## 6. Delivered owner SMS invisible in the dashboard

- **What broke**: the live SMS delivered to James's phone but never
  appeared in the dashboard Texts page — provisioning was the only
  owner-notify send site that didn't write `sms_outbound_log` (which is
  what the Texts view renders; AiFlow owner notices always logged).
- **Hot fix**: backfilled the delivered message (Telnyx id `40319f62-…`)
  into `sms_outbound_log` with its real delivery timestamp.
- **Permanent fix (PR #629)**: the orchestrator logs the live SMS to
  `sms_outbound_log` (`source: owner_notify`) right after a successful
  send — best-effort, a log failure never fails provisioning.

## 7. Adopted box served the previous tenant's tunnel (rowboat_http_530)

- **What broke**: James texted "can i chat here" and got no reply — the
  job dead-lettered with `rowboat_http_530`. The adopted pool box still
  ran the PREVIOUS tenant's `cloudflared` unit: `deploy-client.sh`
  deliberately treats an existing unit as "restart, don't reinstall"
  (correct for same-tenant re-deploys), so adoption never swapped the
  tunnel token. The box served the old tenant's tunnel while KYP's
  hostnames pointed at a connector-less tunnel — every request through
  chat/voice/render hostnames returned 530.
- **Hot fix**: `debug/fix-kyp-tunnel.ts` fetched KYP's tunnel token from
  the Cloudflare API and reinstalled cloudflared over SSH (hostnames
  530 → 200); the dead-lettered job was requeued and the AI answered.
  `debug/diag-kyp-box.ts` is the reusable diagnostic.
- **Permanent fix (PR #637)**: the tunnel step in `deploy-client.sh` now
  compares the token baked into the existing unit with the token the
  deploy received — same token stays a cheap restart; a differing token
  (pool adoption, manual rotation) uninstalls and reinstalls. A contract
  test in `tests/hostinger-provision.test.ts` pins the branch.

---

## Related policy work this signup triggered

- **Nothing is exempt from SMS metering** (PR #610): the live SMS and all
  owner/compliance sends are metered via `meter_sms_operational_send` —
  counted always, never refused. See README "Budget enforcement".
- **Forwarded/transferred call minutes are metered** (PR #631): found
  while auditing this tenant's billing surface — carrier time for
  human-forwarded calls now debits the tenant's voice pool
  (`voice_meter_forwarded_call`), post-hoc and never refusing.

## Adoption-pool checklist (what reprovisioning onto a pool box must swap)

The tunnel incident is the class to watch: **anything the previous tenant
left on the box that "already exists" checks can skip**. Current state:

| Resource | Swapped on adoption by | Verified |
|---|---|---|
| Cloudflare tunnel token | deploy-client.sh token compare (PR #637) | contract test |
| Rowboat project / vault | deploy-client.sh reseed (always runs) | provision tests |
| Chat-worker `.env` (BUSINESS_ID etc.) | deploy-client.sh rewrite (always runs) | provision tests |
| Stale tenant rows referencing the box | `cleanupStaleTenantsForVm` at adopt | stale-tenant-cleanup tests |
| Per-tenant gateway token | orchestrator mint + confirm | gateway-token tests |

If a new per-tenant resource is added to the box, add it to this table and
make its deploy step idempotent-but-tenant-aware (compare, don't skip).
