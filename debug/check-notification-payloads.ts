#!/usr/bin/env tsx
/** One-off: inspect recent notification payloads for Amy's business. */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const { data, error } = await db
  .from("notifications")
  .select("id, kind, status, summary, created_at, payload")
  .eq("business_id", BIZ)
  .order("created_at", { ascending: false })
  .limit(8);
if (error) throw new Error(error.message);
for (const row of data ?? []) {
  console.log(
    JSON.stringify(
      {
        created_at: row.created_at,
        kind: row.kind,
        status: row.status,
        summary: row.summary,
        payloadKeys: Object.keys(row.payload ?? {}),
        events: (row.payload as Record<string, unknown>)?.events ?? null
      },
      null,
      1
    )
  );
}
