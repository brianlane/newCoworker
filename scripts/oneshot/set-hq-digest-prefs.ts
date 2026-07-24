#!/usr/bin/env tsx
/**
 * One-shot: quiet the HQ tenant's digest emails (Brian's request, Jul 24 2026).
 *
 * Why: the "Team inbox triage (HQ)" AiFlow polls team@newcoworker.com all day
 * and every run counted as digest activity, so the daily summary email fired
 * every morning saying nothing but "triage ran N times, done". Brian lives in
 * that inbox already; the digest itself was the noise. Two changes:
 *
 *   - digest_customer_facing_only = true: the daily digest now sends only
 *     when a customer actually reached the business (texts, calls, new
 *     customers, urgent alerts). Routine-only windows skip with reason
 *     no_customer_facing_activity.
 *   - email_digest_weekly = false: no weekly roll-up either (config only,
 *     re-enable any time from Dashboard -> Settings -> Notifications).
 *
 * Uses getOrCreateNotificationPreferences + updateNotificationPreferences
 * (the settings-page core), so a missing prefs row is created with the same
 * defaults the dashboard would use. Idempotent: re-running detects the
 * already-set values. Dry-run by default; records to applied_oneshots on
 * --apply.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-hq-digest-prefs.ts          # dry run
 *   npx tsx scripts/oneshot/set-hq-digest-prefs.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { getOrCreateNotificationPreferences, updateNotificationPreferences } = await import(
  "../../src/lib/db/notification-preferences.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d"; // New Coworker (HQ, internal)

const TARGET = {
  digest_customer_facing_only: true,
  email_digest_weekly: false
} as const;

const db = await createSupabaseServiceClient();
const current = await getOrCreateNotificationPreferences(HQ_BUSINESS_ID, { client: db });

console.log("[hq-digest-prefs] current:", {
  email_digest: current.email_digest,
  email_digest_weekly: current.email_digest_weekly,
  digest_customer_facing_only: current.digest_customer_facing_only ?? false,
  unsubscribed_at: current.unsubscribed_at
});

const changes: string[] = [];
if ((current.digest_customer_facing_only ?? false) !== TARGET.digest_customer_facing_only) {
  changes.push(`digest_customer_facing_only -> ${TARGET.digest_customer_facing_only}`);
}
if (current.email_digest_weekly !== TARGET.email_digest_weekly) {
  changes.push(`email_digest_weekly -> ${TARGET.email_digest_weekly}`);
}

if (changes.length === 0) {
  console.log("[hq-digest-prefs] already set, nothing to do.");
  process.exit(0);
}
for (const c of changes) console.log(`[hq-digest-prefs] will set ${c}`);

if (!APPLY) {
  console.log("[hq-digest-prefs] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const updated = await updateNotificationPreferences(HQ_BUSINESS_ID, { ...TARGET }, db);
console.log("[hq-digest-prefs] updated:", {
  email_digest: updated.email_digest,
  email_digest_weekly: updated.email_digest_weekly,
  digest_customer_facing_only: updated.digest_customer_facing_only
});

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "set-hq-digest-prefs.ts",
  businessId: HQ_BUSINESS_ID,
  details: { changes, target: TARGET }
});
console.log(
  "[hq-digest-prefs] ledger recorded. Daily digests now skip routine-only days " +
    "(reason no_customer_facing_activity); weekly digest is off."
);
process.exit(0);
