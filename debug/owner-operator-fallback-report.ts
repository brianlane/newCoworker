/**
 * How often does an owner SMS turn fall back off the platform operator
 * engine onto the box Rowboat path, and why?
 *
 * Why this exists. Owner texts run on the platform inline engine
 * (/api/internal/owner-sms-turn), which carries the operator tool surface
 * (send_sms, calendar, list/run AiFlows, edit_aiflow) and the owner-ask
 * classifier. When that call cannot be made or fails, the turn falls through
 * to the Rowboat staff persona on the tenant's box, which has none of those.
 * The owner still gets an answer, just a materially smaller one, and nothing
 * in the reply says so.
 *
 * Measuring that used to mean subtracting `sms_owner_operator_turn`
 * successes from owner-kind inbound jobs and hand-auditing the difference.
 * That is how this script started life: on 2026-08-24 the difference was six
 * jobs, and every one turned out to be a draft approval from another tenant
 * that the WEBHOOK answers before the worker ever chooses an engine. Zero
 * real fallbacks, but only after chasing them down one by one.
 *
 * Both sides are now counted directly, so this is a report rather than an
 * investigation.
 *
 * Read-only. Usage:
 *   npx tsx debug/owner-operator-fallback-report.ts [--days N]
 *
 * NOTE: `telemetry_events` is pruned at 30 days
 * (20260615000000_db_io_retention.sql), so a longer window silently reports
 * only what survives. The script says so rather than pretending.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const TELEMETRY_RETENTION_DAYS = 30;

function parseDays(argv: string[]): number {
  const i = argv.indexOf("--days");
  if (i === -1) return 7;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

const days = parseDays(process.argv.slice(2));
const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

/** Every row of one telemetry event type in the window (paged past the 1000 cap). */
async function readEvents(eventType: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (;;) {
    const { data, error } = await db
      .from("telemetry_events")
      .select("id, payload, created_at")
      .eq("event_type", eventType)
      .gte("created_at", since)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`${eventType}: ${error.message}`);
    const rows = data ?? [];
    out.push(...(rows as Array<Record<string, unknown>>));
    if (rows.length < 1000) break;
    cursor = Number((rows[rows.length - 1] as { id: number }).id);
  }
  return out;
}

const [okRows, fbRows] = await Promise.all([
  readEvents("sms_owner_operator_turn"),
  readEvents("sms_owner_operator_fallback")
]);

const ok = okRows.length;
const fb = fbRows.length;
const total = ok + fb;

console.log(`window: last ${days} day(s), since ${since}`);
if (days > TELEMETRY_RETENTION_DAYS) {
  console.log(
    `NOTE: telemetry_events is pruned at ${TELEMETRY_RETENTION_DAYS} days, so this window is truncated.`
  );
}
console.log("");
console.log(`owner turns on the platform engine : ${ok}`);
console.log(`owner turns that fell back to box  : ${fb}`);
console.log(
  `fallback rate                      : ${total === 0 ? "n/a (no owner turns)" : ((fb / total) * 100).toFixed(1) + "%"}`
);

if (fb > 0) {
  const byReason = new Map<string, number>();
  const byBiz = new Map<string, number>();
  for (const r of fbRows) {
    const p = (r.payload ?? {}) as { reason?: string; business_id?: string; detail?: string };
    const reason = p.reason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const b = p.business_id ?? "unknown";
    byBiz.set(b, (byBiz.get(b) ?? 0) + 1);
  }
  console.log("\nby reason:");
  for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    // disabled / not_configured mean the path was never ATTEMPTED on this
    // deployment: a config answer, not a health answer.
    const kind =
      reason === "disabled" || reason === "not_configured" ? "config" : "attempted and failed";
    console.log(`  ${reason.padEnd(16)} ${String(n).padStart(5)}   (${kind})`);
  }
  console.log("\nby business:");
  for (const [biz, n] of [...byBiz.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${biz}  ${n}`);
  }
  const details = fbRows
    .map((r) => (r.payload as { detail?: string })?.detail)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  if (details.length > 0) {
    console.log("\nsample details:");
    for (const d of [...new Set(details)].slice(0, 5)) console.log(`  ${d}`);
  }
  console.log(
    "\nA sustained non-config fallback rate is the trigger to revisit giving the box worker its own flow-edit path; a config reason means fixing the deployment instead."
  );
} else {
  console.log("\nNo fallbacks in the window: every owner turn got the full operator surface.");
}
