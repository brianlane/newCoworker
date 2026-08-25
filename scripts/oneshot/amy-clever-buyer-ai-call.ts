#!/usr/bin/env tsx
/**
 * One-shot: the AI works a Clever BUYER the way it works a Clever seller, and
 * Jason Lane joins every buyer live transfer.
 *
 * Amy, 2026-08-24: "You can treat the Clever buyers similar to the response
 * for a realestateagent.com buyer lead and send them round Robyn to the team.
 * ... you let me know if it makes more sense for the AI to handle the Clever
 * buyer calls and Texts until they're serious and want to either make an
 * appointment or do a Live transfer to me or Dave or Gabby or Jason or have a
 * team member call them back. That's how we handle the Clever seller leads."
 *
 * Those read as two options and are one. RealEstateAgents.com is not a flow of
 * its own: all 119 runs whose `web_source` names it ran on "ReferralExchange
 * Lead", and that flow's buyer path ALREADY does what the second half
 * describes. `ai_call_buyer` there says: find out area, bedrooms, budget and
 * timeline, "if they are serious and want to speak to someone now, use the
 * reach tool to connect them to a teammate", and if nobody picks up, promise a
 * callback and record the time that suits. Then `route_buyer` sends them round
 * the rotation anyway. So "like a realestateagents.com buyer" and "let the AI
 * handle it until they are serious" are the same instruction.
 *
 * So this mirrors the CLEVER SELLER ladder, which is the comparison Amy's last
 * sentence actually anchors on, using the ReferralExchange buyer call as the
 * source for the buyer copy.
 *
 * Part 1, the buyer call ladder. `clever_call_gate` (from
 * `amy-clever-lead-type.ts`) has an empty buyer arm: a buyer gets no call at
 * all today, because the seller persona opens "about your request through
 * Clever about selling your home on {{vars.lead_address}}". The arm now holds
 * `ai_call_buyer`, and the two RETRY rungs get the same treatment.
 *
 * That retry detail is the trap this script exists to avoid. `ai_call_2` and
 * `ai_call_3` are seller-worded too, and they sit under
 * `call_followups[cf_no_answer]`, gated on `call_outcome equals no_answer`,
 * which a buyer call sets exactly like a seller call does. Filling only the
 * first arm would give a buyer who does not pick up two more calls pitching a
 * listing, reintroducing through the back door the bug that gating the call
 * fixed. Each rung is therefore wrapped in its own type gate, mirroring the
 * `ai_first_contact` branch in ReferralExchange, which splits its call the
 * same way rather than templating one persona to serve two jobs.
 *
 * Part 2, Jason. Amy named him as a live-transfer target and, asked directly,
 * said "he should be in the rotation for all buyer leads". The ROTATION part
 * is already true and needs no change: an unpinned `route_to_team` offers to
 * every ACTIVE roster member in least-recently-offered order, not a
 * tag-filtered subset, and Jason has been offered 18 leads that way since Jul
 * 1 including Sandy Baldwin's, where he was rung FIRST. The real gap is the
 * live TRANSFER: `reachTeammate` is an explicit list, and ReferralExchange's
 * buyer call rings Dave, Gabrielle and Amy only, so the one teammate whose
 * only roster tag is `buyer` is the one it cannot reach.
 *
 * A PLATFORM LIMIT forces a choice here, and it is worth stating plainly
 * because it does not match Amy's words. She asked for a live transfer to
 * "me or Dave or Gabby or Jason", which is four people, and
 * `reachTeammate.refs` is capped at THREE (`schema.ts`). The cap is not
 * arbitrary: this is a warm transfer, so the lead is held on the line while
 * each teammate is dialled in turn, and at 20 seconds a rung a fourth name
 * means a full minute of hold before the AI comes back to them.
 *
 * The buyer ladder is therefore Dave, Gabrielle and Jason, and Amy comes off
 * it. She is the least-loss name to drop, for a reason this account already
 * encodes rather than one invented here: Amy is the BACKSTOP, not part of the
 * audience (`team_broadcast.ts` says so outright, and her
 * `team_broadcast_enabled` is false by design). She still gets a buyer who
 * nobody takes, through the owner fallback, and a $1M+ buyer never reaches
 * the ladder at all because `ownerDirectWhen` keeps them hers. Jason, by
 * contrast, has no other way in: `buyer` is his only roster tag and the
 * transfer ladder is an explicit list. If Amy would rather be on it than one
 * of the other two, that is a one-line change to BUYER_REACH_NAMES.
 *
 * The SELLER calls are deliberately left alone, ladder included. Jason's
 * roster tag is `buyer` only, and Amy's instruction was about buyer leads.
 *
 * What is NOT changed, both asked and answered on 2026-08-24:
 *   - `route_buyer` keeps its `price_gate` guard. Amy chose to keep the
 *     under-$500K AI-owned rule for Clever buyers rather than adopting
 *     ReferralExchange's ungated buyer routing, so a small-budget buyer stays
 *     with the AI and reaches a teammate by live transfer, by the promote path
 *     after a transfer, or through the follow-up cadence.
 *   - No lead-facing SMS is added. "Clever Lead - Accept" sends the lead no
 *     text at all, for sellers either; the texts in Amy's "calls and Texts"
 *     come from the follow-up cadence, which is where an under-$500K Clever
 *     lead of either type lands. Adding one here would give buyers more
 *     outreach than sellers on the same network.
 *   - The $1M+ rule. `ai_call_buyer` carries the same
 *     `price_under_1m notEquals "no"` guard as `ai_call_1`, so a $1M+ buyer is
 *     never called and stays Amy's own.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent, and
 * it refuses rather than guessing when the live shape has moved. Refuses while
 * a run is in flight unless --force. Dry-run by default, ledger-recorded,
 * --revert undoes both parts. Enqueues nothing and sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-buyer-ai-call.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-buyer-ai-call.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-clever-buyer-ai-call.ts --business <uuid> --apply --with-referral
 *   npx tsx scripts/oneshot/amy-clever-buyer-ai-call.ts --business <uuid> --revert --apply
 */
import { CLEVER_FLOW_NAME, walkSteps } from "./amy-clever-lead-type";
import { CALL_GATE_STEP_ID } from "./amy-clever-lead-type";

export { CLEVER_FLOW_NAME, CALL_GATE_STEP_ID };

/** The other flow this touches, for Jason only. */
export const REFERRAL_FLOW_NAME = "ReferralExchange Lead";
export const REFERRAL_BUYER_CALL_ID = "ai_call_buyer";

/**
 * The warm-transfer ladder is capped at three (`reachTeammate.refs` in
 * schema.ts). The lead waits on the line while each rung is dialled, so the
 * cap is a hold-time budget, not a formality.
 */
export const MAX_REACH_REFS = 3;

/**
 * Who a BUYER is transferred to, in order. Amy named four people and only
 * three fit; she is the backstop (`team_broadcast_enabled` false by design)
 * and still receives an unclaimed buyer through the owner fallback, while
 * Jason has no other route onto a live transfer.
 */
export const BUYER_REACH_NAMES = ["Dave Lane", "Gabrielle Mota", "Jason Lane"] as const;

/** What the ReferralExchange buyer ladder held before this script. */
export const REFERRAL_BUYER_REACH_PREVIOUS = [
  "Dave Lane",
  "Gabrielle Mota",
  "Amy Laidlaw"
] as const;

/**
 * The seller rungs, each paired with the buyer rung this adds.
 *
 * `mode` is not a style choice. Round 1 has a branch already
 * (`clever_call_gate`, from amy-clever-lead-type.ts) with an empty buyer arm,
 * so it is filled. Rounds 2 and 3 CANNOT be wrapped the same way: they sit at
 * `call_followups[cf_no_answer] > retry_2.else > retry_3.else`, and the schema
 * rejects branches nested more than three deep. So they use the idiom the
 * schema documents for exactly this ("two gated steps give simple branching,
 * e.g. a buyer vs. seller send_sms"): the seller rung gains
 * `lead_type notEquals buyer`, the buyer rung sits beside it with
 * `lead_type equals buyer`, and the nesting depth does not move. Both rungs
 * have no `when` today, so nothing is displaced.
 */
export const CALL_RUNGS: ReadonlyArray<{
  sellerId: string;
  buyerId: string;
  mode: "fill-arm" | "sibling";
  round: 1 | 2 | 3;
}> = [
  { sellerId: "ai_call_1", buyerId: "ai_call_buyer", mode: "fill-arm", round: 1 },
  { sellerId: "ai_call_2", buyerId: "ai_call_buyer_2", mode: "sibling", round: 2 },
  { sellerId: "ai_call_3", buyerId: "ai_call_buyer_3", mode: "sibling", round: 3 }
];

/** The guard that splits a sibling pair. */
export const BUYER_WHEN = { var: "lead_type", equals: "buyer" } as const;
export const NOT_BUYER_WHEN = { var: "lead_type", notEquals: "buyer" } as const;

type AnyStep = Record<string, unknown> & { id?: unknown; type?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;
type Ref = { id: string; label: string; source: string };

/** How the buyer call opens on each rung, matching the seller ladder's arc. */
function opener(round: 1 | 2 | 3): string {
  if (round === 1) {
    return 'Open with: "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about your home search through Clever. Is now a good time?"';
  }
  if (round === 2) {
    return 'Open with: "Hi {{vars.lead_name.first}}, the Amy Laidlaw Team with HomeSmart again, about your home search through Clever. Is now a better time?"';
  }
  return 'Open with: "Hi {{vars.lead_name.first}}, the Amy Laidlaw Team with HomeSmart, one last try about your home search through Clever." If they are not interested, thank them warmly and say we will stop calling.';
}

/**
 * The buyer call for one rung.
 *
 * The body is ReferralExchange's `ai_call_buyer` persona, which is the copy
 * Amy pointed at, with two Clever-specific changes: the source is named
 * outright (Clever has no `web_source` var), and the budget and search area
 * are declared as already-known so the AI cannot open by asking a buyer for
 * facts the referral already gave.
 */
export function buyerCallStep(
  rung: (typeof CALL_RUNGS)[number],
  seller: AnyStep,
  refs: readonly Ref[]
): AnyStep {
  const reach = (seller.reachTeammate ?? {}) as Record<string, unknown>;
  return {
    id: rung.buyerId,
    type: "place_ai_call",
    toVar: "lead_phone",
    // The SAME var the seller rungs save to, on purpose: every branch after
    // the call (the retry ladder, the promote-on-transfer path, the AI-owned
    // tagging) reads call_outcome, and a buyer must travel those too.
    saveAs: "call_outcome",
    // Round 1 inherits the seller's price guard; rounds 2 and 3 are split from
    // their sibling by lead_type instead, since neither carries a `when` today.
    when: rung.mode === "fill-arm" ? (seller.when as Record<string, unknown>) : { ...BUYER_WHEN },
    ...(seller.callWindow ? { callWindow: seller.callWindow } : {}),
    ...(seller.waitMinutes !== undefined ? { waitMinutes: seller.waitMinutes } : {}),
    // Where the call summary goes. The seller rungs send it to whoever the AI
    // rang first, which is the promise the team offer makes ("Whoever the AI
    // rang first has the full call summary"), and the schema refuses a call
    // with no summary target at all.
    ...(seller.notifyFirstReachTarget ? { notifyFirstReachTarget: true } : {}),
    ...(seller.notifyOwner ? { notifyOwner: true } : {}),
    reachTeammate: {
      ...reach,
      refs,
      preSmsTemplate:
        "LIVE TRANSFER incoming, pick up!\nBuyer {{vars.lead_name}} ({{vars.lead_phone}}) from " +
        "Clever, looking around {{vars.lead_address}} at about {{vars.price}}.\nThey are on the line now."
    },
    contextTemplate:
      "You already know all of this. NEVER ask for any of it:\n" +
      "- Their name: {{vars.lead_name}}\n" +
      "- Their phone: {{vars.lead_phone}} (you are calling it right now, never ask for it)\n" +
      "- Where they are looking: {{vars.lead_address}}\n" +
      "- Their budget: {{vars.price}}",
    personaTemplate:
      "You are calling for the Amy Laidlaw Team at HomeSmart, a real estate team in the Phoenix " +
      "area. This lead is a BUYER: they are shopping for a home, they are not selling one, so " +
      "never pitch a listing, a valuation, or a cash offer.\n\n" +
      `${opener(rung.round)}\n\n` +
      "Find out what they are looking for: area, bedrooms, and how soon they want to move. Their " +
      "budget and search area are already on file, so confirm them at most and never ask for " +
      "them cold.\n\n" +
      "If they are serious and want to speak to someone now, use the reach tool to connect them " +
      "to a teammate. If nobody picks up, apologize honestly, say a member of the team will call " +
      "them shortly, and ONLY THEN ask what time of day suits them best for that callback and " +
      "record it. Do not ask about timing at any other point in the call.\n\n" +
      "Never quote a price or a valuation."
  };
}

/** Every step in a raw definition, plus the array it lives in. */
function locate(
  steps: unknown,
  id: string
): { list: AnyStep[]; index: number } | null {
  if (!Array.isArray(steps)) return null;
  const list = steps as AnyStep[];
  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    if (!step || typeof step !== "object") continue;
    if (step.id === id) return { list, index: i };
    for (const key of ["steps", "else"]) {
      const hit = locate(step[key], id);
      if (hit) return hit;
    }
    if (Array.isArray(step.branches)) {
      for (const b of step.branches) {
        if (b && typeof b === "object") {
          const hit = locate((b as Record<string, unknown>).steps, id);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

/** The buyer arm of a type gate, by convention the first (and only) arm. */
function buyerArm(gate: AnyStep): { steps: AnyStep[] } | null {
  const arms = gate.branches;
  if (!Array.isArray(arms) || arms.length === 0) return null;
  const arm = arms[0] as Record<string, unknown>;
  if (!Array.isArray(arm.steps)) return null;
  return arm as { steps: AnyStep[] };
}

/** Has this definition already been patched? */
export function alreadyPatched(def: AnyDef): boolean {
  const ids = walkSteps(def.steps).map((s) => s.id);
  return CALL_RUNGS.every((r) => ids.includes(r.buyerId));
}

/**
 * Part 1: give every call rung a buyer variant.
 *
 * Returns `problems` instead of throwing so the caller can decline to write
 * at all; a half-laddered flow would call a buyer with a listing pitch on the
 * rungs that were missed, which is the exact failure being fixed.
 */
export function patchBuyerCalls(def: AnyDef, refs: readonly Ref[]): { changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  for (const rung of CALL_RUNGS) {
    if (walkSteps(def.steps).some((s) => s.id === rung.buyerId)) continue;
    const found = locate(def.steps, rung.sellerId);
    if (!found) {
      problems.push(`"${rung.sellerId}" is missing from the flow`);
      continue;
    }
    const seller = found.list[found.index];
    const buyer = buyerCallStep(rung, seller, refs);

    if (rung.mode === "fill-arm") {
      // Round 1: the gate exists with an empty buyer arm; fill it.
      const gateAt = locate(def.steps, CALL_GATE_STEP_ID);
      const gate = gateAt ? gateAt.list[gateAt.index] : null;
      const arm = gate ? buyerArm(gate) : null;
      if (!arm) {
        problems.push(
          `"${CALL_GATE_STEP_ID}" is missing or has no buyer arm; run amy-clever-lead-type.ts first`
        );
        continue;
      }
      if (arm.steps.length > 0) {
        problems.push(`"${CALL_GATE_STEP_ID}" buyer arm already holds steps, so it was not filled`);
        continue;
      }
      arm.steps.push(buyer);
      changed.push(`${CALL_GATE_STEP_ID}: buyer arm now places ${rung.buyerId}`);
      continue;
    }

    // Rounds 2 and 3: a gated SIBLING, because the retry ladder is already as
    // deeply nested as the schema allows.
    if (seller.when !== undefined) {
      problems.push(
        `"${rung.sellerId}" already carries a \`when\`; splitting it by lead_type would displace that guard`
      );
      continue;
    }
    seller.when = { ...NOT_BUYER_WHEN };
    found.list.splice(found.index + 1, 0, buyer);
    changed.push(`${rung.sellerId}: now seller-only, with ${rung.buyerId} beside it for buyers`);
  }
  return { changed, problems };
}

/** Undo part 1: empty the round-1 arm, drop the sibling rungs and their guards. */
export function revertBuyerCalls(def: AnyDef): string[] {
  const changed: string[] = [];
  for (const rung of [...CALL_RUNGS].reverse()) {
    if (rung.mode === "fill-arm") {
      const gateAt = locate(def.steps, CALL_GATE_STEP_ID);
      const arm = gateAt ? buyerArm(gateAt.list[gateAt.index]) : null;
      if (arm && arm.steps.some((s) => s.id === rung.buyerId)) {
        arm.steps.length = 0;
        changed.push(`${CALL_GATE_STEP_ID}: buyer arm emptied`);
      }
      continue;
    }
    const buyerAt = locate(def.steps, rung.buyerId);
    if (buyerAt) buyerAt.list.splice(buyerAt.index, 1);
    const sellerAt = locate(def.steps, rung.sellerId);
    if (sellerAt) {
      const seller = sellerAt.list[sellerAt.index];
      if (JSON.stringify(seller.when) === JSON.stringify(NOT_BUYER_WHEN)) delete seller.when;
    }
    if (buyerAt) changed.push(`${rung.buyerId}: removed, ${rung.sellerId} serves both again`);
  }
  return changed;
}

/**
 * Part 2: set a buyer call's live-transfer ladder outright.
 *
 * A SET rather than an append, forced by the cap: the ReferralExchange buyer
 * ladder is already full at three, so Jason can only join by someone leaving.
 * Returns [] when the step or its ladder is absent, and when the ladder
 * already reads exactly this, which is what makes a re-run a no-op.
 */
export function setReach(def: AnyDef, stepId: string, refs: readonly Ref[]): string[] {
  const found = locate(def.steps, stepId);
  if (!found) return [];
  const step = found.list[found.index];
  const reach = step.reachTeammate as Record<string, unknown> | undefined;
  if (!reach || !Array.isArray(reach.refs)) return [];
  const before = (reach.refs as Ref[]).map((r) => r?.label).join(", ");
  const after = refs.map((r) => r.label).join(", ");
  if (before === after) return [];
  reach.refs = refs.map((r) => ({ ...r }));
  return [`${stepId}: live transfer ${before} -> ${after}`];
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
  /**
   * The ReferralExchange half is opt-IN, and that asymmetry is deliberate.
   * On Clever the buyer ladder is NEW, so choosing Dave / Gabrielle / Jason
   * takes nothing from anybody. On ReferralExchange the ladder already exists
   * and is full, so seating Jason means unseating Amy on a live path that has
   * carried 119 runs. Removing the owner from her own busiest live transfer
   * should be a decision somebody typed, not a side effect of a script that
   * was run for Clever.
   */
  const WITH_REFERRAL = process.argv.includes("--with-referral");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-clever-buyer-ai-call.ts --business <uuid> [--apply] [--revert] [--force]"
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

  // Resolve the ladder from the LIVE roster rather than hardcoding ids: a ref
  // naming a member the engine cannot resolve would silently drop that rung.
  const { data: roster } = await db
    .from("ai_flow_team_members")
    .select("id,name,active")
    .eq("business_id", BUSINESS_ID)
    .eq("active", true);
  const refFor = (name: string): Ref => {
    const hit = (roster ?? []).filter(
      (m) => String(m.name ?? "").trim().toLowerCase() === name.toLowerCase()
    );
    if (hit.length !== 1) {
      console.error(
        `expected exactly one ACTIVE roster member named "${name}", found ${hit.length}. Roster: ${(roster ?? []).map((m) => m.name).join(", ")}`
      );
      process.exit(2);
    }
    return { id: hit[0].id as string, label: hit[0].name as string, source: "employee" };
  };
  const buyerRefs = (REVERT ? REFERRAL_BUYER_REACH_PREVIOUS : BUYER_REACH_NAMES).map(refFor);
  if (buyerRefs.length > MAX_REACH_REFS) {
    console.error(`the transfer ladder holds at most ${MAX_REACH_REFS} teammates.`);
    process.exit(2);
  }

  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .is("deleted_at", null)
    .in("name", [CLEVER_FLOW_NAME, REFERRAL_FLOW_NAME]);
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  const clever = (rows ?? []).find((r) => r.name === CLEVER_FLOW_NAME);
  const referral = (rows ?? []).find((r) => r.name === REFERRAL_FLOW_NAME);
  if (!clever) {
    console.error(`"${CLEVER_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  const { data: live } = await db
    .from("ai_flow_runs")
    .select("id,status,flow_id")
    .in("flow_id", [clever.id, ...(referral ? [referral.id] : [])])
    .not("status", "in", '("done","failed","canceled")');
  if ((live ?? []).length > 0 && !FORCE) {
    console.error(`${(live ?? []).length} run(s) still in flight on these flows:`);
    for (const r of live ?? []) console.error(`  ${r.id} (${r.status})`);
    console.error("Re-run with --force to patch anyway (resume is by step id, and no id is removed).");
    process.exit(2);
  }

  const targets: Array<{ id: string; name: string; next: AnyDef; changed: string[] }> = [];

  // Clever: the buyer ladder, plus Jason on each new buyer rung (already in
  // buyerCallStep's refs) .
  {
    const next = JSON.parse(JSON.stringify(clever.definition)) as AnyDef;
    let changed: string[];
    if (REVERT) {
      changed = revertBuyerCalls(next);
    } else {
      const out = patchBuyerCalls(next, buyerRefs);
      if (out.problems.length > 0) {
        console.error(`\n"${CLEVER_FLOW_NAME}" is not the shape this expects, so nothing was written:`);
        for (const p of out.problems) console.error(`  - ${p}`);
        process.exit(2);
      }
      changed = out.changed;
    }
    if (changed.length > 0) targets.push({ id: clever.id, name: clever.name, next, changed });
  }

  // ReferralExchange: Jason on the existing buyer call, nothing else.
  if (referral && WITH_REFERRAL) {
    const next = JSON.parse(JSON.stringify(referral.definition)) as AnyDef;
    // On revert this restores Dave / Gabrielle / Amy, the ladder as it was.
    const changed = setReach(next, REFERRAL_BUYER_CALL_ID, buyerRefs);
    if (changed.length > 0) targets.push({ id: referral.id, name: referral.name, next, changed });
  }

  if (!WITH_REFERRAL) {
    console.log(
      `note: "${REFERRAL_FLOW_NAME}" is untouched. Its buyer transfer ladder is full at ` +
        `${MAX_REACH_REFS}, so adding Jason there means removing Amy. Pass --with-referral to do that.`
    );
  }

  if (targets.length === 0) {
    console.log(REVERT ? "Nothing to revert." : "Already patched, no changes.");
    process.exit(0);
  }

  for (const t of targets) {
    console.log(`\n=== ${t.name} (id=${t.id}) ===`);
    for (const c of t.changed) console.log(`  - ${c}`);
    try {
      const validated = parseAiFlowDefinition(t.next);
      console.log(`  after: ${summarizeDefinition(validated)}`);
      t.next = validated as unknown as AnyDef;
    } catch (e) {
      console.error(`\n"${t.name}" would not validate after patching: ${String(e)}`);
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const patched: string[] = [];
  for (const t of targets) {
    const { data: updated, error: upErr } = await db
      .from("ai_flows")
      .update({ definition: t.next })
      .eq("id", t.id)
      .eq("business_id", BUSINESS_ID)
      .select("id");
    if (upErr) {
      console.error(`update "${t.name}" failed: ${upErr.message}`);
      process.exit(1);
    }
    if ((updated ?? []).length !== 1) {
      console.error(`update "${t.name}" matched ${(updated ?? []).length} rows; NOT written.`);
      process.exit(1);
    }
    patched.push(t.id);
    console.log(`Updated "${t.name}".`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-buyer-ai-call.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patched, reverted: REVERT }
  });
  console.log(
    REVERT
      ? "\nReverted. A Clever buyer gets no AI call again, and the buyer transfer ladder is Dave, Gabrielle and Amy."
      : "\nDone. A Clever buyer gets the same three-rung call ladder as a seller, in buyer words, and every buyer live transfer rings Dave, Gabrielle and Jason."
  );
}

/* c8 ignore stop */
