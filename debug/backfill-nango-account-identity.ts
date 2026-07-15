#!/usr/bin/env tsx
/**
 * One-off: backfill `provider_account_email` / `provider_account_display_name`
 * onto existing `workspace_oauth_connections.metadata`.
 *
 * Connect-UI rows were labeled with Nango's `end_user` (the dashboard login
 * that started the session), so two Google accounts connected by the same
 * login are indistinguishable in every mailbox picker. New connects resolve
 * the REAL account at completion (/api/integrations/nango/complete); this
 * script runs the same provider probes for rows connected before the fix.
 *
 * Dry-run by default; pass --apply to write. Optional --business <uuid> to
 * scope to one tenant. Rows that already have provider_account_email are
 * skipped (idempotent).
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { getNangoClient } from "../src/lib/nango/server.ts";
import {
  probeProviderAccountIdentity,
  providerAccountMetadata
} from "../src/lib/nango/account-identity.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
if (!process.env.NANGO_SECRET_KEY) throw new Error("Missing NANGO_SECRET_KEY");

const db = createClient(url, key, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business");
const ONLY_BUSINESS = bizFlag >= 0 ? process.argv[bizFlag + 1] : null;

type Row = {
  id: string;
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  metadata: Record<string, unknown> | null;
};

async function main() {
  const nango = getNangoClient();

  let query = db
    .from("workspace_oauth_connections")
    .select("id, business_id, provider_config_key, connection_id, metadata")
    .order("created_at", { ascending: true });
  if (ONLY_BUSINESS) query = query.eq("business_id", ONLY_BUSINESS);
  const { data, error } = await query;
  if (error) throw new Error(`list connections: ${error.message}`);
  const rows = (data ?? []) as Row[];

  console.log(`${rows.length} connection(s)${ONLY_BUSINESS ? ` for ${ONLY_BUSINESS}` : ""}; ${APPLY ? "APPLY" : "dry-run"}`);

  let resolved = 0;
  let skipped = 0;
  let unresolved = 0;

  for (const row of rows) {
    const meta = row.metadata ?? {};
    const tail = row.connection_id.slice(-6);
    if (typeof meta.provider_account_email === "string" && meta.provider_account_email) {
      skipped += 1;
      console.log(`  skip   ${row.business_id} ${row.provider_config_key} …${tail} (already ${meta.provider_account_email})`);
      continue;
    }

    const identity = await probeProviderAccountIdentity(row.provider_config_key, async (endpoint) => {
      const res = await nango.proxy({
        endpoint,
        method: "GET",
        providerConfigKey: row.provider_config_key,
        connectionId: row.connection_id
      });
      return res ? { data: res.data as unknown } : null;
    });

    const patch = providerAccountMetadata(identity);
    if (Object.keys(patch).length === 0) {
      unresolved += 1;
      console.log(`  ??     ${row.business_id} ${row.provider_config_key} …${tail} — no identity resolved (missing scope or unsupported provider)`);
      continue;
    }

    resolved += 1;
    console.log(`  found  ${row.business_id} ${row.provider_config_key} …${tail} → ${identity.email ?? identity.displayName}`);
    if (APPLY) {
      const { error: upErr } = await db
        .from("workspace_oauth_connections")
        .update({ metadata: { ...meta, ...patch }, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (upErr) throw new Error(`update ${row.id}: ${upErr.message}`);
    }
  }

  console.log(`done: ${resolved} resolved, ${skipped} already set, ${unresolved} unresolved${APPLY ? "" : " (dry-run, nothing written)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
