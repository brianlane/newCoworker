#!/usr/bin/env tsx
/**
 * One-shot: teach "Clever Lead - Accept" whether the referral is a BUYER or a
 * seller, and stop it pitching a listing to someone who is buying.
 *
 * Why. This flow is seller-shaped from top to bottom, by construction rather
 * than by accident: Clever Offers is a seller program, so every field in
 * `read_details` reads "the seller's ...", the AI call opens "about your
 * request through Clever about selling your home on {{vars.lead_address}}" and
 * pitches listing against a cash offer, and the unreachable-lead broadcast is
 * hard-coded to the `seller` team tag.
 *
 * Clever nonetheless sends BUYER referrals through the same "Clever referral"
 * format this flow triggers on. Two real ones so far, Jul 8 and Jul 31 2026,
 * and both were handled as sellers end to end. Because the flow declared no
 * lead type at all, the failure also travelled: the "Needs Follow Up (AI
 * cadence)" it hands leads to had nothing to read, so every Clever lead
 * reached it as a seller too.
 *
 * The referral text states the answer. Across this flow's 119 runs it carries
 * a bare "Seller" line 116 times and a bare "Buyer" line twice, directly under
 * the link; one run states neither. So this reads the TEXT, not the browsed
 * page: `read_details` is a browse_extract against the Clever portal, and the
 * bare type line is a property of the SMS.
 *
 * Three changes:
 *
 *   1. `read_type`, a new extract_text step at the FRONT of the flow, sets
 *      `lead_type` from that line. It defaults to `seller` when the text does
 *      not say, which is a genuine fallback rather than the stand-in it would
 *      be elsewhere: the text does say in 118 of 119 runs, and Clever Offers
 *      is a seller program, so the default preserves today's exact behavior
 *      for the one case that is silent.
 *   2. `clever_call_gate`, a branch wrapping `ai_call_1`, so a buyer never
 *      receives the listing pitch. The step keeps its id and its own
 *      `price_under_1m` guard, it simply moves into the else arm: a `when`
 *      holds exactly one condition, so two guards need a wrapper. Writing a
 *      BUYER persona is deliberately not attempted here; that is Amy's copy
 *      to write, and this stops the wrong call rather than inventing a right
 *      one. The retries need no gate of their own, they sit behind
 *      `call_outcome equals no_answer` and a skipped call leaves it unset.
 *   3. `clever_no_phone_offer.teamTagTemplate` moves from the literal
 *      "seller" to `{{vars.lead_type}}`. Strictly an improvement on this
 *      roster: `seller` reaches Gabrielle and Dave exactly as the literal did,
 *      while `buyer` also reaches Jason Lane, whose only tag is `buyer` and
 *      who could therefore never be offered a Clever lead. Only that step
 *      changes; `route` pins recipients with `agentNames`, and the schema
 *      refuses teamTagTemplate alongside pinned recipients (a tag filter
 *      narrows a whole-roster broadcast). Re-pointing `route` would mean
 *      switching it to broadcastAll, which would silently drop Amy, whose
 *      `team_broadcast_enabled` is false because she is the backstop. That is
 *      a routing decision for Amy, not a side effect of this script.
 *
 * Downstream, for free: the flow now DECLARES `lead_type`, so
 * `amy-cadence-lead-type-from-note.ts` stops skipping it by rule and marks its
 * six "Needs Follow Up" tag writers on the next run. Run that script again
 * after this one.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent, and
 * it aborts rather than guessing when a step it expects is missing or already
 * shaped differently. Refuses while a run is in flight unless --force, since
 * this restructures the trunk. Dry-run by default, ledger-recorded on --apply.
 * Enqueues nothing and sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-lead-type.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-lead-type.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-clever-lead-type.ts --business <uuid> --revert --apply
 */

/** The flow this patches. */
export const CLEVER_FLOW_NAME = "Clever Lead - Accept";

/** Step ids this script owns. Both are new; neither may collide. */
export const TYPE_STEP_ID = "read_type";
export const CALL_GATE_STEP_ID = "clever_call_gate";

/** The step whose seller pitch must not reach a buyer. */
export const GATED_CALL_STEP_ID = "ai_call_1";

/** The broadcast whose audience was pinned to the seller tag. */
export const NO_PHONE_OFFER_STEP_ID = "clever_no_phone_offer";

/** What the team tag should say once the flow knows the type. */
export const LEAD_TYPE_TAG_TEMPLATE = "{{vars.lead_type}}";

type AnyStep = Record<string, unknown> & { id?: unknown; type?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;

/**
 * The extraction that reads the type off the referral text.
 *
 * Buyer or seller only, with no "both": Clever states one word on one line,
 * and offering a third answer the source never gives would invite the model
 * to reason its way to one.
 */
export function readTypeStep(): AnyStep {
  return {
    id: TYPE_STEP_ID,
    type: "extract_text",
    fields: [
      {
        name: "lead_type",
        description:
          "Is this Clever referral for a buyer or a seller? The referral text " +
          "states it on a line of its own, just under the link. Answer exactly one " +
          "lowercase word: buyer or seller. Clever Offers is a seller program, so " +
          "when the text does not state it either way, answer exactly: seller"
      }
    ]
  };
}

/** Every step in a raw JSON definition, branches and else-arms included. */
export function walkSteps(steps: unknown): AnyStep[] {
  const out: AnyStep[] = [];
  if (!Array.isArray(steps)) return out;
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as AnyStep;
    out.push(step);
    for (const key of ["steps", "else"]) out.push(...walkSteps(step[key]));
    const branches = step.branches;
    if (Array.isArray(branches)) {
      for (const b of branches) {
        if (b && typeof b === "object" && !Array.isArray(b)) {
          out.push(...walkSteps((b as Record<string, unknown>).steps));
        }
      }
    }
  }
  return out;
}

/** Has this definition already been patched? */
export function alreadyPatched(def: AnyDef): boolean {
  const ids = walkSteps(def.steps).map((s) => s.id);
  return ids.includes(TYPE_STEP_ID) && ids.includes(CALL_GATE_STEP_ID);
}

/**
 * Apply all three changes to a raw definition, returning a description of each
 * one actually made. Returns `problems` instead of throwing when the live
 * shape is not what this script was written against, so the caller can refuse
 * to write anything rather than half-patch a live flow.
 */
export function patchCleverFlow(def: AnyDef): { changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  const trunk = Array.isArray(def.steps) ? (def.steps as AnyStep[]) : null;
  if (!trunk) {
    problems.push("definition has no steps array");
    return { changed, problems };
  }
  const all = walkSteps(def.steps);

  // 1. The extraction, at the front so every later step can read it.
  if (!all.some((s) => s.id === TYPE_STEP_ID)) {
    trunk.unshift(readTypeStep());
    changed.push(`${TYPE_STEP_ID}: new extract_text sets lead_type from the referral text`);
  }

  // 2. The call gate. ai_call_1 must still be a TRUNK step for this to be a
  //    move rather than a duplication; if a previous edit already nested it,
  //    say so instead of creating a second copy.
  if (!all.some((s) => s.id === CALL_GATE_STEP_ID)) {
    const callIndex = trunk.findIndex((s) => s.id === GATED_CALL_STEP_ID);
    if (callIndex < 0) {
      const nested = all.some((s) => s.id === GATED_CALL_STEP_ID);
      problems.push(
        nested
          ? `"${GATED_CALL_STEP_ID}" is no longer a trunk step, so this script cannot wrap it`
          : `"${GATED_CALL_STEP_ID}" is missing from the flow`
      );
    } else {
      const call = trunk[callIndex];
      trunk.splice(callIndex, 1, {
        id: CALL_GATE_STEP_ID,
        type: "branch",
        question: "Is this Clever referral a buyer or a seller?",
        branches: [
          {
            id: "clever_type_buyer",
            label: "Buyer: no listing pitch, a teammate works it",
            condition: { var: "lead_type", equals: "buyer" },
            steps: []
          }
        ],
        // The seller path is the else arm, so ai_call_1 keeps its id, its
        // position relative to everything after it, and its own price guard.
        else: [call]
      });
      changed.push(
        `${CALL_GATE_STEP_ID}: wraps ${GATED_CALL_STEP_ID} so a buyer never gets the listing pitch`
      );
    }
  }

  // 3. The broadcast audience.
  const offer = all.find((s) => s.id === NO_PHONE_OFFER_STEP_ID);
  if (!offer) {
    problems.push(`"${NO_PHONE_OFFER_STEP_ID}" is missing from the flow`);
  } else if (offer.broadcastAll !== true) {
    // teamTagTemplate is only legal on a whole-roster broadcast.
    problems.push(`"${NO_PHONE_OFFER_STEP_ID}" no longer sets broadcastAll, so a tag filter is invalid there`);
  } else if (offer.teamTagTemplate !== LEAD_TYPE_TAG_TEMPLATE) {
    const before = typeof offer.teamTagTemplate === "string" ? offer.teamTagTemplate : "(none)";
    offer.teamTagTemplate = LEAD_TYPE_TAG_TEMPLATE;
    changed.push(`${NO_PHONE_OFFER_STEP_ID}: teamTagTemplate ${before} -> ${LEAD_TYPE_TAG_TEMPLATE}`);
  }

  return { changed, problems };
}

/** Put the flow back: unwrap the call, drop the extraction, re-pin the tag. */
export function revertCleverFlow(def: AnyDef): string[] {
  const changed: string[] = [];
  const trunk = Array.isArray(def.steps) ? (def.steps as AnyStep[]) : [];

  const gateIndex = trunk.findIndex((s) => s.id === CALL_GATE_STEP_ID);
  if (gateIndex >= 0) {
    const gate = trunk[gateIndex];
    const inner = Array.isArray(gate.else) ? (gate.else as AnyStep[]) : [];
    trunk.splice(gateIndex, 1, ...inner);
    changed.push(`${CALL_GATE_STEP_ID}: removed, ${GATED_CALL_STEP_ID} back on the trunk`);
  }
  const typeIndex = trunk.findIndex((s) => s.id === TYPE_STEP_ID);
  if (typeIndex >= 0) {
    trunk.splice(typeIndex, 1);
    changed.push(`${TYPE_STEP_ID}: removed`);
  }
  const offer = walkSteps(def.steps).find((s) => s.id === NO_PHONE_OFFER_STEP_ID);
  if (offer && offer.teamTagTemplate === LEAD_TYPE_TAG_TEMPLATE) {
    offer.teamTagTemplate = "seller";
    changed.push(`${NO_PHONE_OFFER_STEP_ID}: teamTagTemplate back to seller`);
  }
  return changed;
}

/* c8 ignore start -- the IO shell; the pure patch above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { parseAiFlowDefinition, summarizeDefinition } = await import(
    "../../src/lib/ai-flows/schema.ts"
  );
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const REVERT = process.argv.includes("--revert");
  const FORCE = process.argv.includes("--force");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-clever-lead-type.ts --business <uuid> [--apply] [--revert] [--force]"
    );
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", CLEVER_FLOW_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`"${CLEVER_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  // Restructuring the trunk while a run is mid-flight is the one thing that
  // could strand it, so look before writing.
  const { data: live } = await db
    .from("ai_flow_runs")
    .select("id,status")
    .eq("flow_id", row.id)
    .not("status", "in", '("done","failed","canceled")');
  if ((live ?? []).length > 0 && !FORCE) {
    console.error(`${(live ?? []).length} run(s) still in flight on this flow:`);
    for (const r of live ?? []) console.error(`  ${r.id} (${r.status})`);
    console.error("Re-run with --force to patch anyway (resume is by step id, and no id is removed).");
    process.exit(2);
  }

  const next = JSON.parse(JSON.stringify(row.definition)) as AnyDef;
  const { changed, problems } = REVERT
    ? { changed: revertCleverFlow(next), problems: [] as string[] }
    : patchCleverFlow(next);

  if (problems.length > 0) {
    console.error("\nThe live definition is not what this script expects, so nothing was written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  console.log(`=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log(REVERT ? "  nothing to revert" : "  already patched, no changes");
    process.exit(0);
  }
  for (const c of changed) console.log(`  - ${c}`);

  let validated;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (e) {
    console.error(`\nwould not validate after patching: ${String(e)}`);
    process.exit(1);
  }
  console.log(`  after: ${summarizeDefinition(validated)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const { data: updated, error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id)
    .eq("business_id", BUSINESS_ID)
    .select("id");
  if (upErr) {
    console.error(`update failed: ${upErr.message}`);
    process.exit(1);
  }
  if ((updated ?? []).length !== 1) {
    console.error(`update matched ${(updated ?? []).length} rows; NOT written.`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-lead-type.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, reverted: REVERT }
  });
  console.log(
    REVERT
      ? "\nReverted."
      : "\nDone. Now re-run amy-cadence-lead-type-from-note.ts: this flow declares lead_type, so its tag writers are no longer skipped."
  );
}

/* c8 ignore stop */
