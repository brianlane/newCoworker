#!/usr/bin/env tsx
/**
 * One-shot: broadcast Realtor.com's offer, and stop Clever's offer describing
 * a round robin it stopped doing on Aug 8.
 *
 * Amy, 2026-08-12, pointing at a Clever offer text: "why was this lead not
 * broadcasted then?"
 *
 * IT WAS. The run's own outcome line reads "offered simultaneously to
 * Gabrielle Mota, Amy Laidlaw, Dave Lane, first to claim". What she was
 * reading is the offer COPY, which still ends "or it goes to the next agent":
 * wording left behind when `amy-speed-to-lead-patch.ts` converted that step
 * from a rotation to an `agentNames` broadcast. The same message already says
 * "First to reply 1 gets it" three lines later, so it contradicts itself and
 * the stale half is the one that reads like a cascade.
 *
 * An audit of all eleven live route steps found Clever is the ONLY broadcast
 * still saying it. Every other broadcast offer was cleaned; the three rotation
 * offers say it correctly, because for them it is true.
 *
 * REALTOR.COM IS THE OTHER HALF. Its single route has NO lead-type gate at all
 * and was still a rotation, so any seller arriving through Realtor.com would be
 * round-robined. It now broadcasts to the same trio every other seller route
 * uses, and its copy gains the first-to-claim line it was missing.
 *
 * BUYER ROUTES ARE DELIBERATELY UNTOUCHED. Amy: "Do not change buyer leads."
 * New Lead Intake `route_buyer` and ReferralExchange `route_buyer` keep their
 * rotation AND keep their "next agent" wording, which is accurate for them.
 * Broadcasting those would text three people for every buyer lead, a cost she
 * weighed and declined earlier the same day.
 *
 * WHY `agentNames` AND NOT `broadcastAll`: Amy's roster row carries
 * team_broadcast_enabled=false, so broadcastAll would silently drop her from
 * her own offers. Name matching is FULL name ("Gabrielle Mota"; "Gabby"
 * reaches nobody), and the applier verifies each name resolves to exactly one
 * active roster member before writing.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-broadcast-realtor-and-offer-copy.ts          # dry run
 *   npx tsx scripts/oneshot/amy-broadcast-realtor-and-offer-copy.ts --apply
 *   npx tsx scripts/oneshot/amy-broadcast-realtor-and-offer-copy.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStep } from "./amy-lead-price-in-notices";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-broadcast-realtor-and-offer-copy.ts";

/**
 * The trio every other seller route already broadcasts to. Full names, because
 * broadcast matching is exact and a nickname reaches nobody.
 */
export const BROADCAST_NAMES = ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"];

/** The stale cascade wording, and what a broadcast should say instead. */
export const CASCADE_CLAUSE = ", or it goes to the next agent";
export const FIRST_TO_CLAIM = "First to reply 1 gets it.";

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

/**
 * Strip the cascade clause from an offer.
 *
 * Removes only the trailing clause, leaving "Reply 1 to claim or 2 to pass by
 * {{offer.deadline}}." intact: the deadline still matters on a broadcast,
 * because that is when the whole offer lapses to the owner.
 */
export function withoutCascadeClause(template: string): string {
  return template.includes(CASCADE_CLAUSE) ? template.split(CASCADE_CLAUSE).join("") : template;
}

/** Add the first-to-claim line when the offer does not already say it. */
export function withFirstToClaim(template: string): string {
  return template.includes(FIRST_TO_CLAIM) ? template : `${template}\n${FIRST_TO_CLAIM}`;
}

export type PatchResult = { changed: boolean; touched: string[] };

/** Clever: broadcast already, copy still describing a cascade. */
export function patchCleverCopy(def: Definition): PatchResult {
  const step = findStep(def.steps ?? [], "route");
  if (!step) throw new Error('Clever Lead - Accept: step "route" is missing');
  if (!step.agentNames) {
    throw new Error(
      'Clever Lead - Accept: step "route" is no longer a broadcast; re-read the flow before rewording it'
    );
  }
  const t = step.offerTemplate;
  if (typeof t !== "string") throw new Error("Clever Lead - Accept: route has no offerTemplate");
  const next = withoutCascadeClause(t);
  if (next === t) return { changed: false, touched: [] };
  step.offerTemplate = next;
  return { changed: true, touched: ["route.offerTemplate"] };
}

/** Realtor.com: rotation with no lead-type gate, so a seller could be round-robined. */
export function patchRealtorBroadcast(def: Definition): PatchResult {
  const step = findStep(def.steps ?? [], "s4");
  if (!step) throw new Error('Realtor.com Lead: step "s4" is missing');
  if (step.type !== "route_to_team") {
    throw new Error(`Realtor.com Lead: step "s4" is a ${String(step.type)}, not a route`);
  }
  const touched: string[] = [];
  const names = step.agentNames as string[] | undefined;
  if (!names || names.join("|") !== BROADCAST_NAMES.join("|")) {
    step.agentNames = [...BROADCAST_NAMES];
    // A broadcast pins nobody, so any leftover single-agent pin has to go or
    // the schema rejects the step for setting two recipient sources.
    delete step.agentName;
    delete step.agentRef;
    touched.push("s4.agentNames");
  }
  const t = step.offerTemplate;
  if (typeof t !== "string") throw new Error("Realtor.com Lead: s4 has no offerTemplate");
  const next = withFirstToClaim(withoutCascadeClause(t));
  if (next !== t) {
    step.offerTemplate = next;
    touched.push("s4.offerTemplate");
  }
  return { changed: touched.length > 0, touched };
}

export const PATCHERS: Record<string, (def: Definition) => PatchResult> = {
  "Clever Lead - Accept": patchCleverCopy,
  "Realtor.com Lead": patchRealtorBroadcast
};

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/**
 * Every broadcast name must resolve to exactly ONE active roster member with a
 * phone, and must not have named broadcasts switched off. A name that matches
 * nobody is silently dropped from the offer at run time, which is how a
 * "broadcast to three" quietly becomes a broadcast to two.
 */
// deno-lint-ignore no-explicit-any
async function verifyRoster(db: any, businessId: string): Promise<void> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("name, active, phone_e164, named_broadcast_enabled")
    .eq("business_id", businessId)
    .in("name", BROADCAST_NAMES);
  if (error) throw new Error(`roster read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{
    name: string;
    active: boolean;
    phone_e164: string | null;
    named_broadcast_enabled: boolean | null;
  }>;
  for (const name of BROADCAST_NAMES) {
    const hits = rows.filter((r) => r.name === name && r.active);
    if (hits.length !== 1) {
      throw new Error(`expected exactly one ACTIVE roster member named "${name}", found ${hits.length}`);
    }
    if (!hits[0]!.phone_e164) throw new Error(`roster member "${name}" has no phone`);
    // Only an explicit false excludes; null means available.
    if (hits[0]!.named_broadcast_enabled === false) {
      throw new Error(
        `roster member "${name}" has named_broadcast_enabled=false; the broadcast would silently skip them`
      );
    }
  }
  console.log(`Roster pre-flight OK: ${BROADCAST_NAMES.join(", ")}`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (isRevert) {
    const { data: rows, error } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", basename(SCRIPT))
      .order("applied_at", { ascending: false });
    if (error) {
      console.error(`Ledger read failed: ${error.message}`);
      process.exit(1);
    }
    const newest = new Map<string, Record<string, unknown>>();
    for (const row of (rows ?? []) as Array<{ details: Record<string, unknown> | null }>) {
      const d = row.details;
      const name = String(d?.flow_name ?? "");
      if (!name || d?.reverted === true || !d?.previous_definition) continue;
      if (!newest.has(name)) newest.set(name, d!);
    }
    if (newest.size === 0) {
      console.error("No applied ledger rows with a previous_definition to revert to.");
      process.exit(2);
    }
    for (const [name, d] of newest) {
      console.log(`revert ${name} (${d.flow_id})`);
      if (!apply) continue;
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: d.previous_definition })
        .eq("id", String(d.flow_id))
        .eq("business_id", businessId);
      if (upErr) {
        console.error(`Revert failed for ${name}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> reverted.");
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? SCRIPT,
        businessId,
        details: { flow_id: d.flow_id, flow_name: name, reverted: true }
      });
    }
    if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }

  try {
    await verifyRoster(db, businessId);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const names = Object.keys(PATCHERS);
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .in("name", names);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flows not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let result: PatchResult;
    try {
      result = PATCHERS[row.name]!(def);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: already correct, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      console.error(`${row.name} would become INVALID, aborting before any write:`);
      if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
      else console.error(e);
      process.exit(2);
    }
    console.log(`${row.name}: ${result.touched.join(", ")}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def })
      .eq("id", row.id);
    if (upErr) {
      console.error(`Update failed for ${row.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: {
        flow_id: row.id,
        flow_name: row.name,
        touched: result.touched,
        previous_definition: previous
      }
    });
  }
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
