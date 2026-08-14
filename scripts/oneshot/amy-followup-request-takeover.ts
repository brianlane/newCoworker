#!/usr/bin/env tsx
/**
 * One-shot: an unclaimed follow-up REQUEST becomes AI-owned too.
 *
 * Brian, 2026-08-14: "Yes extend it to the Follow Up Requested flow too."
 *
 * "Follow Up Requested (Unclaimed Leads)" offers a teammate-requested,
 * same-day follow-up to the team. When nobody claimed, it ended at "The
 * follow-up is back with you" and the request died: the exact dead-end
 * `amy-team-unclaimed-ai-followup.ts` closed on the four arrival flows.
 * Same treatment here: two hours after the flow ends, still unclaimed and
 * not a proven $1M+ lead, the AI tags the lead into the Needs Follow Up
 * cadence. The tag is PLAIN, because the lead asked for a follow-up TODAY
 * and the cadence's immediate round-1 call IS that follow-up.
 *
 * Differences from the arrival flows, all deliberate:
 *  - The seller variant matches `route_lead_type notEquals "buyer"`,
 *    mirroring this flow's own seller route (it sends everything non-buyer
 *    through Dave and Gabby). Buyers stay untouched.
 *  - This flow has no `price_gate` var; the takeover branch's
 *    `when price_gate != "ai"` passes on the missing var, which is correct:
 *    there IS no AI-owned arrival path here to double-tag.
 *  - The $1M+ exclusion needs a band this flow never had, so the reader
 *    gains `price_digits` and a `less_than` math step computes
 *    `price_under_1m`, same as `amy-deterministic-price-band.ts` does on
 *    the arrival flows. Only a PROVEN $1M+ is excluded; a request with no
 *    price is covered.
 *
 * Read-modify-write against the LIVE definition, validated through
 * parseAiFlowDefinition, idempotent, dry-run by default, `--revert`
 * restores from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-followup-request-takeover.ts            # dry run
 *   npx tsx scripts/oneshot/amy-followup-request-takeover.ts --apply
 *   npx tsx scripts/oneshot/amy-followup-request-takeover.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStepDeep, type Definition } from "./amy-under-500k-ai-owned";
import {
  FALLBACK_TAKEOVER_LINE,
  appendFallbackLine,
  takeoverTag,
  teamUnclaimedBranch,
  type TakeoverVariant
} from "./amy-team-unclaimed-ai-followup";
import { addComputedBand } from "./amy-deterministic-price-band";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-followup-request-takeover.ts";
const FLOW_NAME = "Follow Up Requested (Unclaimed Leads)";

export type PatchResult = { changed: boolean; notes: string[] };

export function patchFollowUpRequested(def: Definition): PatchResult {
  const notes = addComputedBand(def, "read_request", "fur_price_lt_1m");
  if (!findStepDeep(def.steps, "fur_team_unclaimed")) {
    const variants: TakeoverVariant[] = [
      {
        suffix: "_s",
        // Mirrors this flow's own seller route: everything non-buyer.
        condition: { var: "route_lead_type", notEquals: "buyer" },
        label: "Not a buyer: the seller route's audience",
        tagSteps: [takeoverTag("fur_tu_tag", false)]
      }
    ];
    (def.steps ?? []).push(teamUnclaimedBranch("fur", variants, { gateOnPriceGate: false }));
    notes.push("fur_team_unclaimed: unclaimed follow-up requests join the cadence");
  }
  if (appendFallbackLine(def, ["route_seller"], notes)) {
    // note already pushed by appendFallbackLine
  }
  return { changed: notes.length > 0, notes };
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
    const newest = (rows ?? [])
      .map((r) => (r as { details: Record<string, unknown> | null }).details)
      .find((d) => d && d.reverted !== true && d.previous_definition);
    if (!newest) {
      console.error("No applied ledger rows with a previous_definition to revert to.");
      process.exit(2);
    }
    console.log(`revert ${FLOW_NAME} (${newest.flow_id})`);
    if (apply) {
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
    } else {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    }
    return;
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
    console.error(`Flow not found on ${businessId}: ${FLOW_NAME}`);
    process.exit(2);
  }
  const row = data as { id: string; name: string; definition: Definition };
  const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
  const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
  let res: PatchResult;
  try {
    res = patchFollowUpRequested(def);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (!res.changed) {
    console.log(`${row.name}: already correct, nothing to do.`);
    return;
  }
  try {
    parseAiFlowDefinition(def);
  } catch (e) {
    if (e instanceof AiFlowValidationError) {
      console.error(`${row.name}: patched definition INVALID, refusing to write:`);
      for (const issue of e.issues) console.error(`  - ${issue}`);
      process.exit(2);
    }
    throw e;
  }
  console.log(`${row.name}:`);
  for (const note of res.notes) console.log(`  ${note}`);
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: def })
    .eq("id", row.id)
    .eq("business_id", businessId);
  if (upErr) {
    console.error(`Write failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flow_id: row.id,
      flow_name: row.name,
      notes: res.notes,
      previous_definition: previous
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
