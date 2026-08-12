/**
 * Backfill Conversions API dataset ids for direct Meta connections that
 * predate the app's App Review approval (decided Aug 11, 2026).
 *
 * Connect-time dataset discovery (`POST /{page_id}/dataset`, get-or-create)
 * returned null for every connection made while the app lacked the ads
 * scopes, and only a reconnect retried it, so pre-approval connections have
 * `dataset_id NULL` and their Conversion Leads feedback loop stays dark.
 * The capi drain now self-heals a dark connection when a stage event flows,
 * but this backfill activates them deterministically instead of waiting for
 * the next lead to convert.
 *
 * Global sweep (no per-tenant arguments needed): every ACTIVE connection
 * with a page token and no dataset. `--business <uuid>` narrows to one.
 * Idempotent: once dataset_id is set the row is no longer a candidate, and
 * Meta's endpoint is itself get-or-create. Dry-run by default; `--apply`
 * writes.
 *
 *   tsx scripts/oneshot/backfill-meta-capi-datasets.ts            # dry run
 *   tsx scripts/oneshot/backfill-meta-capi-datasets.ts --apply    # land it
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business");
const ONLY_BUSINESS = bizFlag >= 0 ? (process.argv[bizFlag + 1] ?? null) : null;

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { recordOneshotApplied } = await import("./_ledger.ts");
  const { getMetaConnection, setMetaConnectionDataset } = await import(
    "../../src/lib/db/meta-connections.ts"
  );
  const { getOrCreatePageDataset } = await import("../../src/lib/meta/client.ts");

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { persistSession: false } }
  );

  let query = db
    .from("meta_connections")
    .select("business_id,page_id,page_name")
    .eq("status", "active")
    .eq("is_active", true)
    .is("dataset_id", null);
  if (ONLY_BUSINESS) query = query.eq("business_id", ONLY_BUSINESS);
  const { data: candidates, error } = await query;
  if (error) throw new Error(`candidate select: ${error.message}`);

  if (!candidates || candidates.length === 0) {
    console.log("[backfill] no active connections missing a dataset — nothing to do");
    return;
  }
  console.log(`[backfill] ${candidates.length} candidate connection(s):`);
  for (const c of candidates) {
    console.log(`  - business ${c.business_id} page ${c.page_id} (${c.page_name ?? "?"})`);
  }
  if (!APPLY) {
    console.log("[backfill] dry run complete. Re-run with --apply to discover and persist.");
    return;
  }

  const results: Array<{ businessId: string; pageId: string | null; datasetId: string | null }> =
    [];
  for (const c of candidates) {
    const conn = await getMetaConnection(c.business_id);
    if (!conn?.pageToken || !conn.page_id) {
      console.log(`  ! ${c.business_id}: no page token on the decrypted row, skipped`);
      results.push({ businessId: c.business_id, pageId: c.page_id, datasetId: null });
      continue;
    }
    const datasetId = await getOrCreatePageDataset(conn.page_id, conn.pageToken);
    if (!datasetId) {
      console.log(`  ! ${c.business_id}: discovery returned null (token still lacks scopes?)`);
      results.push({ businessId: c.business_id, pageId: conn.page_id, datasetId: null });
      continue;
    }
    await setMetaConnectionDataset(c.business_id, datasetId);
    console.log(`  ✓ ${c.business_id}: dataset ${datasetId} persisted`);
    results.push({ businessId: c.business_id, pageId: conn.page_id, datasetId });
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "backfill-meta-capi-datasets.ts",
    businessId: ONLY_BUSINESS,
    details: { results }
  });
  const won = results.filter((r) => r.datasetId).length;
  console.log(`[backfill] done: ${won}/${results.length} connection(s) now carry a dataset`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
