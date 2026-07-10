#!/usr/bin/env tsx
/**
 * One-shot: rewire Truly Insurance's "Post-appointment follow-up" AiFlow onto
 * the new `event_end` calendar trigger.
 *
 * The flow was authored before after-event triggers existed, so it guesses:
 * it fires 5 minutes BEFORE the appointment starts, then sleeps 75 minutes,
 * then texts — which lands mid-meeting for a 2-hour appointment and ~40
 * minutes late for a 30-minute one. `event_end` anchors to the event's ACTUAL
 * end time, so the follow-up tracks the appointment's real length:
 *
 *   before: { on: "event_start", leadMinutes: 5 }  + sleep(75) step
 *   after : { on: "event_end", followMinutes: 15 } (sleep step removed)
 *
 * Idempotent (skips when the trigger is already event_end), preserves the
 * watched calendar + conditions + every other step, and validates through
 * parseAiFlowDefinition before writing.
 *
 * Usage (reads repo-root `.env`, like the rest of debug/):
 *   tsx debug/update-truly-post-appointment-event-end.ts            # dry run
 *   tsx debug/update-truly-post-appointment-event-end.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_FLOW_ID (default: Truly's flow), AIFLOW_FOLLOW_MINUTES
 * (default 15 — minutes after the appointment ends before the text goes out).
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "../src/lib/ai-flows/schema.ts";

/** Truly Insurance "Post-appointment follow-up". */
const DEFAULT_FLOW_ID = "fa30ec96-fd46-45d3-b0ae-817a852aeee7";

async function main(): Promise<void> {
  loadEnv();
  const FLOW_ID = process.env.AIFLOW_UPDATE_FLOW_ID ?? DEFAULT_FLOW_ID;
  const FOLLOW_MINUTES = Math.max(0, Number(process.env.AIFLOW_FOLLOW_MINUTES ?? "15") || 0);
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, business_id, name, enabled, definition")
    .eq("id", FLOW_ID)
    .maybeSingle();
  if (error) {
    console.error(`read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`no flow ${FLOW_ID}`);
    process.exit(1);
  }

  const def = parseAiFlowDefinition(row.definition);
  console.log(`[${row.name}] ${row.id} (business ${row.business_id}, enabled=${row.enabled})`);
  console.log(`  Before: ${summarizeDefinition(def)}`);

  if (def.trigger.channel !== "calendar") {
    console.error("  trigger is not a calendar trigger — nothing to rewire");
    process.exit(1);
  }
  if (def.trigger.on === "event_end") {
    console.log("  already on event_end — no change");
    return;
  }

  // Preserve the watched calendar + conditions; only the firing mode moves.
  const trigger = {
    channel: "calendar" as const,
    ...(def.trigger.calendar ? { calendar: def.trigger.calendar } : {}),
    on: "event_end" as const,
    ...(FOLLOW_MINUTES > 0 ? { followMinutes: FOLLOW_MINUTES } : {}),
    conditions: def.trigger.conditions
  };
  // The sleep was only ever there to outwait the appointment; event_end makes
  // it obsolete. Any other steps (extract/send/tag/notify) stay untouched.
  const steps = def.steps.filter((s) => s.type !== "sleep");
  const removed = def.steps.length - steps.length;

  let validated;
  try {
    validated = parseAiFlowDefinition({ ...def, trigger, steps });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("  validation failed:");
      for (const issue of err.issues) console.error(`    - ${issue}`);
    } else {
      console.error("  validation failed:", err);
    }
    process.exit(2);
  }

  console.log(`  After : ${summarizeDefinition(validated)}`);
  console.log(`  Sleep steps removed: ${removed}`);

  if (!apply) {
    console.log("  [dry-run] not writing");
    return;
  }
  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (upErr) {
    console.error(`  update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  Updated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
