#!/usr/bin/env tsx
/**
 * "Audit this tenant's account." One command instead of a dozen queries.
 *
 * Asked repeatedly of KYP, Truly, and Amy: what is this account's posture
 * right now, what has it been doing, and is anything quietly broken? Every
 * time it meant the same walk: look up the business, list the flows and which
 * are on, count recent runs by status, look for dead letters, check errors in
 * the system log, check spend, check the roster. Same walk, same joins, so it
 * lives here now.
 *
 * Sections printed:
 *   1. Identity        business row, DID(s), box, tier, dossier pointer
 *   2. Flows           every flow with enable state and step count
 *   3. Runs            recent AiFlow runs bucketed by status, plus failures
 *   4. Messaging       inbound/outbound volume, dead-lettered inbound jobs
 *   5. Errors          warn/error rows from `system_logs` grouped by event
 *   6. Spend           Gemini cost by surface from the daily roll-up
 *
 * Strictly READ-ONLY: no writes, no sends, no SSH. Safe on any tenant at any
 * time. For a live box's health (containers, memory, bridge) use
 * `debug/box-verify.ts`; for one phone number's history use
 * `debug/trace-sms.ts`.
 *
 * Usage:
 *   tsx debug/audit-account.ts --business <uuid>
 *   tsx debug/audit-account.ts --business <uuid> --hours 36
 *   tsx debug/audit-account.ts --list              # ids for every tenant
 *   tsx debug/audit-account.ts --business <uuid> --json
 *
 * Env (repo-root `.env`): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPaged } from "../src/lib/supabase/paging.ts";
import { loadEnv } from "./_shared.ts";

type Args = { businessId: string | null; hours: number; list: boolean; json: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { businessId: null, hours: 72, list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--business") out.businessId = argv[++i] ?? null;
    else if (a === "--hours") out.hours = Number(argv[++i] ?? "72") || 72;
    else if (a === "--list") out.list = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: tsx debug/audit-account.ts --business <uuid> [--hours 72] [--list] [--json]\n");
      process.exit(0);
    }
  }
  return out;
}

/** Dossiers keyed by business id, so the audit can point at the written context. */
const DOSSIERS: Record<string, string> = {
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3": "docs/tenants/amy-laidlaw-real-estate.md",
  "056034a7-e84c-444d-8d15-747eeb1fa899": "docs/tenants/kyp-ads.md",
  "690f85c0-ee16-4ee5-bde5-5829df2e5410": "docs/tenants/truly-insurance.md",
  "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d": "docs/tenants/new-coworker-hq.md"
};

/** Count occurrences, returned highest-first. */
export function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

type AuditReport = {
  business: Record<string, unknown>;
  dids: string[];
  roster: Array<{ name: string; active: boolean }>;
  flows: Array<{ name: string; enabled: boolean; steps: number; trigger: string; updatedAt: string }>;
  runs: Array<[string, number]>;
  runFailures: Array<{ flow: string; error: string; at: string }>;
  messaging: { inbound: number; outbound: number; deadLettered: number };
  errors: Array<[string, number]>;
  spend: Array<[string, number]>;
  windowHours: number;
  /** Sections whose row set hit the paging ceiling, so their counts are floors. */
  truncated: string[];
};

async function audit(db: SupabaseClient, businessId: string, hours: number): Promise<AuditReport> {
  const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  // Volumes come from exact COUNT queries, never from the length of a fetched
  // page: a `select()` caps at 1000 rows, so counting what came back reports a
  // floor while looking like a total. Row sets that must be grouped ARE
  // fetched, but paged, and say so when they hit the ceiling.
  const [business, routes, roster, flows, runs, inbound, deadLettered, outbound, logs, spend] = await Promise.all([
    db.from("businesses").select("id,name,tier,status,owner_name,hostinger_vps_id,created_at").eq("id", businessId).maybeSingle(),
    db.from("telnyx_voice_routes").select("to_e164").eq("business_id", businessId),
    db.from("ai_flow_team_members").select("name,active").eq("business_id", businessId),
    db.from("ai_flows").select("id,name,enabled,definition,updated_at").eq("business_id", businessId),
    fetchAllPaged<{ status: string; flow_id: string | null; last_error: string | null; created_at: string }>(
      (from, to) =>
        db
          .from("ai_flow_runs")
          .select("id,status,flow_id,last_error,created_at")
          .eq("business_id", businessId)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .range(from, to),
      { label: "ai_flow_runs" }
    ),
    db
      .from("sms_inbound_jobs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .gte("created_at", sinceIso),
    db
      .from("sms_inbound_jobs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "dead_letter")
      .gte("created_at", sinceIso),
    db
      .from("sms_outbound_log")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .gte("created_at", sinceIso),
    fetchAllPaged<{ level: string; event: string }>(
      (from, to) =>
        db
          .from("system_logs")
          .select("level,event")
          .eq("business_id", businessId)
          .in("level", ["warn", "error"])
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .range(from, to),
      { label: "system_logs" }
    ),
    db.from("gemini_spend_daily").select("surface,cost_micros,call_count").eq("business_id", businessId).gte("day", sinceDay)
  ]);

  // Every read is checked. An unchecked `.error` reads as empty data, which
  // would print "no flows", "no DIDs", or "no spend" for a database failure:
  // a confident wrong answer, and the worst possible output for an audit.
  for (const [label, res] of [
    ["businesses", business],
    ["telnyx_voice_routes", routes],
    ["ai_flow_team_members", roster],
    ["ai_flows", flows],
    ["sms_inbound_jobs", inbound],
    ["sms_inbound_jobs (dead_letter)", deadLettered],
    ["sms_outbound_log", outbound],
    ["gemini_spend_daily", spend]
  ] as const) {
    if (res.error) throw new Error(`${label}: ${res.error.message}`);
  }
  if (!business.data) throw new Error(`no business with id ${businessId}`);

  const flowRows = (flows.data ?? []) as Array<{
    id: string;
    name: string;
    enabled: boolean;
    definition: { trigger?: { type?: string; channel?: string }; steps?: unknown[] } | null;
    updated_at: string;
  }>;
  const flowName = new Map(flowRows.map((f) => [f.id, f.name]));

  const runRows = runs.rows;
  const truncated: string[] = [];
  if (runs.truncated) truncated.push("ai_flow_runs");
  if (logs.truncated) truncated.push("system_logs");

  return {
    business: business.data as Record<string, unknown>,
    dids: ((routes.data ?? []) as Array<{ to_e164: string }>).map((r) => r.to_e164),
    roster: ((roster.data ?? []) as Array<{ name: string; active: boolean }>).map((r) => ({
      name: r.name,
      active: r.active
    })),
    flows: flowRows
      .map((f) => ({
        name: f.name,
        enabled: f.enabled,
        steps: Array.isArray(f.definition?.steps) ? f.definition.steps.length : 0,
        trigger: f.definition?.trigger?.channel ?? f.definition?.trigger?.type ?? "?",
        updatedAt: f.updated_at.slice(0, 10)
      }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    runs: tally(runRows.map((r) => r.status)),
    // Newest first: the section is labeled "recent errors", so it has to sort
    // by time rather than trust whatever order the rows arrived in.
    runFailures: runRows
      .filter((r) => r.last_error)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 10)
      .map((r) => ({
        flow: (r.flow_id && flowName.get(r.flow_id)) || "(unknown flow)",
        error: (r.last_error ?? "").replace(/\s+/g, " ").slice(0, 120),
        at: r.created_at
      })),
    messaging: {
      inbound: inbound.count ?? 0,
      outbound: outbound.count ?? 0,
      deadLettered: deadLettered.count ?? 0
    },
    errors: tally(logs.rows.map((l) => `${l.level}:${l.event}`)),
    spend: (() => {
      const bySurface = new Map<string, number>();
      for (const row of (spend.data ?? []) as Array<{ surface: string; cost_micros: number }>) {
        bySurface.set(row.surface, (bySurface.get(row.surface) ?? 0) + row.cost_micros);
      }
      return [...bySurface.entries()].sort((a, b) => b[1] - a[1]);
    })(),
    windowHours: hours,
    truncated
  };
}

function print(report: AuditReport): void {
  const b = report.business as { name: string; tier: string; status: string; owner_name?: string; hostinger_vps_id?: string; id: string };
  const out = process.stdout;

  out.write(`\n=== ${b.name} (${b.tier}, ${b.status})\n`);
  out.write(`    id ${b.id}  box ${b.hostinger_vps_id ?? "-"}  owner ${b.owner_name ?? "-"}\n`);
  out.write(`    DID(s): ${report.dids.join(", ") || "none"}\n`);
  out.write(`    roster: ${report.roster.map((r) => `${r.name}${r.active ? "" : " (inactive)"}`).join(", ") || "none"}\n`);
  const dossier = DOSSIERS[b.id];
  out.write(dossier ? `    dossier: ${dossier} (read it before changing anything)\n` : "    dossier: none yet\n");

  const on = report.flows.filter((f) => f.enabled).length;
  out.write(`\n--- Flows (${on} on / ${report.flows.length} total)\n`);
  for (const f of report.flows) {
    out.write(`    ${f.enabled ? "ON " : "off"} [${f.trigger}] ${f.name} (${f.steps} steps, updated ${f.updatedAt})\n`);
  }

  out.write(`\n--- AiFlow runs (last ${report.windowHours}h)\n`);
  if (report.runs.length === 0) out.write("    none\n");
  for (const [status, n] of report.runs) out.write(`    ${String(n).padStart(5)}  ${status}\n`);
  if (report.runFailures.length > 0) {
    out.write("    recent errors:\n");
    for (const f of report.runFailures) out.write(`      ${f.at}  ${f.flow}: ${f.error}\n`);
  }

  const m = report.messaging;
  out.write(`\n--- Messaging (last ${report.windowHours}h)\n`);
  out.write(`    ${m.inbound} inbound, ${m.outbound} outbound\n`);
  if (m.deadLettered > 0) {
    out.write(
      `    ${m.deadLettered} DEAD-LETTERED inbound job(s): customer texts that never got a reply.\n` +
        "    Inspect with tsx debug/requeue-sms-deadletters.ts (dry-run by default).\n"
    );
  }

  out.write(`\n--- Warnings and errors (last ${report.windowHours}h)\n`);
  if (report.errors.length === 0) out.write("    none\n");
  for (const [event, n] of report.errors.slice(0, 15)) out.write(`    ${String(n).padStart(5)}  ${event}\n`);
  if (report.errors.length > 0) {
    out.write(`    detail: tsx debug/system-logs.ts ${b.id} --min-level=warn --since=${report.windowHours}h\n`);
  }

  out.write(`\n--- Gemini spend (since ${new Date(Date.now() - report.windowHours * 3_600_000).toISOString().slice(0, 10)}, UTC days)\n`);
  if (report.spend.length === 0) out.write("    none recorded\n");
  for (const [surface, micros] of report.spend) out.write(`    ${formatUsd(micros).padStart(9)}  ${surface}\n`);

  if (report.truncated.length > 0) {
    out.write(
      `\n!!! Row ceiling reached for: ${report.truncated.join(", ")}. Those counts are FLOORS,\n` +
        "    not totals. Narrow the window with --hours to get an exact picture.\n"
    );
  }
  out.write("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    process.stderr.write("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (repo-root .env)\n");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (args.list || !args.businessId) {
    const { data, error } = await db.from("businesses").select("id,name,tier,status").order("created_at");
    if (error) throw new Error(error.message);
    process.stdout.write("\nTenants:\n");
    for (const b of (data ?? []) as Array<{ id: string; name: string; tier: string; status: string }>) {
      process.stdout.write(`  ${b.id}  ${b.tier.padEnd(10)} ${b.status.padEnd(9)} ${b.name}\n`);
    }
    if (!args.businessId) process.stdout.write("\nRe-run with --business <uuid> for the full audit.\n");
    return;
  }

  const report = await audit(db, args.businessId, args.hours);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else print(report);
}

if (process.argv[1] && process.argv[1].endsWith("audit-account.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`audit-account failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
