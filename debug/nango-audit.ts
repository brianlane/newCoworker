#!/usr/bin/env tsx
/**
 * Audit the platform Nango account against `workspace_oauth_connections`.
 *
 * Every Nango connection consumes the ACCOUNT-WIDE quota (10 on the free
 * plan), so connections that exist on Nango's side without a DB row,
 * refused over-cap completes, deleted tenants from before the cleanup hook,
 * manual dashboard experiments, burn quota for nothing. This script diffs
 * both directions:
 *
 *   - Nango-side orphans (connection, no DB row): deletable: `--apply`
 *     revokes them on Nango and reclaims the quota.
 *   - DB-side orphans (row, no Nango connection): REPORT ONLY. The row may
 *     carry app-owned metadata (shared-calendar id, ACL grants); the owner
 *     should reconnect or remove it from /dashboard/integrations/workspace.
 *
 * Dry-run by default; pass --apply to delete Nango-side orphans.
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { getNangoClient } from "../src/lib/nango/server.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
if (!process.env.NANGO_SECRET_KEY) throw new Error("Missing NANGO_SECRET_KEY");

const db = createClient(url, key, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");

type DbRow = {
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  transport: string;
  metadata: Record<string, unknown> | null;
};

type NangoConnection = {
  connection_id?: string;
  connectionId?: string;
  provider_config_key?: string;
  providerConfigKey?: string;
};

/** Bound on the DB read; see the truncation guard in main(). */
const ROW_CEILING = 1000;

function linkKey(providerConfigKey: string, connectionId: string): string {
  return `${providerConfigKey}\u0000${connectionId}`;
}

async function main() {
  const nango = getNangoClient();

  const { data, error, count } = await db
    .from("workspace_oauth_connections")
    .select("business_id, provider_config_key, connection_id, transport, metadata", {
      count: "exact"
    })
    .limit(ROW_CEILING);
  if (error) throw new Error(`list DB rows: ${error.message}`);
  const dbRows = (data ?? []) as DbRow[];
  // PostgREST truncates silently, and a short read here would invent orphans:
  // every Nango connection whose DB row fell outside the window would look
  // deletable. Refuse rather than reclaim on a partial picture.
  //
  // The exact count is the authority when present, so completeness is
  // `count === rows read`. When PostgREST reports NO count, a full page and a
  // truncated page are indistinguishable, so a full page has to be treated as
  // truncated. Checking only `count > rows` would let a missing count plus a
  // full page read as complete, and the consequence here is not a partial
  // report: it is `--apply` deleting the rollback seats the rest of this script
  // exists to protect. Same shape as the guard in
  // debug/google-nango-export-audit.ts.
  const exactTotal = typeof count === "number" ? count : null;
  const truncated =
    exactTotal === null ? dbRows.length >= ROW_CEILING : exactTotal > dbRows.length;
  if (truncated) {
    throw new Error(
      `Read ${dbRows.length} DB row(s), table holds ${exactTotal === null ? "an unreported number" : exactTotal}; the ${ROW_CEILING} ceiling truncated the result. Every unseen row's Nango connection would be misreported as a deletable orphan, so refusing rather than reporting.`
    );
  }
  const dbByKey = new Map(dbRows.map((r) => [linkKey(r.provider_config_key, r.connection_id), r]));

  // Nango connection ids a DIRECT row still points back at. Those grants are
  // kept ON PURPOSE as the rollback path for a migration, so they are orphaned
  // by design and must not be reclaimed as waste.
  const retainedForRollback = new Map<string, DbRow>();
  for (const r of dbRows) {
    const prior = r.metadata?.migrated_from_nango_connection_id;
    if (typeof prior === "string" && prior.length > 0) retainedForRollback.set(prior, r);
  }

  const res = (await nango.listConnections({ limit: 1000 })) as {
    connections?: NangoConnection[];
  };
  const nangoConnections = res?.connections ?? [];

  console.log(
    `Nango: ${nangoConnections.length} connection(s); DB: ${dbRows.length} row(s); ${APPLY ? "APPLY" : "dry-run"}`
  );

  const seenOnNango = new Set<string>();
  let orphans = 0;
  let deleted = 0;
  let retained = 0;

  for (const conn of nangoConnections) {
    const connectionId = conn.connection_id ?? conn.connectionId ?? "";
    const providerConfigKey = conn.provider_config_key ?? conn.providerConfigKey ?? "";
    if (!connectionId || !providerConfigKey) {
      console.log(`  ??     unreadable connection payload: ${JSON.stringify(conn).slice(0, 120)}`);
      continue;
    }
    const k = linkKey(providerConfigKey, connectionId);
    seenOnNango.add(k);
    const row = dbByKey.get(k);
    if (row) {
      console.log(`  ok     ${providerConfigKey} …${connectionId.slice(-6)} → ${row.business_id}`);
      continue;
    }
    const rollbackFor = retainedForRollback.get(connectionId);
    if (rollbackFor) {
      console.log(
        `  ROLLBACK ${providerConfigKey} …${connectionId.slice(-6)}: kept on purpose for ${rollbackFor.business_id}; NOT reclaimed`
      );
      console.log(
        `           That business's row is on the first-party transport now and still points back here.`
      );
      console.log(
        `           To reclaim this seat, clear metadata.migrated_from_nango_connection_id on that row FIRST,`
      );
      console.log(`           which is the deliberate act of giving up the rollback path.`);
      retained += 1;
      continue;
    }
    orphans += 1;
    console.log(`  ORPHAN ${providerConfigKey} …${connectionId.slice(-6)}: no DB row (burns account quota)`);
    if (APPLY) {
      try {
        await nango.deleteConnection(providerConfigKey, connectionId);
        deleted += 1;
        console.log(`         deleted on Nango`);
      } catch (err) {
        console.error(`         delete failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  let stale = 0;
  let direct = 0;
  for (const row of dbRows) {
    if (seenOnNango.has(linkKey(row.provider_config_key, row.connection_id))) continue;
    // A first-party row has no Nango connection because WE hold its tokens.
    // Reporting it as stale told the operator to remove a perfectly healthy
    // connection, which is worse than saying nothing: it is confident and
    // wrong, on exactly the rows a migration has just created.
    if (row.transport === "direct") {
      direct += 1;
      continue;
    }
    stale += 1;
    console.log(
      `  STALE  ${row.provider_config_key} …${row.connection_id.slice(-6)} (business ${row.business_id}): DB row with no Nango connection; owner should reconnect or remove it (not auto-deleted)`
    );
  }

  console.log(
    `done: ${orphans} Nango-side orphan(s)${APPLY ? `, ${deleted} deleted` : ""}, ${retained} retained for rollback, ${stale} stale DB row(s), ${direct} first-party row(s) skipped${APPLY ? "" : " (dry-run, nothing deleted)"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
