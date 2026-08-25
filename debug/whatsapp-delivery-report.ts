#!/usr/bin/env tsx
/**
 * "Did that WhatsApp message actually arrive?" Read the delivery receipts.
 *
 * Until 2026-08-25 the answer was unknowable: the send call returning `ok`
 * meant Meta ACCEPTED the message, and the sent/delivered/read/failed
 * webhooks that follow were discarded. A tenant whose sends were all being
 * rejected downstream looked exactly like a healthy one. KYP Ads spent two
 * weeks unable to start a single WhatsApp conversation with nothing anywhere
 * to show it.
 *
 * Receipts are stored on the transcript row now, so this prints the truth:
 * what was sent, what landed, and Meta's error code for what did not.
 *
 * A `pending` row is not automatically a problem: receipts arrive
 * asynchronously, and anything sent before this shipped has no wamid stored
 * and can never be resolved.
 *
 * Strictly READ-ONLY. Safe on any tenant.
 *
 * Usage:
 *   tsx debug/whatsapp-delivery-report.ts
 *   tsx debug/whatsapp-delivery-report.ts --business <uuid> --since 7d
 *   tsx debug/whatsapp-delivery-report.ts --failed-only
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function sinceIso(raw: string | null): string {
  const m = /^(\d+)([dh])$/.exec(raw ?? "7d");
  const n = m ? Number(m[1]) : 7;
  const ms = m?.[2] === "h" ? n * 3600_000 : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const businessId = arg("business");
  const from = sinceIso(arg("since"));
  const failedOnly = process.argv.includes("--failed-only");

  let q = sb
    .from("messenger_messages")
    .select("business_id, created_at, role, content, mid, delivery_status, delivery_error_code, delivery_error_title")
    .eq("role", "owner")
    .gte("created_at", from)
    .order("created_at", { ascending: false })
    .limit(500);
  if (businessId) q = q.eq("business_id", businessId);
  if (failedOnly) q = q.eq("delivery_status", "failed");

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  const { data: biz } = await sb.from("businesses").select("id, name");
  const nameOf = new Map((biz ?? []).map((b) => [b.id as string, b.name as string]));

  const tally: Record<string, number> = {};
  for (const r of rows) {
    // No wamid at all means the row predates receipt capture, which is a
    // different thing from a receipt that has not arrived yet.
    const state = r.mid ? (r.delivery_status ?? "pending") : "no-wamid (pre-2026-08-25)";
    tally[state] = (tally[state] ?? 0) + 1;
  }

  console.log(`Outbound WhatsApp since ${from}${businessId ? ` for ${businessId}` : ""}\n`);
  for (const [state, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${state}`);
  }

  const failures = rows.filter((r) => r.delivery_status === "failed");
  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`);
    for (const f of failures) {
      console.log(
        `\n  [${f.created_at}] ${nameOf.get(f.business_id as string) ?? f.business_id}` +
          `\n    code=${f.delivery_error_code ?? "-"}  ${f.delivery_error_title ?? ""}` +
          `\n    ${String(f.content).slice(0, 120).replace(/\n/g, " ")}`
      );
    }
  } else if (!failedOnly) {
    console.log("\nNo failed deliveries in this window.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
