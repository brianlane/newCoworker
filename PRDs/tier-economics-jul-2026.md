# Tier economics & relaunch — Standard on KVM2, Starter on KVM1

_Markdown snapshot of the "Standard On KVM2 Economics" canvas, updated Jul 6 2026
after PRs #369/#371/#372 merged and deployed (starter cap rebalance, KVM2 as the
Standard default, KVM4 + admin escalation, escalation advisor cron). Sources:
live Hostinger catalog + Telnyx 90-day detailed records + Amy's Supabase usage
rollups (`debug/pull-cost-data.ts`, pulled Jul 2 2026), Gemini Live ~$0.0225/min,
Stripe 2.9% + $0.30._

## Cost model

| Input | Value | Source |
| --- | --- | --- |
| SMS outbound (blended) | $0.0159/msg | Amy's Telnyx invoice records, 90d ($7.21 / 455 msgs, incl. 10DLC carrier fees — ~2× list rate, pessimistic bound) |
| SMS inbound | $0.0063/msg | same |
| Voice (Telnyx) | ~$0.0055/min | inbound ~$0.0035 + Voice API $0.002 |
| Voice (Gemini Live) | ~$0.0225/min | vps/voice-bridge rate |
| Phone number rental | $1.10/mo | Telnyx DID |
| Stripe | 2.9% + $0.30 | biennial plans amortize the $0.30 over 24 months |

Hostinger catalog (live API, Jul 2 2026), effective $/mo:

| SKU | Monthly | 1-yr term | 2-yr term |
| --- | --- | --- | --- |
| **KVM 1 (starter default)** | $11.99 | $8.99 | $7.99 |
| **KVM 2 (standard default — flipped in PR #369)** | $24.49 | $16.99 | $14.99 |
| KVM 4 (first escalation rung — added in PR #371) | $42.99 | $30.99 | $28.99 |
| KVM 8 (enterprise/escalation ceiling) | $73.99 | $53.99 | $49.99 |

The KVM8 → KVM2 default flip for NEW Standard tenants shipped in PR #369
(`DEFAULT_TIER_VPS_SIZE.standard = "kvm2"`). Existing Standard tenants are
untouched: already-provisioned unpinned boxes still resolve to KVM8 via
`resolveDeployedVpsSize`. The escalation ladder is now
kvm1 → kvm2 → kvm4 → kvm8, operated from the admin panel (below).

We still buy monthly SKUs regardless of the customer's 1/24-month commitment.
Aligning purchase terms to commitments roughly halves hosting cost — for a
Standard tenant, $24.49 → $14.99; the KVM8→KVM2 move plus term alignment is a
$59/mo swing per tenant.

## Price margins after the relaunch (Jul 5)

Margin = revenue − Hostinger − Stripe − Telnyx − Gemini − $1.10 number.
"Typical" = ~10% of caps (Amy's real June profile); "worst case" = 100% of caps.

Starter caps after the Jul 6 rebalance (PR #369): **100 SMS/mo** (was 500),
**25 voice min** (was 10), **$5 AI budget** (unchanged). Voice is the cheapest
included unit (~$0.028/min all-in ≈ $0.70/mo at full cap) so it grew while the
expensive SMS cap shrank (full-cap SMS exposure is now ~$1.59/mo, was ~$7.95).

| Tier / price point | Hosting | Typical margin | Worst-case margin | Notes |
| --- | --- | --- | --- | --- |
| **Starter $19.99 biennial (rebalanced caps)** | KVM1 2-yr $7.99 | ≈ +$9.3/mo | ≈ **+$3.6/mo** | now profitable even at 100% of every cap |
| Starter $19.99, KVM1 monthly SKU | $11.99 | ≈ +$5.3/mo | ≈ −$0.4/mo | worst case is a ~breakeven rounding error, covered many times over by the one-time $19.50 10DLC fee; typical tenant solidly positive |
| **Standard $189 biennial** | KVM2 2-yr $14.99 | ≈ +$160.6/mo | ≈ +$102.7/mo | price held; perk gap widened instead |
| Standard $279 monthly | KVM2 monthly $24.49 | ≈ +$238/mo | ≈ +$180/mo | premium = month-to-month flexibility |

Worst-case starter math (monthly SKU): $19.99 − Stripe ~$0.88 − KVM1 $11.99 −
DID $1.10 − 100 SMS ~$1.59 − 25 min voice ~$0.70 − $5 AI ≈ **−$0.4/mo**; on the
2-yr SKU it's ≈ **+$3.6/mo**. The pre-rebalance worst case (500 SMS, $5 AI,
10 min) was ≈ −$6.9/mo on the monthly SKU — the SMS trim closed almost all of
that gap. "Near impossible to be under water" is now literal: a tenant must max
SMS + voice + AI on the monthly hardware SKU to cost ~40¢/mo, pre-10DLC-fee.

Old baselines for contrast: Standard on KVM8 monthly netted ≈ +$44/mo at full
caps (the KVM8→KVM2 move gains $49.50/mo per tenant on monthly SKUs, $59/mo
with the 2-yr term); the old Starter ($16.99, KVM2, 750 SMS, local-fallback)
lost ≈ −$16.8/mo at full cap.

**Pricing decision (Jul 3–5, reaffirmed):** hold Standard at $189/$279 and
Starter at $19.99, and widen the perk gap rather than cutting price. The
full-cap zero-margin floor for Standard is ≈ $83/mo — enormous headroom. The
price sweep stays in the canvas as the reference if conversion data ever argues
for a cut.

Two structural leaks closed this week protect these margins:

1. **Automatic DID release (PR #363)** — terminal teardown (grace expiry or
   admin force-cancel) now releases the tenant's Telnyx number; a leaked DID is
   $1.10/mo forever. Numbers deliberately survive the grace window so a
   reactivating tenant keeps their line. A failed/skipped release emails ops
   instead of silently renting.
2. **VPS reuse pool (PR #348)** — cancellations return boxes to
   `vps_inventory`; provisioning adopts owned boxes before buying. Critical
   because the Hostinger 180-day refund lockout (active since Jul 3, resets
   ≈ Dec 30 2026) makes every purchase committed spend.

## Starter relaunch — final shape (all shipped)

- **KVM1 default hardware, no local Ollama at all** (PR #360, merged +
  migration applied). Over-cap AI turns refuse with an honest "budget used up"
  message — the budget fuse cannot be defeated by silent local degrade.
  Smoke-proven Jul 5 on VM 1806097: 1.1 GB used of 4 GB with the full stack,
  2-concurrent voice PASS, owner chat 1.7 s, bootstrap 66 s.
- **SMS cap 750 → 500 (PR #347) → 100, voice 10 → 25 min (PR #369)** — the
  Jul 6 rebalance that makes a full-cap starter profitable (see margins above).
  Enforced in Postgres (`nonenterprise_monthly_sms_cap`, prod migration
  applied), the Edge reservation path, and app `TIER_LIMITS` together.
- **Honest browser copy (PR #369)** — pricing/onboarding now says starter's
  "Browser can read public web pages" (static fetches only — no render
  sidecar, no headless browser on KVM1) vs Standard's "Full browser skills —
  operates websites like a person (logins, forms, portals)".
- **10DLC carrier fee ($19.50) passed through at checkout** (PR #350).
- **Renewal $16.99 → $19.99** — decided; pricing page + Stripe update is the
  one remaining item.
- **Starter test tenant live**: the KVM1 smoke clone was repurposed as a real
  `tier=starter` business on srv1806097 (lapses ~Aug 5), so starter UX/limits
  are testable end to end. Its DID (+1 602 313 1823) was released through the
  new PR #363 path — a real-world exercise of that code.

## Standard perk gap — status

| Perk | Marginal cost/tenant | Status |
| --- | --- | --- |
| Zapier "8,000+ integrations" | ≈ $0 (webhook egress is noise) | **SHIPPED — PR #364**; Zapier directory review pending |
| RCS branded messaging | **NOT ~$0 — $600 one-time + $100/mo per agent** (Telnyx, Jul 18 2026) | **Moved to Enterprise-only** — see "RCS: Enterprise-only decision" below |
| Auto-text on missed calls, scheduled/template SMS, AI call summaries, analytics + spike alerts | ≈ $0 | Shipped — PRs #352–#355 |
| Extra phone numbers | $1.10 each (sell $5/mo, ~78% margin) | Decided |
| White-glove onboarding | founder hours ($750 / $2,000 tiers) | Merged — PR #351 |
| Concurrent calls 3 → 10 advertised | $0 (Tier-1 Gemini TPM is the ceiling) | Hardware proven to 20/box; ~45 fleet-wide on Tier 1; 50+ = Enterprise after Vertex migration |

### Zapier integration (PR #364) — what shipped

- Per-business **API keys**: SHA-256-hashed bearer tokens, dashboard-managed
  (integrations page card), DB-level caps via `BEFORE INSERT` triggers with
  advisory locks (concurrent mints can't exceed the cap; routes map the
  violation to 409).
- **Public REST API** at `/api/public/v1/*`: `me`, `messages` (send SMS),
  `events` (samples, same readiness gate as the dispatcher), `hooks`
  (REST-hook subscribe/unsubscribe). CSRF-exempt; bearer-auth only.
- **Webhook dispatcher**: Supabase Edge Function on cron with tuple-cursor
  `(timestamp, id)` keyset pagination (no skips on duplicate timestamps),
  per-delivery 10 s timeouts, lease claiming (`locked_until`) against
  overlapping ticks, best-effort lease release + cursor persistence on failure,
  and a readiness gate holding `call.completed` until the summary is populated
  (or a 10-min grace lapses). `occurred_at` reflects the event's real timestamp
  (`ended_at` for calls).
- **Zapier Platform CLI app** (`zapier/`): triggers for SMS received/sent,
  call completed, email activity; send-SMS action.
- Follow-ups already handled: `owner_scheduled` restored in the
  `sms_outbound_log` source constraint (PR #365, applied to prod); Dependabot
  high-severity `form-data` CRLF-injection alert in `zapier/package-lock.json`
  fixed by overriding to ≥ 4.0.6 (PR #366).

## RCS: Enterprise-only decision (Jul 18 2026)

The original "~$0 fixed" cost assumption was wrong, and testing-phase findings
killed the shared-agent-as-Standard-perk model entirely:

- **Real Telnyx fees**: production provisioning of an RCS agent is a one-time
  **$600 carrier fee + $100/mo recurring, PER AGENT** (Telnyx compliance email
  for `new_coworker_jut3q1af_agent`, Jul 2026). The testing phase (registered
  tester numbers only) is free.
- **A shared agent is structurally single-tenant.** RCS inbound payloads carry
  NO recipient DID — only the agent id (`to[].agent_id`), which
  `telnyx-sms-inbound` resolves against `business_channel_settings` expecting
  exactly one row. Two tenants on one agent id = every customer reply
  unroutable (dropped as `sms_inbound_rcs_unrouted`). Not fixable: the
  disambiguating information does not exist in the payload.
- **The agent's brand replaces the tenant's identity.** On an RCS handset the
  thread shows the AGENT's verified name/logo (e.g. "New Coworker"), not the
  tenant's business name or phone number. Verified on iOS 18 Jul 18 2026.
- **Decision**: `rcsTierAllowed` = enterprise only (both mirrors); RCS removed
  from Standard marketing everywhere; sold as a per-tenant **branded agent**
  Enterprise line item — the tenant's own Google-verified sender — priced
  cost-plus with a floor of 2x Telnyx fees (suggested list: $1,500 one-time
  setup + $250/mo). The platform's shared agent stays reserved for our own
  HQ/platform traffic.
- **Testing-phase results (HQ tenant, Jul 18 2026)**: outbound RCS-first
  delivered as true RCS to a Verizon tester (verified sender rendered, cost
  **$0.011/msg** vs the $0.0065 list rate); Telnyx-side fallback demoted a
  non-tester send to plain SMS from the tenant's DID automatically; inbound
  required BOTH `profile_id` AND `webhook_url` set on the agent (Telnyx
  provisions neither — set them via
  `PATCH /v2/messaging/rcs/agents/{agent_id}` or inbound replies are silently
  dropped at Telnyx). Testers register via
  `PUT /v2/messaging/rcs/test_number_invite/{agent_id}/{phone}`.

### Enterprise RCS onboarding — e2e test runbook (run per branded agent)

When an Enterprise deal includes branded RCS, every new agent must pass this
end-to-end checklist before the tenant's `rcs_enabled` flips on. It encodes
every failure mode hit during the Jul 18 2026 shared-agent testing phase.

1. **Create the tenant's own branded agent** with Telnyx (tenant brand name,
   logo, Google verification). It starts in the free testing phase; the $600 +
   $100/mo carrier fees only apply at production provisioning — collect the
   deal's setup/recurring pricing (floor 2x fees) before submitting the form.
2. **Patch the agent's plumbing — Telnyx provisions NEITHER field**:
   `PATCH /v2/messaging/rcs/agents/{agent_id}` with `profile_id` = the
   TENANT's messaging profile and `webhook_url` =
   `https://<supabase>/functions/v1/telnyx-sms-inbound`. Skipping this drops
   every inbound RCS reply silently at Telnyx (no webhook, no telemetry —
   Telnyx detail records show `received` with nothing forwarded).
3. **Register a tester**:
   `PUT /v2/messaging/rcs/test_number_invite/{agent_id}/{phone}` — Verizon
   handset recommended (AT&T/T-Mobile restrict tester enrollment), RCS-capable
   (Android or iPhone iOS 18+), and the invite must be ACCEPTED on the phone
   before delivery works.
4. **Wire the tenant** from the admin business page "Messaging channel (RCS)"
   card (agent id + enable; audit-logged via `POST /api/admin/rcs-channel`).
   The badge must read "RCS-first (SMS fallback)" — it mirrors the full
   send-time gate (enterprise tier ∧ enabled ∧ agent id ∧ SMS from-number),
   so a "Plain SMS" badge tells you which precondition is missing.
5. **Outbound e2e**: dashboard composer → tester number. Verify
   `sms_outbound_log.channel = 'rcs'`, the RCS badge on the thread, the
   tenant's verified brand rendering on the handset, and the actual per-msg
   cost on the Telnyx message record (observed $0.011 vs $0.0065 list —
   confirm deal margins against reality).
6. **Fallback e2e**: send to a non-tester number. Telnyx demotes it
   asynchronously — the message record flips to `type: SMS` sent from the
   tenant's own DID (our code's re-send branch is only a second net for hard
   API rejections). Note: VoIP-destination test sends may spam-filter
   (error 40002); that is the destination, not the channel.
7. **Inbound e2e**: reply from the tester handset. Verify the job lands with
   `sms_inbound_jobs.channel = 'rcs'`, the AI reply goes out, and
   `reply_channel` is populated. If nothing lands, re-check step 2.
8. **Per-message override**: with RCS on, the composer's "Send as plain SMS
   (skip RCS)" checkbox must force `channel = 'sms'` for that message.
9. **NEVER point two tenants at one agent id.** Inbound routing resolves
   agent → business expecting exactly one `business_channel_settings` row;
   a duplicate makes every customer reply for BOTH tenants drop as
   `sms_inbound_rcs_unrouted`.
10. **Production cutover**: only after 1–9 pass, submit the RCS carrier form
    (traffic estimates + website traffic) and accept the fees; carrier
    provisioning takes weeks (`provisioned_carriers` on the agent shows
    progress). Re-run steps 5–8 once carriers go live, since tester-phase
    delivery and carrier delivery are different paths.

## Hardware escalation — how KVM4/KVM8 moves happen (PRs #371 + #372)

Escalation is **manual by design**; the system advises, the operator moves:

- **Admin panel migrate-size (PR #371)**: each business's admin page has a
  Hardware card (current size + pin state) with a size picker. The API
  (`POST /api/admin/vps/:id/migrate-size`) answers 202 and runs the full
  snapshot → tarball backup → provision-at-target (pool-adopt first) →
  restore → billing repoint → old-box stop + auto-renew-off flow in the
  background, fail-closed at every stage, with started/completed/failed ops
  emails. A self-expiring DB lease (`vps_migration_locks`, 30 min) blocks
  overlapping runs with a 409. Replaces `debug/migrate-vps-size.ts`.
- **Escalation advisor cron (PR #372)**: daily 14:00 UTC scan of every active
  starter/standard tenant over a rolling 7-day window. Signals: ≥2 days at
  the concurrency cap, voice pace ≥80% of the included pool, month-to-date
  SMS ≥80% of cap, ≥25 error-level on-box logs (rowboat/ollama/voice). One
  ops digest email per run with the recommended next rung
  (kvm1→kvm2→kvm4→kvm8) and a deep link to the admin panel; per-tenant weekly
  dedupe; a warn `system_logs` row lands on the tenant's admin page after the
  digest sends. Deployed + scheduled in prod; smoke-invoked Jul 6
  (`scanned:1, flagged:0`).
- **Customer-driven tier changes** (starter → standard checkout) still move
  hardware automatically via the change-plan orchestrator and email ops at
  the start (PR #363) — that path is entitlements + hardware; the admin
  migrate-size path is hardware only.

## Fleet & constraints (Jul 5)

| VM | Plan | State | Disposition |
| --- | --- | --- | --- |
| srv1632631 | KVM 8 hardware, pooled as `kvm2` | pooled (available) — old Amy box (cutover done) | in `vps_inventory` as available with plan=`kvm2` on purpose (Jul 12) so a normal standard signup adopts it; **`never_renew` flag set** — the box lapses Jul 30 no matter what (adopt skips the renewal re-enable, posture cron skips the auto-heal and nags ops daily to migrate any adopted tenant to a real kvm2 via `debug/migrate-vps-size.ts` before the deadline) |
| **srv1800980** | KVM 2 | **Amy PRODUCTION** | cutover complete Jul 5; in `vps_inventory` as assigned |
| srv1800985 | KVM 2 | pooled (available) | adopt for a signup before Aug 2 or let it lapse |
| srv1806097 | KVM 1 | **starter test tenant** | live testbed; lapses ~Aug 5 |
| srv1806114 | KVM 1 | Phase E smoke box (idle) | lapses ~Aug 5 unless adopted |
| srv1798267/257 | KVM 2 | deleted, refunded $15.15 each | consumed the 180-day refund allowance |

- **Hostinger refund lockout**: no VPS purchase refundable until ≈ Dec 30 2026 —
  exhaust the reuse pool before buying.
- **Gemini Live TPM** is the only concurrency ceiling that matters: Tier 1 =
  150K tokens/min fleet-wide ≈ 45 simultaneous calls (~3.2K tokens/min/call
  measured). Tier 2 (400K) at $250 cumulative spend + 30 days; Vertex AI =
  1,000 sessions for Enterprise-scale promises. Advertise 10 concurrent
  calls/tenant on Standard today.

## Execution status (Jul 6 2026)

| Step | State |
| --- | --- |
| Tier/hardware decoupling (`vps_size`) | Merged — PR #331 |
| Amy live cutover KVM8 → KVM2 (srv1800980) | DONE — production |
| Billing leak fix (auto-renew disable + ops email) | Merged — PR #346 |
| Tier entitlements (10 concurrent, SMS 500, BYON gate) | Merged — PR #347 |
| VPS reuse pool (`vps_inventory` + adopt-first) | Merged — PR #348 |
| 10DLC fee pass-through at checkout | Merged — PR #350 |
| White-glove onboarding packages | Merged — PR #351 |
| Standard perks (auto-text, scheduled SMS, summaries, analytics, alerts) | Merged — PRs #352–#355 |
| KVM1 starter smoke (Phase E) | PASSED Jul 5 |
| KVM1 starter default, no local fallback | Merged — PR #360; prod migration applied |
| Admin view-as + activity-feed email/retention | Merged — PR #361 |
| Automatic DID release + ops-failure email | Merged — PR #363 |
| Ops email at hardware-escalation start | Merged — PR #363 |
| Zapier end to end | Merged — PR #364; deployed; directory review pending |
| `sms_outbound_log` constraint fix | Merged — PR #365; applied to prod |
| Starter test tenant | Live on srv1806097 |
| Starter caps 100 SMS / 25 min + browser copy + KVM2 standard default | Merged — PR #369; prod migration applied; voice Edge fns redeployed |
| KVM4 size + admin migrate-size panel + in-flight lease | Merged — PR #371; prod migrations applied |
| Hardware-escalation advisor cron + ops digest | Merged — PR #372; deployed + scheduled (14:00 UTC daily); smoke-invoked OK |
| Telnyx RCS agent registration | Testing phase live (HQ tenant, Jul 18 2026); production provisioning DEFERRED ($600 + $100/mo) — Enterprise-only per the RCS decision above |
| **Starter $19.99 renewal on pricing page + Stripe** | **Remaining** |
