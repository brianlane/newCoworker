#!/usr/bin/env tsx
/**
 * One-shot: put ReferralExchange / RealEstateAgents.com leads on the AI worker
 * for first contact. The reasoning lives in
 * referralexchange-ai-first-contact-definition.ts; this file resolves the
 * roster, reads, validates, writes and records.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/referralexchange-ai-first-contact.ts          # dry run
 *   npx tsx scripts/oneshot/referralexchange-ai-first-contact.ts --apply
 *   npx tsx scripts/oneshot/referralexchange-ai-first-contact.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  insertAiFirstContact,
  withCallResult,
  type Ref
} from "./referralexchange-ai-first-contact-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "referralexchange-ai-first-contact.ts";
export const FLOW_NAME = "ReferralExchange Lead";

/** Roster names, resolved to refs at apply time. Never a hardcoded row id. */
const DAVE = "Dave Lane";
const GABBY = "Gabrielle Mota";
const AMY = "Amy Laidlaw";

type Step = Record<string, unknown>;
type Definition = { steps?: Step[] };

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/**
 * Resolve one ACTIVE roster member by name. Exactly one match required: two
 * rows means we cannot know whose phone the ladder should ring, and a dial
 * ladder pointed at a guess is worse than one that refuses to apply.
 */
async function resolveRef(db: any, businessId: string, name: string): Promise<Ref> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id, name, active, phone_e164")
    .eq("business_id", businessId)
    .eq("name", name);
  if (error) throw new Error(`roster lookup failed: ${error.message}`);
  const active = ((data ?? []) as Array<{ id: string; name: string; active: boolean; phone_e164: string | null }>)
    .filter((r) => r.active);
  if (active.length !== 1) {
    throw new Error(`expected exactly one ACTIVE roster member named "${name}", found ${active.length}`);
  }
  if (!active[0].phone_e164) throw new Error(`roster member "${name}" has no phone`);
  return { id: active[0].id, label: active[0].name, source: "employee" };
}

/** Append the call-result block to every team-facing offer on the flow. */
function addCallResultToOffers(def: Definition): string[] {
  const touched: string[] = [];
  const walk = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.type === "route_to_team" && typeof s.offerTemplate === "string") {
        const next = withCallResult(s.offerTemplate);
        if (next !== s.offerTemplate) {
          s.offerTemplate = next;
          touched.push(`${String(s.id)}.offerTemplate`);
        }
      }
      if (s.type === "branch") {
        for (const arm of (s.branches as Array<{ steps: Step[] }>) ?? []) walk(arm.steps);
        walk((s.else as Step[]) ?? []);
      }
    }
  };
  walk(def.steps ?? []);
  return touched;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`Flow "${FLOW_NAME}" not found on ${businessId}`);
    process.exit(2);
  }
  const row = data as { id: string; definition: Definition };

  if (isRevert) {
    const { data: rows, error: ledErr } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", SCRIPT)
      .order("applied_at", { ascending: false });
    if (ledErr) {
      console.error(`Ledger read failed: ${ledErr.message}`);
      process.exit(1);
    }
    const prev = ((rows ?? []) as Array<{ details: Record<string, unknown> | null }>)
      .map((r) => r.details)
      .find((d) => d && d.reverted !== true && d.previous_definition);
    if (!prev) {
      console.error("No applied ledger row with a previous_definition to revert to.");
      process.exit(2);
    }
    console.log(`revert ${FLOW_NAME} to ${(prev.previous_definition as Definition).steps?.length} steps`);
    if (!apply) {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
      return;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: prev.previous_definition })
      .eq("id", row.id);
    if (upErr) {
      console.error(`Revert failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: { flow_id: row.id, flow_name: FLOW_NAME, reverted: true }
    });
    return;
  }

  let refs: { dave: Ref; gabby: Ref; amy: Ref };
  try {
    refs = {
      dave: await resolveRef(db, businessId, DAVE),
      gabby: await resolveRef(db, businessId, GABBY),
      amy: await resolveRef(db, businessId, AMY)
    };
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
  const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
  let inserted = false;
  let offersTouched: string[] = [];
  try {
    inserted = insertAiFirstContact(def, refs);
    offersTouched = addCallResultToOffers(def);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (!inserted && offersTouched.length === 0) {
    console.log(`${FLOW_NAME}: already on the AI worker, nothing to do.`);
    return;
  }
  try {
    parseAiFlowDefinition(def);
  } catch (e) {
    console.error(`${FLOW_NAME} would become INVALID, aborting before any write:`);
    if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
    else console.error(e);
    process.exit(2);
  }
  console.log(
    `${FLOW_NAME}: ${previous.steps?.length} -> ${def.steps?.length} steps` +
      `${inserted ? ", AI first contact inserted" : ""}` +
      `${offersTouched.length ? `, offers: ${offersTouched.join(", ")}` : ""}`
  );
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flow_id: row.id,
      flow_name: FLOW_NAME,
      inserted,
      offers_touched: offersTouched,
      previous_definition: previous
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
