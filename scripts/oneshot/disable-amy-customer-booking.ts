#!/usr/bin/env tsx
/**
 * One-shot: finish Amy Laidlaw's "collect and hand off, never book" policy by
 * closing the two customer channels it never reached (Aug 3 2026).
 *
 * The story so far. `patch-amy-sms-handoff-and-emoji.ts` set the policy on
 * Jul 29 by disabling the calendar tools for `sms`.
 * `disable-amy-voice-booking.ts` extended it to `voice` on Aug 3, after Chris
 * Bartelot's call showed the phone coworker still booking. Then
 * `debug/audit-agent-tool-channels.ts` was written to make that class of gap
 * findable, and on its first run it reported that the SAME tools are still
 * default-on for `webchat` and `email`, both customer-facing. So the policy was
 * still only three quarters applied.
 *
 * This closes those two. After it, the audit is silent for this tenant.
 *
 * `dashboard` is deliberately LEFT ON. That surface is Amy talking to her own
 * assistant, not the AI acting at a customer, and she explicitly enabled
 * booking there on Jun 14 2026. The policy is about what the AI does to
 * customers unsupervised, not about what Amy can ask it to do.
 *
 * Pairs come from the tool registry rather than a hardcoded list, because the
 * channels do not carry the same tools: webchat has only find_slots and
 * book_appointment, voice has three, sms and email have all five. The earlier
 * voice one-shot hardcoded five and wrote two rows for tools voice does not
 * have. Those rows are inert (nothing reads them) and are left alone: if voice
 * ever gains those tools, an already-disabled row is the outcome we want.
 *
 * Idempotent. Dry-run by default; --apply writes + ledgers.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/disable-amy-customer-booking.ts
 *   npx tsx scripts/oneshot/disable-amy-customer-booking.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { AGENT_TOOL_REGISTRY } = await import("../../src/lib/agent-tools/registry.ts");

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/**
 * Surfaces where the AI talks to a CUSTOMER without Amy in the loop.
 * `dashboard` is excluded on purpose, see the header.
 */
const CUSTOMER_CHANNELS = ["voice", "sms", "webchat", "email"] as const;

const CALENDAR_TOOLS = [
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist"
] as const;

export type ToolPair = { agentKey: string; toolKey: string };

/**
 * Every (channel, calendar tool) pair that actually exists in the registry and
 * can be toggled. Driving off the registry keeps us from writing rows for
 * tools a channel does not have.
 */
export function calendarPairsForCustomerChannels(): ToolPair[] {
  const pairs: ToolPair[] = [];
  for (const agentKey of CUSTOMER_CHANNELS) {
    const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === agentKey);
    if (!agent) continue;
    for (const toolKey of CALENDAR_TOOLS) {
      const tool = agent.tools.find((t) => t.toolKey === toolKey);
      // `configurable: false` has no enforcement point, so a row would be a lie.
      if (!tool || !tool.configurable) continue;
      pairs.push({ agentKey, toolKey });
    }
  }
  return pairs;
}

/**
 * Which of those pairs still need writing. A MISSING row is not "off": it means
 * the registry default, which for every calendar tool is enabled. That is the
 * exact trap this whole sequence of one-shots exists to close, so anything not
 * explicitly `false` counts as outstanding.
 */
export function pairsNeedingDisable(
  pairs: readonly ToolPair[],
  existing: ReadonlyArray<{ agent_key: string; tool_key: string; enabled: boolean }>
): ToolPair[] {
  return pairs.filter(({ agentKey, toolKey }) => {
    const row = existing.find((r) => r.agent_key === agentKey && r.tool_key === toolKey);
    return !row || row.enabled !== false;
  });
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
  console.log(`Channels : ${CUSTOMER_CHANNELS.join(", ")} (dashboard deliberately untouched)`);

  const pairs = calendarPairsForCustomerChannels();
  const { data: rows, error } = await db
    .from("agent_tool_settings")
    .select("agent_key, tool_key, enabled")
    .eq("business_id", BUSINESS_ID)
    .in("agent_key", [...CUSTOMER_CHANNELS])
    .in("tool_key", [...CALENDAR_TOOLS]);
  if (error) {
    console.error(`Read agent_tool_settings: ${error.message}`);
    process.exit(1);
  }
  const existing = (rows ?? []) as Array<{
    agent_key: string;
    tool_key: string;
    enabled: boolean;
  }>;

  const todo = pairsNeedingDisable(pairs, existing);
  console.log(`\nPairs in registry : ${pairs.length}`);
  console.log(`Already disabled  : ${pairs.length - todo.length}`);
  console.log(`To disable        : ${todo.length}`);
  for (const p of todo) console.log(`  ${p.agentKey} / ${p.toolKey}`);

  if (todo.length === 0) {
    console.log("\nAlready at target state. Nothing to do.");
    return;
  }
  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  for (const { agentKey, toolKey } of todo) {
    const { error: upsertErr } = await db.from("agent_tool_settings").upsert(
      {
        business_id: BUSINESS_ID,
        agent_key: agentKey,
        tool_key: toolKey,
        enabled: false,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,agent_key,tool_key" }
    );
    if (upsertErr) {
      console.error(`Upsert ${agentKey}/${toolKey}: ${upsertErr.message}`);
      process.exit(1);
    }
  }
  console.log(`\nDisabled ${todo.length} pair(s).`);

  // No vault sync here: this writes only agent_tool_settings, which the
  // surfaces read from Supabase per call. The prose half of the policy already
  // shipped with disable-amy-voice-booking.ts.
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: BUSINESS_ID,
    details: { disabled: todo.map((p) => `${p.agentKey}/${p.toolKey}`) }
  });
  console.log("Done. Re-run `tsx debug/audit-agent-tool-channels.ts` to confirm it is silent.");
}

// Guarded so the pure helpers can be imported by tests without the script
// trying to reach a database.
if (process.argv[1] && process.argv[1].includes("disable-amy-customer-booking")) {
  await main();
}
