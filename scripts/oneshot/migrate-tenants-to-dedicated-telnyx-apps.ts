#!/usr/bin/env tsx
/**
 * One-shot: move every live tenant onto a DEDICATED Telnyx Call Control app
 * + outbound voice profile (per-tenant carrier concurrency caps).
 *
 * Why: the whole fleet shared ONE app (2937312861107521228) and ONE profile
 * (2937323607140861695), so all tenants contended for the same carrier-side
 * concurrent-channel pool; on 2026-08-16 a morning burst from a single
 * tenant hit the account's channel limit and a lead's first-contact call was
 * rejected with HTTP 403. Provisioning now creates per-tenant infra for NEW
 * tenants (src/lib/telnyx/tenant-voice-infra.ts wired into orchestrate);
 * this script converges the tenants that already exist.
 *
 * Per tenant with a DID (telnyx_voice_routes row):
 *   1. Mid-call guard: skip (exit non-zero at the end) when the tenant has
 *      any in-flight voice_reservations (pending_answer/active) or a live
 *      voice_active_sessions row (ended_at null AND last_seen_at fresh):
 *      re-pointing a DID mid-call is safe for the leg in flight (Telnyx
 *      binds the connection at call creation) but we hold the discipline
 *      anyway, matching redeploy-voice-bridge.
 *   2. ensureTenantVoiceInfra: create-or-adopt app + profile named
 *      "<name> [nc:<businessId>]", limits = the tenant's plan concurrency,
 *      $25/day fuse, full destination whitelist (monotone union on adopt).
 *   3. PATCH the DID onto the tenant app.
 *   4. Upsert business_telnyx_settings.telnyx_connection_id + the new
 *      telnyx_outbound_voice_profile_id.
 *
 * Internal sandboxes have no DID, so they are skipped naturally.
 * Idempotent: adoption-by-marker means a re-run PATCHes instead of
 * duplicating. Dry-run by default.
 *
 * AFTER running: update each touched tenant dossier in docs/tenants/ (the
 * PR that ships this script stamps them with "pending one-shot"), and run
 * `npx tsx debug/telnyx-capacity.ts` to verify the per-tenant caps.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts            # dry run
 *   npx tsx scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts --apply
 *   npx tsx scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts --apply --business <uuid>
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { TelnyxNumbersClient } = await import("../../src/lib/telnyx/numbers.ts");
const {
  TelnyxVoiceInfraClient,
  ensureTenantVoiceInfra,
  resolveTenantMaxConcurrentCalls,
  voiceDispatchWebhookUrl
} = await import("../../src/lib/telnyx/tenant-voice-infra.ts");
const { upsertBusinessTelnyxSettings } = await import("../../src/lib/db/telnyx-routes.ts");

const APPLY = process.argv.includes("--apply");
const onlyBusinessIdx = process.argv.indexOf("--business");
const ONLY_BUSINESS = onlyBusinessIdx >= 0 ? process.argv[onlyBusinessIdx + 1] : null;

/** A session row counts as live only when unended AND freshly heartbeaten. */
const LIVE_SESSION_FRESH_MS = 3 * 60_000;

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const TELNYX_KEY = process.env.TELNYX_API_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY || !TELNYX_KEY) {
  console.error("need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_API_KEY in .env");
  process.exit(2);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const infra = new TelnyxVoiceInfraClient({ apiKey: TELNYX_KEY });
const numbers = new TelnyxNumbersClient({ apiKey: TELNYX_KEY });
const webhookUrl = voiceDispatchWebhookUrl(SUPABASE_URL);

type RouteRow = { to_e164: string; business_id: string };
type BusinessRow = { id: string; name: string | null; tier: string | null; enterprise_limits: unknown };

async function tenantIsMidCall(businessId: string): Promise<string | null> {
  const { data: resRows, error: resErr } = await db
    .from("voice_reservations")
    .select("call_control_id, state")
    .eq("business_id", businessId)
    .in("state", ["pending_answer", "active"])
    .limit(5);
  if (resErr) return `reservation read failed: ${resErr.message}`;
  if ((resRows ?? []).length > 0) {
    return `${(resRows ?? []).length} in-flight reservation(s)`;
  }
  const freshIso = new Date(Date.now() - LIVE_SESSION_FRESH_MS).toISOString();
  const { data: sessRows, error: sessErr } = await db
    .from("voice_active_sessions")
    .select("call_control_id")
    .eq("business_id", businessId)
    .is("ended_at", null)
    .gte("last_seen_at", freshIso)
    .limit(5);
  if (sessErr) return `session read failed: ${sessErr.message}`;
  if ((sessRows ?? []).length > 0) return `${(sessRows ?? []).length} live media session(s)`;
  return null;
}

const { data: routes, error: routesErr } = await db
  .from("telnyx_voice_routes")
  .select("to_e164, business_id")
  .order("to_e164");
if (routesErr) {
  console.error(`telnyx_voice_routes read failed: ${routesErr.message}`);
  process.exit(2);
}

let skippedMidCall = 0;
let converged = 0;
let failed = 0;

for (const route of (routes ?? []) as RouteRow[]) {
  if (ONLY_BUSINESS && route.business_id !== ONLY_BUSINESS) continue;

  const { data: bizRow, error: bizErr } = await db
    .from("businesses")
    .select("id, name, tier, enterprise_limits")
    .eq("id", route.business_id)
    .maybeSingle();
  if (bizErr || !bizRow) {
    console.error(`${route.to_e164}: business ${route.business_id} read failed, skipping`);
    failed += 1;
    continue;
  }
  const biz = bizRow as BusinessRow;
  const maxConcurrent = resolveTenantMaxConcurrentCalls(biz.tier, biz.enterprise_limits);
  console.log(
    `\n${biz.name ?? biz.id} (${biz.id})\n  DID ${route.to_e164}, tier ${biz.tier ?? "starter"}, carrier cap ${maxConcurrent}`
  );

  const midCall = await tenantIsMidCall(biz.id);
  if (midCall) {
    console.log(`  SKIP: mid-call guard (${midCall}); re-run later`);
    skippedMidCall += 1;
    continue;
  }

  if (!APPLY) {
    console.log(
      `  DRY-RUN: would ensure app+profile "[nc:${biz.id}]", point ${route.to_e164} at the app, upsert settings`
    );
    continue;
  }

  try {
    const result = await ensureTenantVoiceInfra(
      { infra, numbers },
      {
        businessId: biz.id,
        businessName: biz.name ?? "Tenant",
        maxConcurrentCalls: maxConcurrent,
        webhookUrl,
        didE164: route.to_e164
      }
    );
    await upsertBusinessTelnyxSettings({
      businessId: biz.id,
      telnyxConnectionId: result.connectionId,
      telnyxOutboundVoiceProfileId: result.outboundVoiceProfileId
    });
    console.log(
      `  ${result.createdApp ? "created" : "adopted"} app ${result.connectionId}, ` +
        `${result.createdProfile ? "created" : "adopted"} profile ${result.outboundVoiceProfileId}, DID re-pointed`
    );
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "migrate-tenants-to-dedicated-telnyx-apps",
      businessId: biz.id,
      details: {
        did: route.to_e164,
        connection_id: result.connectionId,
        outbound_voice_profile_id: result.outboundVoiceProfileId,
        max_concurrent: maxConcurrent,
        created_app: result.createdApp,
        created_profile: result.createdProfile
      }
    });
    converged += 1;
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

console.log(
  `\n${APPLY ? "applied" : "dry-run"}: ${converged} converged, ${skippedMidCall} skipped mid-call, ${failed} failed`
);
// A skip must never read as done: non-zero exit when anything was left over.
process.exit(skippedMidCall > 0 || failed > 0 ? 1 : 0);
