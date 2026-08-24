#!/usr/bin/env tsx
/**
 * One-shot: send a Clever BUYER referral round the buyer rotation, and say on
 * the offer that the AI is not following this one up.
 *
 * Where this picks up. `amy-clever-lead-type.ts` taught "Clever Lead - Accept"
 * to read `lead_type` off the referral text and gated the AI call so a buyer
 * never receives the listing pitch (the persona opens "about your request
 * through Clever about selling your home on {{vars.lead_address}}"). That
 * stopped the wrong call, and left two things unfinished:
 *
 *   1. Every Clever lead was still OFFERED to the same pinned trio,
 *      Gabrielle Mota / Amy Laidlaw / Dave Lane, which is the seller
 *      broadcast. Jason Lane, whose only roster tag is `buyer`, was never
 *      offered a Clever buyer.
 *   2. The offer copy promised follow-up that will now never happen: "the AI
 *      calls again in about 2 hours, then once more tomorrow morning". For a
 *      buyer the AI never called at all, so a teammate reading that could
 *      reasonably leave the lead alone believing the AI has it.
 *
 * Both are fixed by splitting the route, mirroring `rt_route_gate` in
 * "Realtor.com Lead" rather than inventing a second shape for the same
 * decision. That flow already forks buyers to a round robin and sellers to the
 * broadcast, and the two accounts of "how does a lead reach a teammate here"
 * should not diverge.
 *
 * The new `clever_route_gate` branch wraps the existing `route`:
 *
 *   - Buyer arm: `route_buyer`, a route_to_team with NO `agentNames`. That is
 *     what the rotation IS on this engine: unpinned means offered to one
 *     teammate at a time, in rotation order, rather than broadcast to a named
 *     list. Its copy states plainly that the AI has not contacted the lead and
 *     will not, so whoever claims knows they are the only contact.
 *   - Else arm: `route`, byte for byte as it is today. Sellers are the 116 of
 *     119 case and nothing about them changes.
 *
 * The branch carries no `when` of its own; each route keeps its own
 * `price_gate` guard, exactly as Realtor.com does it. The $1M+ keep-for-Amy
 * rule (`ownerDirectWhen` on `price_under_1m`) is carried onto the buyer route
 * too: it is a price rule, not a seller rule.
 *
 * Known and deliberately not fixed here: `price_gate` and `price_under_1m`
 * come out EMPTY on a buyer referral, because `read_details` asks for the
 * "estimated home value" and a buyer page shows an "Est. Price Range" instead
 * (both real buyer runs, Jul 8 and Jul 31 2026, extracted neither). Empty is
 * the harmless direction here: `price_gate notEquals "ai"` holds, so the buyer
 * route runs, and `price_under_1m equals "no"` does not, so the lead is
 * offered rather than kept. Teaching the extraction to read a buyer's price
 * range is a separate change with its own copy decisions.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent, and
 * it aborts rather than guessing when the live shape has moved. Refuses while
 * a run is in flight unless --force. Dry-run by default, ledger-recorded.
 * Enqueues nothing and sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-buyer-rotation.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-buyer-rotation.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-clever-buyer-rotation.ts --business <uuid> --revert --apply
 */
import { CLEVER_FLOW_NAME, walkSteps } from "./amy-clever-lead-type";

export { CLEVER_FLOW_NAME };

/** The branch that forks the offer, and the buyer route inside it. */
export const ROUTE_GATE_STEP_ID = "clever_route_gate";
export const BUYER_ROUTE_STEP_ID = "route_buyer";

/** The seller route this wraps, left exactly as it is. */
export const SELLER_ROUTE_STEP_ID = "route";

/**
 * The one sentence this change exists to put in front of a teammate.
 *
 * The seller offer says the AI calls again in about two hours and once more
 * tomorrow. For a buyer none of that happens, and an offer that implies it
 * invites the reader to wait for a follow-up that is never coming.
 */
export const NO_AI_FOLLOW_UP_LINE =
  "The AI has NOT called or texted this lead and will not: it only works Clever seller " +
  "referrals, so this buyer is not on AI follow-up. Nothing reaches them unless you take it.";

type AnyStep = Record<string, unknown> & { id?: unknown; type?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;

/**
 * The buyer route.
 *
 * Shaped from the live seller route rather than written from scratch, so the
 * pair cannot drift on the things that must match (the offer window, the
 * response clock, the reminder ladder, the $1M+ rule, the claim-notify
 * address). What differs is only what SHOULD differ: no pinned recipient list,
 * buyer-shaped labels, and the follow-up line above.
 */
export function buyerRouteStep(): AnyStep {
  const identity =
    "{{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
    "Looking in: {{vars.lead_address}}\n" +
    "Lead source: Clever (listwithclever.com)";
  return {
    id: BUYER_ROUTE_STEP_ID,
    type: "route_to_team",
    // Same price gate the seller route carries; the branch adds none of its own.
    when: { var: "price_gate", notEquals: "ai" },
    // No agentNames on purpose: unpinned IS the rotation, one teammate at a
    // time in rotation order, which is how buyers are routed on this account.
    offerWindow: {
      quietEnd: "08:30",
      timezone: "America/Phoenix",
      quietStart: "21:00",
      graceMinutes: 10
    },
    offerTemplate:
      `New Clever BUYER lead: ${identity}\n` +
      "Details: {{trigger.windowText}}\n\n" +
      `${NO_AI_FOLLOW_UP_LINE}\n\n` +
      "Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.\n" +
      'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").\n' +
      'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").',
    // A price rule, not a seller rule: a $1M+ buyer is still Amy's own.
    ownerDirectWhen: { var: "price_under_1m", equals: "no" },
    ownerDirectTemplate:
      "‼️‼️‼️‼️‼️\n" +
      "HIGH DOLLAR CLEVER BUYER LEAD ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM.\n" +
      `${identity}\n` +
      "The AI is not following this one up: buyers are not on AI follow-up.\n" +
      "‼️‼️‼️‼️‼️",
    ownerDirectNudges: true,
    responseMinutes: 10,
    attachScreenshot: true,
    claimedNotifyEmail: "amy@amylaidlaw.com",
    shareContactHistory: true,
    unclaimedReminders: {
      rounds: 3,
      detailsTemplate:
        "Looking in: {{vars.lead_address}}\nBuyer lead, so the AI is not following up.",
      intervalMinutes: 20
    },
    claimedNotifyTemplate:
      `{{agent.name}} claimed the Clever BUYER lead ${identity}\n` +
      "The AI never called this one: buyers are not on AI follow-up, so {{agent.name}} is their " +
      "only contact.",
    ownerFallbackTemplate:
      "‼️‼️‼️‼️‼️\n" +
      `No agent claimed the Clever BUYER lead ${identity}\n` +
      "Details: {{trigger.windowText}}\n" +
      "It's back to you.\n\n" +
      "The AI has not contacted them and will not: buyers are not on AI follow-up, so nobody " +
      "has spoken to this lead."
  };
}

/** Has this definition already been patched? */
export function alreadyPatched(def: AnyDef): boolean {
  return walkSteps(def.steps).some((s) => s.id === ROUTE_GATE_STEP_ID);
}

/**
 * Fork the route. Returns `problems` rather than throwing so the caller can
 * refuse to write at all instead of half-patching a live lead flow.
 */
export function patchBuyerRotation(def: AnyDef): { changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  const trunk = Array.isArray(def.steps) ? (def.steps as AnyStep[]) : null;
  if (!trunk) {
    problems.push("definition has no steps array");
    return { changed, problems };
  }
  if (alreadyPatched(def)) return { changed, problems };

  const routeIndex = trunk.findIndex((s) => s.id === SELLER_ROUTE_STEP_ID);
  if (routeIndex < 0) {
    problems.push(
      walkSteps(def.steps).some((s) => s.id === SELLER_ROUTE_STEP_ID)
        ? `"${SELLER_ROUTE_STEP_ID}" is no longer a trunk step, so this script cannot wrap it`
        : `"${SELLER_ROUTE_STEP_ID}" is missing from the flow`
    );
    return { changed, problems };
  }
  const seller = trunk[routeIndex];
  if (!Array.isArray(seller.agentNames) || seller.agentNames.length === 0) {
    // If the seller route were already unpinned, "fork buyers to the rotation"
    // would be a no-op dressed up as a change.
    problems.push(`"${SELLER_ROUTE_STEP_ID}" no longer pins agentNames, so the fork would change nothing`);
    return { changed, problems };
  }

  trunk.splice(routeIndex, 1, {
    id: ROUTE_GATE_STEP_ID,
    type: "branch",
    question: "Buyer or seller? Buyers go round robin, sellers broadcast",
    branches: [
      {
        id: "clever_rg_buyer",
        label: "Buyer: round robin, one teammate at a time",
        condition: { var: "lead_type", equals: "buyer" },
        steps: [buyerRouteStep()]
      }
    ],
    // The seller route moves in untouched, keeping its id and its own guard.
    else: [seller]
  });
  changed.push(`${ROUTE_GATE_STEP_ID}: forks the offer on lead_type`);
  changed.push(
    `${BUYER_ROUTE_STEP_ID}: buyer rotation (unpinned), offer states the AI is not following up`
  );
  return { changed, problems };
}

/** Unwrap: the seller route returns to the trunk, the buyer route is dropped. */
export function revertBuyerRotation(def: AnyDef): string[] {
  const trunk = Array.isArray(def.steps) ? (def.steps as AnyStep[]) : [];
  const gateIndex = trunk.findIndex((s) => s.id === ROUTE_GATE_STEP_ID);
  if (gateIndex < 0) return [];
  const gate = trunk[gateIndex];
  const seller = (Array.isArray(gate.else) ? (gate.else as AnyStep[]) : []).filter(
    (s) => s.id === SELLER_ROUTE_STEP_ID
  );
  trunk.splice(gateIndex, 1, ...seller);
  return [`${ROUTE_GATE_STEP_ID}: removed, ${SELLER_ROUTE_STEP_ID} back on the trunk`];
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
      "Usage: tsx scripts/oneshot/amy-clever-buyer-rotation.ts --business <uuid> [--apply] [--revert] [--force]"
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
    ? { changed: revertBuyerRotation(next), problems: [] as string[] }
    : patchBuyerRotation(next);

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
    scriptPath: process.argv[1] ?? "amy-clever-buyer-rotation.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, reverted: REVERT }
  });
  console.log(
    REVERT
      ? "\nReverted. Every Clever lead is offered to the pinned seller trio again."
      : "\nDone. A Clever buyer now goes round the buyer rotation, and the offer says the AI is not following up."
  );
}

/* c8 ignore stop */
