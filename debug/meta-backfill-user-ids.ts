/**
 * Backfill meta_connections.meta_user_id on connections made before we
 * captured it.
 *
 *   npx tsx debug/meta-backfill-user-ids.ts           # dry run, changes nothing
 *   npx tsx debug/meta-backfill-user-ids.ts --apply
 *
 * WHY THIS EXISTS: Meta's deauthorize and data-deletion callbacks identify
 * the person only by an app-scoped id (ASID). A connection with no
 * meta_user_id cannot be matched to the person who removed the app, so those
 * callbacks would record the request and sever nothing.
 *
 * HOW IT RECOVERS THE ID WITHOUT A USER TOKEN: a connection drops its user
 * token the moment it activates, so on live rows the page token is all that
 * remains, and /me on a page token answers with the Page, not the person.
 * /debug_token does carry it: `profile_id` is the Page, `user_id` is the
 * person who authorized the token. That is what getTokenUserId reads.
 *
 * Read-only unless --apply. Never prints token material.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const apply = process.argv.includes("--apply");

async function main() {
  const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
  const { getMetaConnection, setMetaConnectionUserId } = await import(
    "../src/lib/db/meta-connections.ts"
  );
  const { getTokenUserId } = await import("../src/lib/meta/client.ts");

  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("meta_connections")
    .select("id,business_id,page_id,page_name,meta_user_id")
    .is("meta_user_id", null)
    .limit(500);
  if (error) throw new Error(`read: ${error.message}`);

  const rows = (data ?? []) as {
    id: string;
    business_id: string;
    page_id: string | null;
    page_name: string | null;
  }[];
  if (rows.length === 0) {
    console.log("nothing to backfill: every connection already has a meta_user_id");
    return;
  }
  console.log(`${rows.length} connection(s) without a meta_user_id${apply ? "" : " (dry run)"}\n`);

  let resolved = 0;
  let stamped = 0;
  let unreachable = 0;
  for (const row of rows) {
    // getMetaConnection decrypts; the raw select above cannot.
    const conn = await getMetaConnection(row.business_id);
    const token = conn?.pageToken ?? conn?.userToken ?? null;
    if (!token) {
      unreachable += 1;
      console.log(`  SKIP  ${row.business_id} (${row.page_name ?? "no page"}): no token stored`);
      continue;
    }
    const userId = await getTokenUserId(token);
    if (!userId) {
      unreachable += 1;
      console.log(
        `  SKIP  ${row.business_id} (${row.page_name ?? "no page"}): debug_token returned no user_id` +
          " (token likely expired; the owner must reconnect)"
      );
      continue;
    }
    resolved += 1;
    if (!apply) {
      console.log(`  WOULD ${row.business_id} (${row.page_name ?? "no page"}) -> ${userId}`);
      continue;
    }
    if (await setMetaConnectionUserId(row.id, userId)) {
      stamped += 1;
      console.log(`  OK    ${row.business_id} (${row.page_name ?? "no page"}) -> ${userId}`);
    } else {
      console.log(`  FAIL  ${row.business_id}: update matched no row`);
    }
  }

  console.log(
    `\n${resolved} resolvable, ${unreachable} unreachable` +
      (apply ? `, ${stamped} stamped.` : ". Re-run with --apply to write.")
  );
  if (unreachable > 0) {
    console.log(
      "Unreachable rows stay unmatchable by the Meta callbacks until the owner reconnects,\n" +
        "which captures the id directly from /me."
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
