/**
 * audit-relay-contact-owners.ts: find PARTNER ALERT LINES that have been
 * stamped with a contact owner, fleet-wide.
 *
 * A referral partner texts every lead in from the same number, so its contact
 * row is not a person: it is a relay. When `contacts.owner_employee_id` gets
 * written onto one of those rows, route_to_team stops racing the roster and
 * silently hands every future lead from that partner to one teammate.
 *
 * It has happened twice. Danfar (2026-08-10) bound ownership to HomeLight's
 * alert line through an extracted-but-EMPTY lead_phone. Amy C. (2026-08-14)
 * did it again on the same line through a lead_phone that had not been
 * extracted YET, because that flow races the roster at step 5 and declares
 * the var at step 6; 17 referrals went to one teammate with no race before
 * anyone noticed. Both holes are closed in code (`flowDealsInLeadPhone` reads
 * the flow definition, not the variable bag), so this exists to prove they
 * stay closed rather than to find them a third time by hand.
 *
 * A relay is inferred from behavior, not a naming convention: a number that
 * triggered several runs carrying several DIFFERENT lead names is a relay,
 * whatever the contact is called. A real customer texting in repeatedly is
 * one lead name, so they never trip it.
 *
 *   tsx debug/audit-relay-contact-owners.ts                # owned relays only
 *   tsx debug/audit-relay-contact-owners.ts --all          # every relay found
 *   tsx debug/audit-relay-contact-owners.ts --json         # machine-readable
 *   tsx debug/audit-relay-contact-owners.ts --min-leads 3  # stricter threshold
 *
 * Clear anything it reports with `tsx debug/clear-contact-owner.ts`.
 *
 * Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

const showAll = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

function numberArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How many DISTINCT lead names a sender must have carried before its contact
 * counts as a relay. Two is enough to rule out a returning customer and is
 * what both real incidents would have tripped on their second referral.
 */
const MIN_DISTINCT_LEADS = numberArg("min-leads", 2);

/** PostgREST caps an unbounded select at 1000 rows, so page explicitly. */
const PAGE = 1000;

type Finding = {
  business: string;
  businessId: string;
  phone: string;
  displayName: string;
  ownerName: string | null;
  runs: number;
  distinctLeads: number;
};

async function sendersFor(
  db: SupabaseClient,
  businessId: string
): Promise<Map<string, { runs: number; leads: Set<string> }>> {
  const senders = new Map<string, { runs: number; leads: Set<string> }>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("ai_flow_runs")
      .select("context")
      .eq("business_id", businessId)
      .order("created_at")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`runs for ${businessId}: ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      const ctx = (row.context ?? {}) as {
        trigger?: Record<string, unknown>;
        vars?: Record<string, unknown>;
      };
      const from = typeof ctx.trigger?.from === "string" ? ctx.trigger.from.trim() : "";
      if (!from.startsWith("+")) continue;
      const entry = senders.get(from) ?? { runs: 0, leads: new Set<string>() };
      entry.runs += 1;
      const lead = ctx.vars?.lead_name ?? ctx.vars?.lead_first_name;
      // "none" is the extraction sentinel for "the page showed nothing", not
      // a lead, so it must never count toward the distinct-name threshold.
      if (typeof lead === "string" && lead.trim() && lead.trim().toLowerCase() !== "none") {
        entry.leads.add(lead.trim().toLowerCase());
      }
      senders.set(from, entry);
    }
    if (rows.length < PAGE) break;
  }
  return senders;
}

async function main(): Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: businesses, error: bizErr } = await db.from("businesses").select("id, name");
  if (bizErr) throw new Error(`businesses: ${bizErr.message}`);

  const findings: Finding[] = [];
  for (const biz of businesses ?? []) {
    const senders = await sendersFor(db, biz.id as string);
    const relays = [...senders.entries()]
      .filter(([, e]) => e.leads.size >= MIN_DISTINCT_LEADS)
      .map(([phone]) => phone);
    if (relays.length === 0) continue;

    const { data: contacts, error: cErr } = await db
      .from("contacts")
      .select("customer_e164, display_name, owner_employee_id")
      .eq("business_id", biz.id)
      .in("customer_e164", relays);
    if (cErr) throw new Error(`contacts for ${biz.id}: ${cErr.message}`);

    const ownerIds = [
      ...new Set((contacts ?? []).map((c) => c.owner_employee_id).filter(Boolean))
    ] as string[];
    const owners = new Map<string, string>();
    if (ownerIds.length > 0) {
      const { data: members } = await db
        .from("ai_flow_team_members")
        .select("id, name")
        .in("id", ownerIds);
      for (const m of members ?? []) owners.set(m.id as string, (m.name as string) ?? "");
    }

    for (const c of contacts ?? []) {
      const owned = Boolean(c.owner_employee_id);
      if (!owned && !showAll) continue;
      const stats = senders.get(c.customer_e164 as string)!;
      findings.push({
        business: (biz.name as string) ?? "",
        businessId: biz.id as string,
        phone: c.customer_e164 as string,
        displayName: (c.display_name as string) ?? "",
        ownerName: owned ? (owners.get(c.owner_employee_id as string) ?? "(unknown)") : null,
        runs: stats.runs,
        distinctLeads: stats.leads.size
      });
    }
  }

  findings.sort((a, b) => b.distinctLeads - a.distinctLeads);

  // Set BEFORE the output branches. A standing check that reports a finding
  // and still exits 0 reads as "all clear" to whatever runs it, so the exit
  // code cannot depend on which reporter the caller asked for.
  const owned = findings.filter((f) => f.ownerName !== null);
  if (owned.length > 0) process.exitCode = 1;

  if (asJson) {
    console.log(
      JSON.stringify({ minDistinctLeads: MIN_DISTINCT_LEADS, owned: owned.length, findings }, null, 2)
    );
    return;
  }

  if (owned.length === 0) {
    console.log(
      `No partner alert line carries a contact owner (threshold: ${MIN_DISTINCT_LEADS}+ distinct leads).`
    );
  }
  for (const f of findings) {
    const tag = f.ownerName === null ? "ok    " : "OWNED ";
    const who = f.ownerName === null ? "unowned" : `owned by ${f.ownerName}`;
    console.log(
      `${tag} ${f.business} :: ${f.phone} "${f.displayName}" ${who} ` +
        `(${f.runs} runs, ${f.distinctLeads} distinct leads)`
    );
  }
  if (owned.length > 0) {
    console.log(
      `\n${owned.length} relay contact(s) carry an owner. Every future lead from ` +
        `those lines skips the team race. Clear each with:\n` +
        `  tsx debug/clear-contact-owner.ts --business <uuid> --phone <e164> --apply`
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
