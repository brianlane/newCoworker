#!/usr/bin/env tsx
/**
 * One-shot: make every lead email to amy@amylaidlaw.com say who owns the lead.
 *
 * Amy, 2026-08-12: "update the email to amy@amylaidlaw.com for any aiflow that
 * doesn't include who claimed the lead to now show who owns the lead in the
 * email. This may mean the aiflow needs to be reordered to allow for this."
 *
 * FIVE EMAILS LACKED IT, and all five sat BEFORE their flow's route_to_team
 * step, which is why the reorder Amy anticipated is genuinely required: the
 * claimer is not known until the offer resolves, so no template could have
 * shown it from where those steps stood.
 *
 *   Clever Lead - Accept    qt_email
 *   Realtor.com Lead        s2
 *   ReferralExchange Lead   email_buyer / email_seller / email_both
 *
 * HOMELIGHT IS THE MODEL, not an exception: its `qt_email` already sits after
 * the route and already opens "HomeLight referral claimed by ...". The other
 * four simply never caught up. This moves them to the same place.
 *
 * WHAT CHANGES FOR AMY, stated plainly because it is a real cost: these emails
 * now wait for the claim window instead of sending on arrival. A lead claimed
 * quickly (the common case, and the point of speed-to-lead) delays the email by
 * a minute or two. A lead NOBODY claims delays it by the full ladder, roughly
 * ninety minutes on these flows (10 minute offer, three 20 minute reminder
 * rounds, then the owner fallback).
 *
 * DELIBERATELY NOT COPIED FROM HOMELIGHT: its qt_email is gated on
 * `claimed_agent notEquals none`, so an unclaimed HomeLight lead sends Amy no
 * QT email at all. These stay ungated. A lead nobody claimed is the one Amy
 * most needs to see, and the owner line says "none" rather than the mail
 * silently not arriving.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-owner-in-lead-emails.ts          # dry run
 *   npx tsx scripts/oneshot/amy-owner-in-lead-emails.ts --apply
 *   npx tsx scripts/oneshot/amy-owner-in-lead-emails.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-owner-in-lead-emails.ts";

/**
 * The line added to each email.
 *
 * `claimed_agent` is the teammate who took this lead's offer, and a claim
 * auto-assigns the contact's owner, so it IS the owner for this lead. It reads
 * "none" when the offer ran and nobody claimed, which is the honest answer and
 * the reason these emails are not gated on a claim having happened.
 *
 * The label explains its own blank, because there is one path where the var is
 * not merely "none" but UNSET: a goal jump from the AI call skips the route
 * entirely (see the anchor note below), and send_email renders with plain
 * renderTemplate and no collapseEmpty, so an unset var leaves a dangling label.
 * That is the bare-"Price:" trap this account has hit twice; saying what a
 * blank means costs a few words and removes it.
 */
export const OWNER_LINE =
  "Lead owner (blank if nobody has claimed it yet): {{vars.claimed_agent}}";

/** Which email steps move, per flow. All are top level in the live definitions. */
export const MOVE_PLAN: Record<string, string[]> = {
  "Clever Lead - Accept": ["qt_email"],
  "Realtor.com Lead": ["s2"],
  "ReferralExchange Lead": ["email_buyer", "email_seller", "email_both"]
};

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] };

/** Append the owner line unless it is already there. */
export function withOwnerLine(body: string): string {
  return body.includes(OWNER_LINE) ? body : `${body}\n${OWNER_LINE}`;
}

export type PatchResult = { changed: boolean; touched: string[]; movedAfter: string };

/**
 * Move the named email steps to sit immediately after the flow's LAST
 * top-level route_to_team step, and add the owner line to each.
 *
 * The last route rather than the first: ReferralExchange has three, gated by
 * lead type, and only one fires. Placing the emails after all of them is the
 * only position from which the claim is known whichever arm ran.
 *
 * Throws rather than guessing when a step is missing or is not where this
 * expects it: a moved step id means the live flow changed shape, and shuffling
 * a definition we no longer recognize is the wrong response to that.
 */
export function moveEmailsAfterRoute(flowName: string, def: Definition): PatchResult {
  const ids = MOVE_PLAN[flowName];
  if (!ids) throw new Error(`no move plan for flow "${flowName}"`);
  const steps = def.steps ?? [];
  const touched: string[] = [];

  for (const id of ids) {
    const at = steps.findIndex((s) => s.id === id);
    if (at < 0) throw new Error(`${flowName}: step "${id}" is missing or not top level`);
    if (steps[at]!.type !== "send_email") {
      throw new Error(`${flowName}: step "${id}" is a ${String(steps[at]!.type)}, not an email`);
    }
  }
  const lastRoute = steps.map((s) => s.type).lastIndexOf("route_to_team");
  if (lastRoute < 0) {
    throw new Error(`${flowName}: no top-level route_to_team; nothing to order against`);
  }
  /**
   * Anchor AFTER a top-level goal when the flow has one, not merely after the
   * route.
   *
   * Clever's ladder parks in `ai_call_1` BEFORE the route, and its
   * `lead_reached` goal (replied / appointment_booked) sits after it. A lead
   * who replies or books DURING that call jumps the run straight to the goal
   * and skips every step in between. Anchoring on the route would therefore
   * have put the email in the skipped span, so Amy would have received no QT
   * mail for exactly the leads who engaged: the best ones, silently
   * (Bugbot, #1319).
   *
   * A goal step is a jump TARGET, so steps after it run on both paths: the
   * normal one where the route already resolved the claim, and the jump where
   * it never ran and the owner is legitimately blank.
   */
  const lastGoal = steps.map((s) => s.type).lastIndexOf("goal");
  const anchor = Math.max(lastRoute, lastGoal);
  const anchorId = String(steps[anchor]!.id);

  // Add the line first, so a re-run that has nothing left to move still
  // reports honestly on the bodies.
  for (const id of ids) {
    const step = steps.find((s) => s.id === id)!;
    const body = step.body;
    if (typeof body !== "string") throw new Error(`${flowName}: step "${id}" has no body`);
    const next = withOwnerLine(body);
    if (next !== body) {
      step.body = next;
      touched.push(`${id}.body`);
    }
  }

  // Already after the route? Then only the bodies needed touching.
  const needMove = ids.filter((id) => steps.findIndex((s) => s.id === id) < anchor);
  if (needMove.length > 0) {
    const moving = needMove.map((id) => steps.splice(steps.findIndex((s) => s.id === id), 1)[0]!);
    // Recompute: the splices above shifted everything after them.
    const route2 = steps.map((s) => s.type).lastIndexOf("route_to_team");
    const goal2 = steps.map((s) => s.type).lastIndexOf("goal");
    steps.splice(Math.max(route2, goal2) + 1, 0, ...moving);
    for (const id of needMove) touched.push(`${id} moved after ${anchorId}`);
  }
  def.steps = steps;
  return { changed: touched.length > 0, touched, movedAfter: anchorId };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
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
    const { data, error } = await db
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
    for (const row of (data ?? []) as Array<{ details: Record<string, unknown> | null }>) {
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

  const names = Object.keys(MOVE_PLAN);
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
      result = moveEmailsAfterRoute(row.name, def);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: already names the owner and sits after the claim.`);
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
