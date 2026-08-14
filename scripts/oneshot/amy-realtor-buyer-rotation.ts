#!/usr/bin/env tsx
/**
 * One-shot: Realtor.com buyer leads go round robin (Jason included), sellers
 * keep the broadcast.
 *
 * Brian, 2026-08-14, pointing at Carlos Gonzalez's run: "Why isn't Jason
 * getting offered this buyer lead too? Not simultaneously but round robin for
 * buyer."
 *
 * WHY HE WASN'T. The Realtor.com Lead flow has exactly ONE team-routing step,
 * `s4`, and `amy-broadcast-realtor-and-offer-copy.ts` (Aug 12) converted it
 * from a rotation into a broadcast to the seller trio: Gabrielle Mota, Amy
 * Laidlaw, Dave Lane. Two consequences, both visible in Carlos's run
 * (`86383e8c`):
 *   - Jason is not one of the three names, so he could never be offered a
 *     Realtor.com lead. His only appearance in any route step on this account
 *     is the buyer arm of "Follow Up Requested (Unclaimed Leads)".
 *   - `s4` has NO lead-type gate. The flow extracts `lead_type` (Carlos's run
 *     extracted "buyer") and later branches on it, but the routing step never
 *     asked, so a seller-shaped broadcast handled every buyer too.
 *
 * WHAT THIS DOES. `s4` is replaced in place by a `rt_route_gate` branch:
 *   - arm `rt_rg_buyer` (lead_type equals "buyer") holds `s4_buyer`, a
 *     ROTATION: no agentNames at all, so the worker resolves the roster at
 *     execution time and offers ONE teammate at a time in least-recently-
 *     offered order. On this roster that is Dave, Gabby and Jason; Amy is out
 *     of the race because her row carries routing_enabled=false, which is also
 *     what keeps her the owner fallback.
 *   - the else holds `s4` unchanged, still broadcasting to the trio.
 * Both steps keep `when price_gate notEquals "ai"`, so the under-$500K
 * AI-owned gate still wins over either path, including when the extraction
 * contradicts itself (price_gate "ai" with lead_type "buyer" offers nobody,
 * exactly as today).
 *
 * WHY A BRANCH AND NOT TWO GATED STEPS: a step `when` holds ONE condition, and
 * the seller path needs two (not a buyer, and not AI-gated). This is the same
 * shape ReferralExchange's `re_seller_gate` and New Lead Intake's
 * `nli_seller_gate` already use, and the arms are deterministic conditions on
 * run vars, not a model call.
 *
 * COPY MOVES WITH THE ROUTING, which is the lesson this flow has now taught
 * twice. The rotation offer regains ", or it goes to the next agent" (true
 * again) and loses "First to reply 1 gets it" (not true of a rotation); the
 * seller offer keeps first-to-claim and stops calling every lead a buyer.
 *
 * ROTATION IS SLOWER THAN A BROADCAST, by design: 10 minutes per teammate in
 * turn, then the 3-round reminder ladder over everyone offered, then Amy. That
 * is the same shape ReferralExchange and New Lead Intake buyer routes already
 * run, and it is what "not simultaneously" costs.
 *
 * PRE-FLIGHT, all abort before any write:
 *   - businesses.lead_auto_assign must be false. Rotation honors it and would
 *     HARD ASSIGN buyer leads instead of offering them; broadcast ignores it,
 *     so this risk is new the moment the step stops being a broadcast.
 *   - the expected rotation trio must all be active, phoned, and not opted out
 *     of lead rotation, or the race quietly shrinks.
 *   - anyone ELSE eligible for rotation is listed as a warning: route steps
 *     have no tag filter, so a new hire with rotation on joins buyer leads
 *     with no flow edit.
 *
 * Read-modify-write against the LIVE definition, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-realtor-buyer-rotation.ts           # dry run
 *   npx tsx scripts/oneshot/amy-realtor-buyer-rotation.ts --apply
 *   npx tsx scripts/oneshot/amy-realtor-buyer-rotation.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  BROADCAST_NAMES,
  CASCADE_CLAUSE,
  FIRST_TO_CLAIM,
  withFirstToClaim,
  withoutCascadeClause
} from "./amy-broadcast-realtor-and-offer-copy";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-realtor-buyer-rotation.ts";
const FLOW_NAME = "Realtor.com Lead";

/** The step that was the single route, and stays the SELLER broadcast. */
export const SELLER_ROUTE_ID = "s4";
/** The new rotation step, offered one teammate at a time. */
export const BUYER_ROUTE_ID = "s4_buyer";
/** The branch that splits the two, in s4's old trunk position. */
export const GATE_STEP_ID = "rt_route_gate";
/** Its buyer arm. Anything not matching falls to the else, the seller path. */
export const BUYER_ARM_ID = "rt_rg_buyer";

/**
 * Who the buyer rotation is expected to reach. NOT written into the flow: a
 * rotation names nobody, it resolves the roster at execution time. This list
 * exists so the pre-flight can prove the race actually contains the people the
 * change was asked for, Jason above all.
 */
export const ROTATION_NAMES = ["Dave Lane", "Gabrielle Mota", "Jason Lane"];

/** The AI-owned gate both routes keep: an under-$500K seller is never offered. */
export const PRICE_GATE = { var: "price_gate", notEquals: "ai" } as const;
/** The buyer arm's condition. Only an explicit "buyer" takes the rotation. */
export const BUYER_CONDITION = { var: "lead_type", equals: "buyer" } as const;

/** The offer's deadline sentence, and the rotation wording of the same line. */
export const DEADLINE_SENTENCE = "Reply 1 to claim or 2 to pass by {{offer.deadline}}.";
export const CASCADE_SENTENCE = `Reply 1 to claim or 2 to pass by {{offer.deadline}}${CASCADE_CLAUSE}.`;

/** Offer titles. The step no longer calls every Realtor.com lead a buyer. */
export const BUYER_TITLE = "New Realtor.com Buyer Lead:";
export const SELLER_TITLE = "New Realtor.com Seller Lead:";

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

/**
 * Rotation copy: the cascade clause is TRUE again (the lead really does move
 * to the next agent), and "first to reply 1 gets it" is not (only one person
 * holds the offer at a time).
 *
 * Throws rather than silently shipping a rotation offer with no cascade
 * clause: this flow has twice had a behavior change leave its wording behind,
 * and a drifted deadline line is exactly how that happens a third time.
 */
export function toBuyerRotationCopy(template: string): string {
  let out = template;
  if (!out.includes(CASCADE_CLAUSE)) {
    if (!out.includes(DEADLINE_SENTENCE)) {
      throw new Error(
        `${BUYER_ROUTE_ID}: offer copy has neither the cascade clause nor the deadline sentence to add it to; re-read the offer before rewording it`
      );
    }
    out = out.split(DEADLINE_SENTENCE).join(CASCADE_SENTENCE);
  }
  out = out
    .split("\n")
    .filter((line) => line.trim() !== FIRST_TO_CLAIM)
    .join("\n");
  return out.startsWith(SELLER_TITLE) ? `${BUYER_TITLE}${out.slice(SELLER_TITLE.length)}` : out;
}

/**
 * Broadcast copy: unchanged from what Aug 12 left, except that the title stops
 * saying "Buyer" on the arm that only ever handles sellers.
 */
export function toSellerBroadcastCopy(template: string): string {
  const out = withFirstToClaim(withoutCascadeClause(template));
  return out.startsWith(BUYER_TITLE) ? `${SELLER_TITLE}${out.slice(BUYER_TITLE.length)}` : out;
}

export type PatchResult = { changed: boolean; touched: string[] };

/** Deep clone through JSON: flow definitions are plain JSON by construction. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Split the single route into a buyer rotation and a seller broadcast.
 *
 * Idempotent two ways: a definition that already carries the gate is a no-op,
 * and a definition whose `s4` is not the Aug 12 broadcast aborts instead of
 * guessing what its routing means now.
 */
export function patchRealtorBuyerRotation(def: Definition): PatchResult {
  const steps = def.steps ?? [];
  if (steps.some((s) => s.id === GATE_STEP_ID)) return { changed: false, touched: [] };

  const idx = steps.findIndex((s) => s.id === SELLER_ROUTE_ID);
  if (idx < 0) {
    throw new Error(
      `${FLOW_NAME}: step "${SELLER_ROUTE_ID}" is not at the trunk; re-read the flow before splitting it`
    );
  }
  const route = steps[idx]!;
  if (route.type !== "route_to_team") {
    throw new Error(`${FLOW_NAME}: step "${SELLER_ROUTE_ID}" is a ${String(route.type)}, not a route`);
  }
  const names = route.agentNames as string[] | undefined;
  if (!names || names.join("|") !== BROADCAST_NAMES.join("|")) {
    throw new Error(
      `${FLOW_NAME}: step "${SELLER_ROUTE_ID}" is not the expected broadcast to ${BROADCAST_NAMES.join(", ")}; re-read the flow before splitting it`
    );
  }
  const when = route.when as { var?: string; notEquals?: string } | undefined;
  if (when?.var !== PRICE_GATE.var || when?.notEquals !== PRICE_GATE.notEquals) {
    throw new Error(
      `${FLOW_NAME}: step "${SELLER_ROUTE_ID}" no longer carries the ${PRICE_GATE.var} gate; the under-$500K AI-owned rule must survive this split`
    );
  }
  const offer = route.offerTemplate;
  if (typeof offer !== "string") {
    throw new Error(`${FLOW_NAME}: step "${SELLER_ROUTE_ID}" has no offerTemplate`);
  }

  // The buyer rotation is the same offer with the same guards; only WHO hears
  // it and HOW the copy describes the race change. Cloning rather than
  // re-authoring is what keeps the $1M+ keep-for-owner rule, the claim email,
  // the reminder ladder and the quiet-hours window identical on both paths.
  const buyer = clone(route);
  buyer.id = BUYER_ROUTE_ID;
  // A rotation names nobody: the roster IS the offer set, resolved per run.
  delete buyer.agentNames;
  buyer.offerTemplate = toBuyerRotationCopy(offer);

  const seller = clone(route);
  seller.offerTemplate = toSellerBroadcastCopy(offer);

  steps.splice(idx, 1, {
    id: GATE_STEP_ID,
    type: "branch",
    question: "Buyer or seller? Buyers go round robin, sellers broadcast",
    branches: [
      {
        id: BUYER_ARM_ID,
        label: "Buyer: round robin, one teammate at a time",
        condition: { ...BUYER_CONDITION },
        steps: [buyer]
      }
    ],
    else: [seller]
  });
  return {
    changed: true,
    touched: [
      `${GATE_STEP_ID} (replaces ${SELLER_ROUTE_ID} at the trunk)`,
      `${BUYER_ROUTE_ID}.rotation`,
      `${BUYER_ROUTE_ID}.offerTemplate`,
      `${SELLER_ROUTE_ID}.offerTemplate`
    ]
  };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

type RosterRow = {
  name: string;
  active: boolean;
  phone_e164: string | null;
  routing_enabled: boolean | null;
};

/**
 * Prove the rotation will reach the people it is meant to reach.
 *
 * A broadcast fails loudly (a name matching nobody is visibly absent from the
 * offer); a rotation fails silently, because it never says who it expected.
 */
// deno-lint-ignore no-explicit-any
async function verifyRotation(db: any, businessId: string): Promise<void> {
  const { data: bizData, error: bizErr } = await db
    .from("businesses")
    .select("lead_auto_assign")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr) throw new Error(`business read failed: ${bizErr.message}`);
  if (!bizData) throw new Error(`business ${businessId} not found`);
  if ((bizData as { lead_auto_assign?: boolean | null }).lead_auto_assign === true) {
    throw new Error(
      "lead_auto_assign is ON: a rotation would HARD ASSIGN buyer leads instead of offering them (broadcast ignores the setting, rotation honors it). Turn it off, or keep the broadcast."
    );
  }

  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("name, active, phone_e164, routing_enabled")
    .eq("business_id", businessId);
  if (error) throw new Error(`roster read failed: ${error.message}`);
  const rows = (data ?? []) as RosterRow[];
  // Only an explicit false opts a member out; null means available.
  const eligible = rows.filter((r) => r.active && r.routing_enabled !== false && r.phone_e164);
  for (const name of ROTATION_NAMES) {
    const hits = eligible.filter((r) => r.name === name);
    if (hits.length !== 1) {
      const present = rows.filter((r) => r.name === name);
      const why =
        present.length === 0
          ? "not on the roster"
          : present.some((r) => !r.active)
            ? "not active"
            : present.some((r) => r.routing_enabled === false)
              ? "has lead rotation turned off"
              : present.some((r) => !r.phone_e164)
                ? "has no phone"
                : `matched ${hits.length} rows`;
      throw new Error(`"${name}" would not be in the buyer rotation: ${why}`);
    }
  }
  console.log(`Rotation pre-flight OK: ${ROTATION_NAMES.join(", ")}`);
  // Route steps have no tag filter, so rotation eligibility is a roster
  // switch, not a flow decision. Say who else it currently lets in.
  const extra = eligible.filter((r) => !ROTATION_NAMES.includes(r.name)).map((r) => r.name);
  if (extra.length > 0) {
    console.log(
      `WARNING: also eligible for the buyer rotation (lead rotation is on for them): ${extra.join(", ")}. Turn "lead rotation" off on the Employees page for anyone who should not receive buyer leads.`
    );
  }
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
    const newest = ((rows ?? []) as Array<{ details: Record<string, unknown> | null }>)
      .map((r) => r.details)
      .find((d) => d && d.reverted !== true && d.previous_definition);
    if (!newest) {
      console.error("No applied ledger rows with a previous_definition to revert to.");
      process.exit(2);
    }
    console.log(`revert ${FLOW_NAME} (${String(newest.flow_id)})`);
    if (!apply) {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
      return;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: newest.previous_definition })
      .eq("id", String(newest.flow_id))
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Revert failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: { flow_id: newest.flow_id, flow_name: FLOW_NAME, reverted: true }
    });
    return;
  }

  try {
    await verifyRotation(db, businessId);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

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
  const row = data as { id: string; name: string; definition: Definition };

  const previous = clone(row.definition);
  const def = clone(row.definition);
  let result: PatchResult;
  try {
    result = patchRealtorBuyerRotation(def);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (!result.changed) {
    console.log(`${FLOW_NAME}: already split, nothing to do.`);
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
  console.log(`${FLOW_NAME}: ${result.touched.join(", ")}`);
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
      touched: result.touched,
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
