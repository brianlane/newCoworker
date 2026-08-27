---
name: residency-read-rules
description: residency moved-table read routing (purged vs kept), 72h purge floor, replay-cron gate
metadata:
  type: project
---

## project_residency_read_seam_gaps

Reads of `RESIDENCY_MOVED_TABLES` must go through `isVpsReadMode` + `readMovedRows`/`countMovedRows`. A central `db.from("contacts")` on a `vps` tenant returns zero rows WITHOUT erroring, so the gap is silent. Writes need no seam: a DB trigger journals them and `replay.ts` ships them.

Audited and routed 2026-08-20 across three PRs: #1563 (7 modules in `src/lib/analytics/`), #1565 (5 routes / 10 sites in `src/app/api/dashboard/`), #1567 (3 `ai_flows` reads in `src/lib/ai-flows/db.ts`, merged `e0bd48b6f`). All 10 tenants are `data_residency_mode = supabase`, so every one of these was latent, never a live outage.

**Why:** two failure modes bit that are not obvious from the seam's API.

1. The box schema can lack a column the routed read projects. `vps/data-api/schema.sql` was generated from a 2026-07-07 snapshot then hand-patched, so it was missing `ai_flows.enabled_changed_at`; the routing would have failed the whole SELECT on a real box, fixing nothing. `tests/residency-box-schema-columns.test.ts` now pins `contacts` and `ai_flows` columns to their readers.
2. The right failure mode differs per call site. A page read should let `ResidencyReadError` propagate (an empty list reads as "you have no leads"). But `enqueueAiFlowRun`'s read sits in a `try` whose documented contract is "on a read failure both gates default to no gate, losing the lead is worse than a duplicate", so its box read went INSIDE that same `try`. Throwing there would have refused a live lead over a briefly unreachable box.

**How to apply:** when routing a read, (a) confirm every projected column exists in `vps/data-api/schema.sql` and add it to the guard test, (b) decide propagate-vs-swallow from what the caller already does on failure, never uniformly, (c) remember the box wire grammar is AND-only (`eq/neq/gt/gte/lt/lte/like/ilike/in/is`), no OR, no array-overlap, and it rejects an empty `in`. Test patterns live in `tests/residency-read-flip.test.ts`.

Still unrouted on purpose: the Edge functions (`telnyx-sms-inbound`, `sms-inbound-worker`, `contact_events.ts`) read `ai_flows` centrally with no seam at all. That is the real inbound-automation trigger path; `src/lib/residency/contract.ts` names the Edge `_shared` helpers as intended future callers, so it is unbuilt program work. See [[project_postgrest_1000_row_cap]] and [[feedback_verify_the_column_is_written]].

## project_residency_purge_floor_and_cron_gate

Two residency invariants were documented in the runbook and enforced by nothing until PR #1569 (merged `aab6f2f2a`, 2026-08-20). Both failed SILENTLY, which is why neither had been noticed.

**Keep-hours floor.** `residency_purge_business` took any `p_keep_hours >= 0`. The engine reads purged tables over fixed windows, the widest exactly the purge default, so there was zero margin: `CONTACT_TIMELINE_LOOKBACK_HOURS` 72h (feeds the model's prompt), `FLOW_CONTEXT_LOOKBACK_HOURS` 72h, `SAID_LOOKBACK_HOURS` 72h, `CALL_SUMMARY_WINDOW_HOURS` 48h, `NEEDS_HUMAN_REPAGE_HOURS` 24h, `DEFAULT_DIAL_WINDOW_HOURS` 24h. `--keep-hours 24` was accepted and would delete rows the coworker was about to read: no error, just a shorter memory mid-conversation. Now floored at 72 in BOTH `debug/residency-purge.ts` and the RPC, since the RPC is callable without the wrapper. Inventory + lockstep in `src/lib/residency/keep-window.ts`.

**The floor cannot simply rise** to cover a wider window: the RPC documents `default 72`, so a 168h floor would make every default call fail and break runbook step 4. Hence a second list, `RESIDENCY_WINDOWS_OUT_OF_SCOPE`, for windows a purge cannot reach at all. Its one member is `ADVISOR_WINDOW_DAYS` (7d): the hardware advisor filters `.in("tier", ["starter","standard"])` and residency is enterprise-only, so the populations are provably disjoint. The test pins that tier filter as EVIDENCE, so widening the advisor fails the test rather than silently voiding the exemption.

**Replay-cron gate.** `edge-residency-replay` is deliberately unscheduled while zero tenants use residency, and `dual` replicates NOTHING without it: the journal just grows. `updateDataResidencyMode` checked only the tier gate, so the admin card would flip a tenant to `dual`, report success, and replicate nothing. Now gated on `residency_replay_cron_active()` (a SECURITY DEFINER RPC, because `cron.job` is unreachable through the Data API). Verified live 2026-08-20: it returns **false**, so the cron really is off.

**Why:** fails CLOSED including when the check itself errors. Wrongly allowing builds a journal found late and by hand; wrongly blocking stops a rare maintenance action with a message naming the runbook step. Turning residency OFF stays unconditional, matching the tier gate, so a tenant can never be wedged forward.

**How to apply:** a new typed error thrown from a `src/lib/db/*` writer must also be special-cased in the calling route, or `handleRouteError` turns it into a bare 500 and the actionable message is lost. Bugbot caught exactly that here. See [[project_residency_read_seam_gaps]].
