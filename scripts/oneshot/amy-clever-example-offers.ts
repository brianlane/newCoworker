#!/usr/bin/env tsx
/**
 * One-shot: stop quoting Clever's "Example only" cash-offer placeholders.
 *
 * Call 5339954d (2026-09-06) and call 60a64ddd (2026-08-20) both had the AI
 * say "the offers on your file are 375k and 395k". PR #1726 treated that as
 * the model inventing a figure. It was not.
 * The pitch template interpolated `{{vars.cash_offers}}`, and the
 * `browse_extract` that fills that var copied Clever's EXAMPLE ONLY
 * comparison module (ZoomCasa $375k, QuickBuy $395k, labeled "placeholders
 * and are not based on this property"). Real offers arrive later by text.
 * Measured: 21 of 93 page reads since Aug 7 2026 returned those samples.
 *
 * Two edits, both string-in-place, no step added or removed, so parked runs
 * keep their `current_step`:
 *
 *   1. The spoken pitch on Clever Lead - Accept drops the interpolated
 *      amounts and tells the model not to quote a cash-offer dollar figure.
 *   2. The `cash_offers` extraction description on that flow AND on
 *      "Clever - Spoke Check & Weekly Call Follow-Up" names the example
 *      module and answers 'none listed' for it, so team texts stop carrying
 *      fake numbers.
 *
 * Dry-run by default; `--apply` writes. Idempotent. Ledger-recorded.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-clever-example-offers.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-example-offers.ts --business <uuid> --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  CASH_OFFERS_FIELD,
  rewriteCleverPitchPersona
} from "./amy-seller-ai-call-definition";

export const CLEVER_ACCEPT_FLOW_NAME = "Clever Lead - Accept";
export const SPOKE_CHECK_FLOW_NAME = "Clever - Spoke Check & Weekly Call Follow-Up";

export const TARGET_FLOW_NAMES = [CLEVER_ACCEPT_FLOW_NAME, SPOKE_CHECK_FLOW_NAME] as const;

export type AnyStep = Record<string, unknown> & { id?: string; type?: string };
export type AnyDef = { steps?: AnyStep[] } & Record<string, unknown>;

/** Walk trunk, branch arms, and else. */
export function walkSteps(steps: AnyStep[] | undefined): AnyStep[] {
  const out: AnyStep[] = [];
  const walk = (list: AnyStep[] | undefined): void => {
    for (const s of list ?? []) {
      out.push(s);
      if (s.type === "branch") {
        for (const arm of (s.branches as { steps?: AnyStep[] }[]) ?? []) walk(arm.steps);
        walk(s.else as AnyStep[] | undefined);
      }
    }
  };
  walk(steps);
  return out;
}

/**
 * Apply both edits to one definition. Returns the human-readable change
 * list (empty when already current).
 */
export function patchCleverExampleOffers(def: AnyDef): string[] {
  const changed: string[] = [];
  for (const s of walkSteps(def.steps)) {
    const fields = s.fields as Array<{ name?: string; description?: string }> | undefined;
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (f.name === CASH_OFFERS_FIELD.name && f.description !== CASH_OFFERS_FIELD.description) {
          f.description = CASH_OFFERS_FIELD.description;
          changed.push(`${s.id ?? "?"}: cash_offers extraction now ignores the Example only module`);
        }
      }
    }
    if (s.type === "place_ai_call" && typeof s.personaTemplate === "string") {
      const next = rewriteCleverPitchPersona(s.personaTemplate);
      if (next !== s.personaTemplate) {
        s.personaTemplate = next;
        changed.push(`${s.id ?? "?"}: dropped cash-offer dollar amounts from the spoken pitch`);
      }
    }
  }
  return changed;
}

/* c8 ignore start -- the IO shell; the pure patch above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { summarizeDefinition, AiFlowValidationError } = await import(
    "../../src/lib/ai-flows/schema.ts"
  );
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: npx tsx scripts/oneshot/amy-clever-example-offers.ts --business <uuid> [--apply]"
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

  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", BUSINESS_ID)
    .in("name", [...TARGET_FLOW_NAMES])
    .is("deleted_at", null);
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  const found = new Map((rows ?? []).map((r) => [r.name as string, r]));
  for (const name of TARGET_FLOW_NAMES) {
    if (!found.has(name)) {
      console.error(`"${name}" not found on business ${BUSINESS_ID}.`);
      process.exit(2);
    }
  }

  let anyChange = false;
  const patched: Array<{ id: string; name: string; notes: string[] }> = [];
  for (const name of TARGET_FLOW_NAMES) {
    const row = found.get(name)!;
    const next = JSON.parse(JSON.stringify(row.definition)) as AnyDef;
    const notes = patchCleverExampleOffers(next);
    console.log(`=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
    if (notes.length === 0) {
      console.log("  already patched, no changes");
      continue;
    }
    anyChange = true;
    for (const n of notes) console.log(`  - ${n}`);
    let validated;
    try {
      validated = parseAiFlowDefinition(next);
    } catch (e) {
      const msg = e instanceof AiFlowValidationError ? e.message : String(e);
      console.error(`\nwould not validate after patching ${name}: ${msg}`);
      process.exit(1);
    }
    console.log(`  after: ${summarizeDefinition(validated)}`);

    if (!APPLY) continue;

    const { data: updated, error: upErr } = await db
      .from("ai_flows")
      .update({ definition: validated })
      .eq("id", row.id)
      .eq("business_id", BUSINESS_ID)
      .select("id");
    if (upErr) {
      console.error(`update failed on ${name}: ${upErr.message}`);
      process.exit(1);
    }
    if ((updated ?? []).length !== 1) {
      console.error(`update on ${name} matched ${(updated ?? []).length} rows; NOT written.`);
      process.exit(1);
    }
    patched.push({ id: row.id as string, name, notes });
  }

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }
  if (!anyChange) {
    console.log("\nNothing to write.");
    process.exit(0);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-example-offers.ts",
    businessId: BUSINESS_ID,
    details: { flows: patched }
  });
  console.log("\nDone. Next seller call will not quote Clever's example figures.");
}

/* c8 ignore stop */
