# scripts/oneshot

One-shot operational scripts. Each file in this directory is a single-use
recovery / migration tool that targets a specific business or VPS by ID
and is **not** part of any automated path.

## Convention

* Scripts read every business-specific value (IDs, emails, IPs, etc.)
  from env or argv, never hard-code customer PII. Cursor Bugbot has
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
| `apply-vfm-brand.ts` | Teaches the KYP Ads coworker its second brand, Vantage Flow Media (owner runs two businesses in one tenant, Aug 2026): splices marker-delimited sections into `identity_md` (VFM facts, booking link, the never-quote-price rule) and `soul_md` (one assistant, two businesses, never ask which), then syncs the vault to the box. Content in `vfm-brand-content.ts`, pinned by `tests/oneshot-vfm-definitions.test.ts`. Idempotent (sections replace in place), dry-run by default, ledger-recorded. |
| `apply-vfm-team.ts` | Puts the VFM assignee on the KYP roster (upsert by phone; skipped without `--phone`, since `phone_e164` is NOT NULL) and sets `businesses.lead_auto_assign = true` so the VFM flow's route_to_team pin hard-assigns without a claim. Refuses if any non-VFM flow on the business already uses route_to_team. PII from argv/env only. Idempotent, dry-run by default, ledger-recorded. |
| `seed-vfm-lead-aiflow.ts` | Seeds the VFM lead flow (`vfm-lead-flow-definition.ts`: three OR'd Meta form-name triggers, VFM tag, assignee hand-off, 5-minute-then-link, US Eastern nudge ladder, run_agent booked-time parse, T-60 confirmation) and its `business_agents` parser row. Roster mode (`--assignee-name`) or email-only mode until the assignee has a mobile. Validated through `parseAiFlowDefinition`; idempotent by flow name (`--force` overwrites in place), dry-run by default, ledger-recorded. |
| `create-intl-alpha-profile.ts` | Creates (or converges) the dedicated "New Coworker International Alerts" messaging profile carrying the platform's alphanumeric sender (NEWCOWORKER, overridable via ALPHA_SENDER_ID): alpha_sender set, full destination allowlist, NO numbers attached, so only the owner-alert code paths that explicitly target `TELNYX_INTL_ALPHA_PROFILE_ID` can ever ride it (the RCS rule: platform-branded senders never carry customer traffic). REFUSES success unless the readback shows the exact sender string, because Telnyx has form on 200-and-ignore writes (messaging_product, Aug 2026). First applied Aug 7 2026 (profile `40019fdc-dd03-4114-91f4-af8dc211cbd8`); activation runbook in `PRDs/alpha-sender-rollout.md`. Idempotent, dry-run by default, ledger-recorded. |
| `requeue-failed-flow-run.ts` | Re-enqueues a FAILED AiFlow run as a fresh run of the same flow, carrying the original trigger verbatim (plus a `requeued_from` marker that makes a second apply a no-op). Born from the Aug 6 2026 Canada-whitelist outage: KYP's lead flow died at its FIRST customer text (Telnyx 40309), so the lead never heard anything and the nurture sequence never ran; once the whitelist was fixed, this was the repeat inquiry the engine's own dedupe rule names as the recovery path ("a FAILED prior run never blocks"). Generic across tenants; refuses non-failed runs; vars start empty so extraction re-derives them from the copied trigger; the flow's own dedupe, quiet-hours, and business-hours gates all still apply. Idempotent, dry-run by default, ledger-recorded. First applied: KYP run 4e9fdf3c (H Eve follow-up), Aug 6 2026. |
| `widen-telnyx-destinations.ts` | International SMS Phase 2, the Telnyx side: PATCHes EVERY messaging profile on the account (enumerated live; per-tenant custom profiles like Truly Insurance's exist beyond the three platform env ids) and every outbound voice profile from their US/CA/MX whitelists to the full dial-table allowlist minus the toll-fraud denylist (~222 countries, the same data the destination gate enforces). Run ONLY after the `sms_destination_gating` migration + multiplier senders are deployed, or international sends meter at 1 unit with no guardrails. Reports (never edits) per-DID `features.sms.international_outbound`, which Telnyx derives; a false flag after widening means a live-send verification + Telnyx support ticket, not more API pokes. Idempotent, dry-run by default. |
| `patch-kyp-timezone-labels.ts` | Stops KYP Ads' two calendar flows from stating a timezone they had to guess (Aug 5 2026: a `Europe/London` lead was told her 13:00Z call was "2:00 PM Eastern time (your local time)", then told no call was starting while hers was seven minutes away, and she canceled). Drops the `invitee_tz_plain` field, whose description offered a closed five-item North American list and said to return 'Eastern' when unclear; customer copy now says "your time" and names no zone, since `invitee_local_time` already IS the invitee's wall clock. The owner notify keeps a zone as the new verbatim `invitee_timezone_iana`, because a bare "2:00 PM" is ambiguous for James. Transforms the LIVE definition and REFUSES to write when the result does not match `kyp-reminder-flow-definition.ts` (`--force` overrides), so an unledgered live edit cannot be reverted. Never adds or removes a step, so parked runs are unaffected. Idempotent, dry-run by default, ledger-recorded; transform pinned against the real pre-fix shape by `tests/oneshot-kyp-definitions.test.ts`. |
| `patch-kyp-noshow-event-title.ts` | Repairs the $200 arm of KYP Ads' no-show recovery flow, which a Calendly rename silently disconnected: the arm tests for the event title `"free strategy call | 2"`, but that event type (slug `kyp-ads-free-strategy-2`) is now titled "KYP Ads \| Free Strategy Call \| **Client**", so it can never match and every $200 no-show falls through to the $100 arm and is texted the cheaper link, which KYP's own wrong-link flow forbids. Latent so far (both runs to date were genuine $100 events). Idempotent, dry-run by default, ledger-recorded. |
| `patch-kyp-cancel-tool-policy.ts` | Writes explicit `agent_tool_settings` rows disabling `calendar_cancel_appointment` on KYP Ads' customer-facing surfaces (`sms`, `email`, derived from the registry rather than hard-coded). The account had ZERO rows, and a missing row means the registry default, which is ENABLED: that is how the assistant canceled a lead's booking itself on Aug 5 2026, against intake §7 "Cancellations or refunds: hands off, never improvises". Leaves `dashboard` enabled, the owner-operated surface. Does NOT touch the price-quoting half of §7, which is prompt behavior and James's call. Idempotent, dry-run by default, ledger-recorded. |
| `patch-kyp-bad-phone-intake.ts` | Gives KYP Ads' "Lead follow-up (white-glove build)" flow a bad-phone intake arm (Aug 1 2026: an undialable lead number killed the run at the greeting with the owner-notify step behind it): notify_owner + a lead email with the booking link when `lead_phone` extracts as "none", plus `notEquals` guards on `s_notify`/`s_wait_1` so the reply ladder collapses. Transforms the LIVE definition (never a builder overwrite); parked runs re-anchor by `__resume_step_id`, so the apply refuses only when an in-flight run lacks that marker (`--force` overrides). Idempotent, dry-run by default, ledger-recorded. Step copy is shared with `kyp-lead-flow-definition.ts` and pinned equivalent by `tests/oneshot-kyp-definitions.test.ts`. |
| `recover-amy-biennial-switch.ts` | Completes a change-plan whose Hostinger purchase "failed but charged" (HTTP 402 while the order completed server-side): re-derives the paid checkout from Stripe metadata, backs up the old box, adopts the already-paid VM as the orchestrator's injected provisioner, restores data, creates the new sub row (pointing at the canceled-but-paid Stripe sub), cancels the old monthly Stripe sub, and pools the old box with auto-renew off. `--business <uuid> --adopt-vm <vmId>`; dry-run by default, ledger-recorded. |
| `retire-stale-vps-ssh-keys.ts` | Stamps `rotated_at` on `vps_ssh_keys` rows for boxes we no longer run, so fleet sweeps stop trying to SSH into dead hardware. Nothing rotates a row when a tenant moves to *different* hardware (the partial unique index is per-VPS, so a new box never collides and never triggers a rotation), and the rows accumulate: on 2026-08-14 a chat-worker rollout printed "4/9 succeeded" with five `ssh-failed` timeouts, all five superseded boxes, while all four live tenants updated cleanly. Retires a row only when it is unrotated AND `provider = 'hostinger'` AND not the tenant's current box per `businesses.hostinger_vps_id` AND reported `stopped`/`suspended` by the live Hostinger API, and never the last active row for a business (that would orphan the tenant's break-glass access). The state check is an allow-list, not "anything but `running`": the adopt path inserts the key row before its destructive recreate, so a box mid-provision sits in `initial`/`installing` with an active row while `businesses.hostinger_vps_id` still points at the old box, and a deny-list would retire the key for the box being brought up. Non-destructive: the keypair stays, so reviving a suspended box only needs the stamp cleared. Idempotent, dry-run by default, ledger-recorded. |
| `fix-staff-contact-rows.ts` | Deletes contact rows a pre-fix AiFlow send filed for a ROSTER MEMBER (the Dave Lane defect, Jul 25 2026: a post-claim hand-off addressed the teammate through a phone var, so the engine filed them as a new customer and stamped the LEAD's name on the row). Audits every roster number for a business, or just the given `--phone` ones (repeatable); deletes only while the row still looks like the untouched artifact (type `customer`, `name_source` auto, no aliases/tags/owner/email/memory) and re-asserts that shape in the DELETE. Idempotent (a deleted row simply reports clean), dry-run by default, ledger-recorded. |
| `repoint-roster-member-phone.ts` | Moves an EXISTING `ai_flow_team_members` row onto a different phone (and optionally sets its email), in place. `apply-vfm-team.ts` upserts by (business, phone), so handing it a new number inserts a SECOND roster row; for a one-person roster that silently flips the tenant from contact-owner paging to team-broadcast claim invites, because `pickImplicitContactOwner` / `pickSoloOwner` bail on `roster.length !== 1`. Written for KYP Ads (Aug 28 2026), whose roster row carried James's Hong Kong mobile: our long codes cannot originate SMS outside NANP (ticket #557577), so every team/lead-offer text failed 409/40306 and raised `alert_delivery_failed`, the number never matched his own owner numbers so every contact-scoped alert routed `team_broadcast` / `contact_unowned`, and the roster email was therefore never read (`dispatch.ts` consults it only when `emailTarget === "contact_owner"`). Refuses a target that is not SMS-reachable (`--allow-unreachable` overrides), a target already held by another row on the business (`unique (business_id, phone_e164)`), and any selector matching other than exactly one row. Reports the solo-owner/routing consequence in the plan, and proves the write landed with a `.select()` readback rather than trusting a no-error UPDATE. Idempotent (an already-correct row reports "nothing to do"), dry-run by default, ledger-recorded. |
| `repair-misclaimed-lead-followups.ts` | Restarts the AI follow-up that a mis-routed `"1, <name>"` reply cancelled (Amy Laidlaw, Aug 2026: a teammate naming a lead that matched none of their live offers had the name read as a claim ETA, which claimed their most-recently-touched offer instead, texted the owner "<teammate> confirmed they spoke with <lead>" about a stranger, and skipped every AI rung gated on `claimed_agent == "none"`). Two fingerprints: a claim whose ETA does not read as a timeframe by the engine's own `looksLikeTimeframe`, or this script's own repair marker next to `routing.owner_assigned` (a repair the owner-assign path closed again). **Clears `contacts.owner_employee_id` before requeuing, as a precondition rather than a best effort**: a claim stamps ownership, the route step hands a lead straight back to an existing owner with no reply, and the first version of this script left that in place, so all four repaired runs re-closed within seconds and re-sent the false confirmation. The wipe is guarded on the owner still naming the mis-claimer and verified by re-read; any state it cannot positively clear (read error, no lead phone, owned by someone else now) SKIPS the run rather than requeuing it into another auto-assign. Resumes at the step AFTER the route step, the AI follow-up itself, because the human answer is already known; `--reask` rewinds onto the route step instead. Revision-gated, idempotent, dry-run by default (reads the ownership predicate rather than writing it), ledger-recorded. |

## Removed

`backfill-meta-capi-datasets.ts` never applied anywhere and was deleted the
day after it was written (Aug 13 2026). It filled `meta_connections.dataset_id`
by calling `POST /{page_id}/dataset`, an endpoint absent from Meta's public
Graph API reference that answers every caller with `(#200) App does not have
page_events permission on the Page`, identically for a page token and for a
user token holding ads_management + business_management, so no scope of ours
closes it, and `page_events` is not attached to any use case nor present in
this app's privilege list. Meta's documented platform flow has the advertiser
create the CRM dataset in Events Manager and hand over its id, so the dataset
is now an owner-entered field on /dashboard/integrations/meta.


`patch-kyp-offer-branch.ts` (and its builder's old name,
`kyp-offer-definition.ts`, now `kyp-lead-flow-definition.ts`) was retired
Aug 1 2026. The in-flow $100/$200 offer branch it applied stopped existing
between Jul 19 and Jul 24 2026: the live flow was reshaped outside the
ledger (flat steps, offer selection moved to a webhook trigger condition on
the Simple-form name, new copy, nudge window widened to 21:00), and the
decision was that the live flow is the source of truth. Re-applying the
stale builder would have reverted the tenant, so the applier was deleted and
the builder was reconciled to the live shape (plus the bad-phone arm).

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
  SSL already covers: Total TLS is only required if an operator
  deliberately nests hostnames deeper.
* Apt-lock contention between Hostinger PIS and the orchestrator's
  SSH-bootstrap is resolved via `DPkg::Lock::Timeout=300` on every
  apt-get + `cloud-init status --wait` gating in
  `buildBootstrapSshCommand` (SSH path only, never inside the
  cloud-init runcmd body, which would self-deadlock).
* The Cloudflare subzone-delegation helper (`subzone.ts` +
  `ensure-tunnel-subzone.ts`) was deleted in the same change that
  flattened tunnel hostnames to one wildcard level. Free-plan accounts
  cannot add a subdomain as a delegated zone (the dashboard explicitly
  rejects "subdomain.example.com" with "ensure you are providing the
  root domain") and the corresponding API permission group is
  paid-only, so the helper could never run on the production account
  it was written for. Single-level hostnames + Universal SSL
  obsoletes the entire migration story.

Customer PII (email, public IP, business UUID) was hard-coded in those
deleted scripts: a Cursor Bugbot Low / Medium warning surfaced this
exposure twice. Future one-shots that target a specific tenant must
read IDs from env or argv instead of hard-coding them so the file
itself stays PII-free even if the script lingers in git history.
