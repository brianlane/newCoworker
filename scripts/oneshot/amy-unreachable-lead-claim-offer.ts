#!/usr/bin/env tsx
/**
 * One-shot: the "we cannot contact this lead" guard becomes a real CLAIM
 * OFFER, so a teammate can take the lead by texting back "1".
 *
 * `amy-unreachable-lead-team-alert.ts` put a guard on all four arrival flows:
 * a lead arriving with no phone alerts the lead-type-tagged team instead of
 * vanishing. It was an ALERT, deliberately, because an alert has no deadline
 * and nothing waits on it.
 *
 * Then a teammate replied "1" to one (Gabrielle Mota, 2026-08-15, 57 seconds
 * after the alert landed). She was not confused: every other team text on this
 * account ends in "Reply 1 to claim", so "1" is muscle memory. The claim
 * machinery only understands parked offer runs, so her "1" resolved against an
 * unrelated older offer and the lead she had just been told about stayed
 * unowned.
 *
 * Brian's call: allow both. This converts the guard's alert into a
 * `route_to_team` broadcast offer, which brings the whole claim machinery with
 * it: "1" claims, "2" passes, "86" releases, first-to-claim wins, the other
 * teammates get "somebody took it", and the owner hears the outcome. The
 * dashboard claim keeps working exactly as before.
 *
 * The offer is narrowed with `teamTagTemplate`, the tag filter added to
 * `route_to_team` in the same PR. Without it this conversion would have cost
 * the seller/buyer targeting: `broadcastAll` offers the whole roster and had
 * no way to express "sellers go to the people who cover sellers".
 *
 * Two things this deliberately does NOT try to do:
 *
 *  - It cannot stamp `contacts.owner_employee_id` on claim. Ownership is keyed
 *    on the lead's phone and this guard exists precisely because there is no
 *    phone, so there is no contact row to own yet. `claimed_agent` is still
 *    set, the claimer is still told the lead is theirs, and the downstream
 *    `*_team_unclaimed` takeover correctly reads the lead as claimed.
 *  - It does not touch the owner-addressed `notify_no_phone` steps on
 *    ReferralExchange and New Lead Intake. Same reason as before: those page
 *    Amy, and removing them would take away a notice she gets today.
 *
 * Read-modify-write against the LIVE definition, validated through
 * parseAiFlowDefinition, idempotent, dry-run by default, `--revert` restores
 * the exact previous definitions from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-unreachable-lead-claim-offer.ts              # dry run
 *   npx tsx scripts/oneshot/amy-unreachable-lead-claim-offer.ts --apply
 *   npx tsx scripts/oneshot/amy-unreachable-lead-claim-offer.ts --only "Clever Lead - Accept"
 *   npx tsx scripts/oneshot/amy-unreachable-lead-claim-offer.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStepDeep, type Definition } from "./amy-under-500k-ai-owned";
import { PLANS } from "./amy-unreachable-lead-team-alert";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-unreachable-lead-claim-offer.ts";

/** Amy's standard quiet window, matching every other offer on the account. */
const OFFER_WINDOW = {
  timezone: "America/Phoenix",
  quietStart: "21:00",
  quietEnd: "08:30",
  graceMinutes: 10
};

type Plan = (typeof PLANS)[number];

/**
 * The offer copy.
 *
 * It leads with the fact that there is no phone, because that is the whole
 * reason a human is needed and it changes what the teammate does next: they
 * have to open the referral or email rather than dial.
 */
export function offerTemplate(plan: Plan): string {
  return [
    `A ${plan.source} lead arrived with NO phone number, so the AI cannot text`,
    "or call them. Somebody has to work this one by hand.",
    ...plan.details,
    "",
    `Reply 1 to claim or 2 to pass by {{offer.deadline}}.`,
    'Passing? Reply "2, <reason>" to say why (e.g. "2, out of town").',
    "First to reply 1 gets it."
  ].join("\n");
}

export function claimedTemplate(plan: Plan): string {
  return [
    `{{agent.name}} took the unreachable ${plan.source} lead.`,
    ...plan.details,
    "They have no phone on file, so this one needs a manual reach out."
  ].join("\n");
}

export function ownerFallbackTemplate(plan: Plan): string {
  return [
    `NOBODY claimed the unreachable ${plan.source} lead, so it is back with you.`,
    ...plan.details,
    "There is no phone on file, so the AI never contacted them at all."
  ].join("\n");
}

/** The offer that replaces the alert inside the guard's else arm. */
export function claimOffer(plan: Plan): Record<string, unknown> {
  return {
    id: `${plan.prefix}_no_phone_offer`,
    type: "route_to_team",
    broadcastAll: true,
    teamTagTemplate: plan.teamTag,
    offerTemplate: offerTemplate(plan),
    responseMinutes: 10,
    offerWindow: OFFER_WINDOW,
    claimedNotifyTemplate: claimedTemplate(plan),
    ownerFallbackTemplate: ownerFallbackTemplate(plan),
    unclaimedReminders: {
      rounds: 2,
      intervalMinutes: 20,
      detailsTemplate: plan.details.join("\n")
    }
  };
}

/**
 * Deep-equality that ignores key ORDER.
 *
 * Postgres `jsonb` does not preserve the key order it was written with (it
 * orders by key length then bytewise), so a definition read back from the
 * database never matches a freshly built object under `JSON.stringify`, and
 * the convergence check reported "offer refreshed" on every single run. Found
 * by re-running against the live flows, which is the only place the round trip
 * happens.
 */
export function sameShape(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // An array and a plain object are never the same shape, even when both are
  // empty: without this, `{}` and `[]` both present zero keys below and
  // compare equal.
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameShape(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    return (
      ak.length === bk.length &&
      ak.every((k, i) => k === bk[i]) &&
      ak.every((k) => sameShape(ao[k], bo[k]))
    );
  }
  return false;
}

export type PatchResult = { changed: boolean; notes: string[] };

export function patchFlow(def: Definition, plan: Plan): PatchResult {
  const notes: string[] = [];
  const guard = findStepDeep(def.steps, `${plan.prefix}_no_phone_guard`) as
    | { else?: Array<Record<string, unknown>> }
    | undefined;
  if (!guard) {
    throw new Error(
      `${plan.flow}: no ${plan.prefix}_no_phone_guard on the live flow; run amy-unreachable-lead-team-alert.ts first`
    );
  }
  const arm = guard.else ?? [];
  const at = arm.findIndex((s) => s.id === `${plan.prefix}_no_phone_team`);
  if (at < 0) {
    // Already converted (the alert step is gone). Converge the copy so a
    // re-run fixes a stale template rather than stopping at the step id.
    const offerAt = arm.findIndex((s) => s.id === `${plan.prefix}_no_phone_offer`);
    if (offerAt < 0) {
      throw new Error(`${plan.flow}: guard's else arm has neither the alert nor the offer`);
    }
    const want = claimOffer(plan);
    if (!sameShape(arm[offerAt], want)) {
      arm[offerAt] = want;
      notes.push(`${plan.prefix}_no_phone_offer: offer refreshed`);
    }
    return { changed: notes.length > 0, notes };
  }
  arm[at] = claimOffer(plan);
  guard.else = arm;
  notes.push(
    `${plan.prefix}_no_phone_team -> ${plan.prefix}_no_phone_offer: alert becomes a claim offer to the ${plan.teamTag} team`
  );
  return { changed: true, notes };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const bi = process.argv.indexOf("--business-id");
  const businessId = bi >= 0 ? (process.argv[bi + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const oi = process.argv.indexOf("--only");
  const only = oi >= 0 ? (process.argv[oi + 1] ?? null) : null;
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
    const newest = (rows ?? [])
      .map((r) => (r as { details: Record<string, unknown> | null }).details)
      .find((d) => d && d.reverted !== true && d.previous);
    if (!newest) {
      console.error("No applied ledger rows with a previous definition to revert to.");
      process.exit(2);
    }
    const previous = newest.previous as Array<{ flow_id: string; flow: string; definition: unknown }>;
    for (const p of previous) {
      if (only && p.flow !== only) continue;
      console.log(`revert ${p.flow} (${p.flow_id})`);
      if (!apply) continue;
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: p.definition })
        .eq("id", p.flow_id)
        .eq("business_id", businessId);
      if (upErr) {
        console.error(`Revert failed for ${p.flow}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> reverted.");
    }
    if (apply) {
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? SCRIPT,
        businessId,
        details: { reverted: true, flows: previous.map((p) => p.flow) }
      });
    } else {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    }
    return;
  }

  const plans = only ? PLANS.filter((p) => p.flow === only) : PLANS;
  if (plans.length === 0) {
    console.error(`--only "${only}" matches none of: ${PLANS.map((p) => p.flow).join(", ")}`);
    process.exit(2);
  }

  const previous: Array<{ flow_id: string; flow: string; definition: unknown }> = [];
  const patched: Array<{ id: string; flow: string; def: Definition; notes: string[] }> = [];
  for (const plan of plans) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id,name,definition")
      .eq("business_id", businessId)
      .eq("name", plan.flow)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for ${plan.flow}: ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`Flow not found on ${businessId}: ${plan.flow}`);
      process.exit(2);
    }
    const row = data as { id: string; name: string; definition: Definition };
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let res: PatchResult;
    try {
      res = patchFlow(def, plan);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!res.changed) {
      console.log(`${plan.flow}: already a claim offer, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      if (e instanceof AiFlowValidationError) {
        console.error(`${plan.flow}: patched definition INVALID, refusing to write:`);
        for (const issue of e.issues) console.error(`  - ${issue}`);
        process.exit(2);
      }
      throw e;
    }
    console.log(`${plan.flow}:`);
    for (const n of res.notes) console.log(`  ${n}`);
    previous.push({ flow_id: row.id, flow: plan.flow, definition: row.definition });
    patched.push({ id: row.id, flow: plan.flow, def, notes: res.notes });
  }

  if (patched.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!apply) {
    console.log(`\n[dry-run] Would patch ${patched.length} flow(s). Re-run with --apply.`);
    return;
  }
  for (const p of patched) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: p.def })
      .eq("id", p.id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Write failed for ${p.flow}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  -> updated ${p.flow}.`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: { flows: patched.map((p) => p.flow), notes: patched.flatMap((p) => p.notes), previous }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
