/**
 * Backfill sms_links.sms_outbound_log_id for rows minted before write-path
 * pairing shipped. Matches by business + run_id + to_e164 + closest created_at
 * within 30 seconds of an ai_flow outbound log row.
 *
 * Usage:
 *   npx tsx scripts/oneshot/backfill-sms-link-outbound-log-id.ts [--apply] [--business <uuid>]
 */
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const MATCH_WINDOW_MS = 30_000;

type LinkRow = {
  id: string;
  business_id: string;
  short_code: string;
  run_id: string | null;
  to_e164: string | null;
  created_at: string;
  sms_outbound_log_id: string | null;
};

type OutboundRow = {
  id: string;
  business_id: string;
  run_id: string | null;
  to_e164: string;
  created_at: string;
};

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const businessIdx = argv.indexOf("--business");
  const businessId = businessIdx >= 0 ? argv[businessIdx + 1] ?? null : null;
  return { apply, businessId };
}

function closestOutbound(
  link: LinkRow,
  candidates: OutboundRow[]
): OutboundRow | null {
  const linkMs = Date.parse(link.created_at);
  let best: OutboundRow | null = null;
  let bestDelta = MATCH_WINDOW_MS + 1;
  for (const row of candidates) {
    const delta = Math.abs(Date.parse(row.created_at) - linkMs);
    if (delta <= MATCH_WINDOW_MS && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

async function main() {
  const { apply, businessId } = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let query = db
    .from("sms_links")
    .select("id, business_id, short_code, run_id, to_e164, created_at, sms_outbound_log_id")
    .is("sms_outbound_log_id", null)
    .not("run_id", "is", null)
    .not("to_e164", "is", null)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (businessId) query = query.eq("business_id", businessId);

  const { data: links, error } = await query;
  if (error) {
    console.error("sms_links read failed:", error.message);
    process.exit(1);
  }
  const rows = (links as LinkRow[] | null) ?? [];
  if (rows.length === 0) {
    console.log("No unpaired links to backfill.");
    return;
  }

  const runIds = [...new Set(rows.map((r) => r.run_id).filter(Boolean))] as string[];
  const { data: outbound, error: outErr } = await db
    .from("sms_outbound_log")
    .select("id, business_id, run_id, to_e164, created_at")
    .in("run_id", runIds)
    .eq("source", "ai_flow");
  if (outErr) {
    console.error("sms_outbound_log read failed:", outErr.message);
    process.exit(1);
  }
  const outboundRows = (outbound as OutboundRow[] | null) ?? [];
  const byRun = new Map<string, OutboundRow[]>();
  for (const row of outboundRows) {
    if (!row.run_id) continue;
    const list = byRun.get(row.run_id) ?? [];
    list.push(row);
    byRun.set(row.run_id, list);
  }

  let matched = 0;
  // One outbound row pairs at most one link: without this, two links from
  // separate texts in the same run to the same number could both claim the
  // same log row and misalign thread pairing.
  const consumed = new Set<string>();
  for (const link of rows) {
    if (!link.run_id || !link.to_e164) continue;
    const candidates = (byRun.get(link.run_id) ?? []).filter(
      (o) =>
        o.business_id === link.business_id &&
        o.to_e164 === link.to_e164 &&
        !consumed.has(o.id)
    );
    const hit = closestOutbound(link, candidates);
    if (!hit) continue;
    consumed.add(hit.id);
    matched += 1;
    console.log(`${apply ? "APPLY" : "DRY"} ${link.short_code} → outbound ${hit.id}`);
    if (apply) {
      const { error: updErr } = await db
        .from("sms_links")
        .update({ sms_outbound_log_id: hit.id })
        .eq("id", link.id);
      if (updErr) console.error(`update ${link.short_code} failed:`, updErr.message);
    }
  }

  console.log(`Matched ${matched} of ${rows.length} unpaired link(s).`);
  if (apply && matched > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "backfill-sms-link-outbound-log-id.ts",
      businessId,
      details: { matched, scanned: rows.length }
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
