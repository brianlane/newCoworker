/**
 * Re-subscribe every connected Page to the CURRENT webhook field list.
 *
 *   npx tsx debug/meta-resubscribe-pages.ts            # dry run
 *   npx tsx debug/meta-resubscribe-pages.ts --apply
 *
 * WHY: a Page's webhook subscription is fixed at the moment it is connected
 * (src/app/api/integrations/meta/route.ts calls subscribePageToLeadgen once).
 * Adding a field to META_PAGE_SUBSCRIBED_FIELDS therefore does NOTHING for
 * Pages already connected: Meta keeps delivering the old set, and the new
 * handler sits there receiving nothing. That is exactly what happened when
 * `feed` was added for Facebook Page comments.
 *
 * Idempotent: POSTing subscribed_apps with the full field list replaces the
 * subscription, so re-running is safe and re-running after a future field is
 * added is the intended use.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const apply = process.argv.includes("--apply");

async function main() {
  const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
  const { getMetaConnection } = await import("../src/lib/db/meta-connections.ts");
  const { META_PAGE_SUBSCRIBED_FIELDS, META_GRAPH_BASE_URL, subscribePageToLeadgen } =
    await import("../src/lib/meta/client.ts");

  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("meta_connections")
    .select("id,business_id,page_id,page_name")
    .eq("status", "active")
    .eq("is_active", true)
    .not("page_id", "is", null)
    .limit(500);
  if (error) throw new Error(`read: ${error.message}`);

  const rows = (data ?? []) as {
    business_id: string;
    page_id: string;
    page_name: string | null;
  }[];
  console.log(
    `target fields: ${META_PAGE_SUBSCRIBED_FIELDS.join(", ")}\n` +
      `${rows.length} active connection(s)${apply ? "" : " (dry run)"}\n`
  );

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const conn = await getMetaConnection(row.business_id);
    if (!conn?.pageToken) {
      failed += 1;
      console.log(`  SKIP  ${row.page_name ?? row.page_id}: no page token`);
      continue;
    }
    // Report what Meta currently has, so a dry run is worth reading.
    const url = new URL(`${META_GRAPH_BASE_URL}/${row.page_id}/subscribed_apps`);
    url.searchParams.set("access_token", conn.pageToken);
    const current = (await (await fetch(url)).json().catch(() => null)) as {
      data?: { subscribed_fields?: string[] }[];
    } | null;
    const have = current?.data?.[0]?.subscribed_fields ?? [];
    const missing = META_PAGE_SUBSCRIBED_FIELDS.filter((f) => !have.includes(f));

    if (missing.length === 0) {
      ok += 1;
      console.log(`  OK    ${row.page_name ?? row.page_id}: already subscribed to all fields`);
      continue;
    }
    if (!apply) {
      console.log(`  WOULD ${row.page_name ?? row.page_id}: add ${missing.join(", ")}`);
      continue;
    }
    try {
      await subscribePageToLeadgen(row.page_id, conn.pageToken);
      ok += 1;
      console.log(`  OK    ${row.page_name ?? row.page_id}: added ${missing.join(", ")}`);
    } catch (err) {
      failed += 1;
      console.log(
        `  FAIL  ${row.page_name ?? row.page_id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  console.log(`\n${ok} ok, ${failed} failed.${apply ? "" : " Re-run with --apply to write."}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
