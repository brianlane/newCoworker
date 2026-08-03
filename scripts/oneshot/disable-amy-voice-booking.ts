#!/usr/bin/env tsx
/**
 * One-shot: stop Amy Laidlaw's VOICE coworker booking appointments (Aug 3 2026).
 *
 * Background. `patch-amy-sms-handoff-and-emoji.ts` (Jul 29 2026) decided that
 * this account nurtures and hands off rather than books, and enforced it by
 * disabling the five calendar tools for `agent_key = 'sms'`. That decision was
 * never applied to voice, and nothing surfaces "this tool is off on one channel
 * and on for another", so the phone coworker kept booking for another five days.
 *
 * Chris Bartelot's call on Aug 3 is the case that surfaced it: the AI offered a
 * listing consultation starting in fifteen minutes, repeated the offer four
 * times while the caller was still reading out property addresses, and booked
 * Thursday 4pm onto the team calendar. It was not hallucinating a service. It
 * was following this account's own voice-side config:
 *
 *   memory_md → Scheduling Rules:
 *     "Use the team calendar to schedule consultations/showings by default."
 *
 * which is the exact reverse of the SMS policy in soul_md. So the account
 * contradicted itself by channel, and voice followed the instruction it could
 * see.
 *
 * This does two things:
 *
 *   1. Disables the same five calendar tools for `agent_key = 'voice'`. This is
 *      the real enforcement: the voice bridge reads `agent_tool_settings`
 *      (vps/voice-bridge/src/tool-settings.ts) and withholds the declarations,
 *      so the model cannot book even if the prose is ignored. Prompt text alone
 *      would not hold, which is the same reasoning the bridge already applies
 *      to staff-only tools.
 *   2. Replaces the contradicting memory_md scheduling rule with a positive
 *      instruction, so the AI knows what to do INSTEAD of booking rather than
 *      just finding a tool missing.
 *
 * Deliberately NOT done: hoisting the `amy-sms-handoff` soul block to cover
 * voice. Its wording is specific to outbound SMS nurture (Clever/HomeLight
 * reply context, the free certified appraisal), which does not transfer
 * verbatim to an inbound phone call. Left as a separate decision.
 *
 * Consequence worth knowing before applying: this stops the AI booking ANY
 * appointment by phone, showings included, not only listing consultations.
 *
 * Idempotent. Dry-run by default; --apply writes + ledgers.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/disable-amy-voice-booking.ts
 *   npx tsx scripts/oneshot/disable-amy-voice-booking.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { syncVaultToVps } = await import("../../src/lib/vps/sync-vault.ts");

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** The same five the SMS patch disabled on Jul 29 2026. */
const VOICE_CALENDAR_TOOLS = [
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist"
] as const;

/**
 * The line that told voice to book. Tolerant of horizontal whitespace only:
 * `\s` would match newlines, and a greedy `\s*$` then eats the blank line
 * after the bullet, silently reflowing the rest of the document.
 */
const OLD_SCHEDULING_RE =
  /^-[ \t]*Use the team calendar to schedule consultations\/showings by default\.[ \t]*$/m;

const NEW_SCHEDULING_LINE =
  "- Do not book appointments directly. Collect what the caller needs " +
  "(contact details, property address, timeline) and hand off with notify_team " +
  "so a person from the team confirms the time with them.";

export function replaceSchedulingRule(memoryMd: string): {
  next: string;
  status: "replaced" | "already_applied" | "not_found";
} {
  if (OLD_SCHEDULING_RE.test(memoryMd)) {
    return { next: memoryMd.replace(OLD_SCHEDULING_RE, NEW_SCHEDULING_LINE), status: "replaced" };
  }
  // Idempotency: a second run finds the new line and stops, rather than
  // reporting "not_found" and looking like the patch failed.
  if (memoryMd.includes(NEW_SCHEDULING_LINE)) {
    return { next: memoryMd, status: "already_applied" };
  }
  return { next: memoryMd, status: "not_found" };
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

async function main(): Promise<void> {
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  console.log(`Business : ${BUSINESS_ID}`);
  console.log(`Mode     : ${APPLY ? "APPLY" : "dry-run"}`);

  const { data: toolRows, error: toolErr } = await db
    .from("agent_tool_settings")
    .select("tool_key, enabled")
    .eq("business_id", BUSINESS_ID)
    .eq("agent_key", "voice")
    .in("tool_key", [...VOICE_CALENDAR_TOOLS]);
  if (toolErr) {
    console.error(`Read agent_tool_settings: ${toolErr.message}`);
    process.exit(1);
  }
  const enabledByKey = new Map(
    (toolRows ?? []).map((r) => [r.tool_key as string, r.enabled as boolean])
  );
  // A MISSING row is not "off": the registry default applies, and for the
  // calendar tools that default is enabled. So anything not explicitly false
  // still needs writing.
  const toolsToDisable = VOICE_CALENDAR_TOOLS.filter((k) => enabledByKey.get(k) !== false);

  const { data: cfg, error: cfgErr } = await db
    .from("business_configs")
    .select("memory_md")
    .eq("business_id", BUSINESS_ID)
    .maybeSingle();
  if (cfgErr) {
    console.error(`Read business_configs: ${cfgErr.message}`);
    process.exit(1);
  }
  if (!cfg) {
    console.error("No business_configs row for this business");
    process.exit(1);
  }
  const memoryMd = typeof cfg.memory_md === "string" ? cfg.memory_md : "";
  const { next: nextMemory, status: memoryStatus } = replaceSchedulingRule(memoryMd);
  const memoryChanged = memoryStatus === "replaced";

  console.log(
    `Voice calendar tools to disable: ${
      toolsToDisable.length ? toolsToDisable.join(", ") : "(all already off)"
    }`
  );
  console.log(`memory_md scheduling rule: ${memoryStatus}`);
  if (memoryStatus === "not_found") {
    console.warn(
      "  WARNING: neither the old booking rule nor the replacement was found. " +
        "The config may have been edited by hand; review memory_md before assuming this is done."
    );
  }

  if (toolsToDisable.length === 0 && !memoryChanged) {
    console.log("\nAlready at target state. Nothing to do.");
    return;
  }

  if (!APPLY) {
    if (memoryChanged) {
      console.log("\n[dry-run] Scheduling rule would become:\n");
      console.log(NEW_SCHEDULING_LINE);
    }
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  for (const toolKey of toolsToDisable) {
    const { error } = await db.from("agent_tool_settings").upsert(
      {
        business_id: BUSINESS_ID,
        agent_key: "voice",
        tool_key: toolKey,
        enabled: false,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,agent_key,tool_key" }
    );
    if (error) {
      console.error(`Upsert agent_tool_settings ${toolKey}: ${error.message}`);
      process.exit(1);
    }
  }
  if (toolsToDisable.length > 0) {
    console.log(`Disabled ${toolsToDisable.length} voice calendar tool(s).`);
  }

  if (memoryChanged) {
    const { error } = await db
      .from("business_configs")
      .update({ memory_md: nextMemory, updated_at: new Date().toISOString() })
      .eq("business_id", BUSINESS_ID);
    if (error) {
      console.error(`Update business_configs: ${error.message}`);
      process.exit(1);
    }
    console.log("Updated business_configs.memory_md.");

    console.log("Syncing vault to VPS…");
    const vault = await syncVaultToVps(BUSINESS_ID);
    if (!vault.ok) {
      console.error(
        `Vault sync failed (${vault.reason}${vault.detail ? `: ${vault.detail}` : ""}). ` +
          "memory_md is updated in Supabase but the box still has the old vault. " +
          "Re-run `npx tsx debug/resync-vault.ts` once the box is reachable."
      );
    } else {
      console.log("Vault synced.");
    }
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: BUSINESS_ID,
    details: {
      voice_calendar_tools_disabled: toolsToDisable,
      memory_scheduling_rule: memoryStatus
    }
  });
  console.log("\nDone.");
}

// Guarded so `replaceSchedulingRule` can be imported by tests without the
// script trying to reach a database.
if (process.argv[1] && process.argv[1].includes("disable-amy-voice-booking")) {
  await main();
}
