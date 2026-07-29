#!/usr/bin/env tsx
/**
 * One-shot: Amy Laidlaw freeform SMS handoff + emoji intensity (Jul 28 2026).
 *
 * Mark McDonnell's Clever intro thread showed the freeform SMS coworker
 * nurturing then booking Friday itself instead of paging Amy's team. This
 * does NOT patch AiFlows. It tunes freeform SMS:
 *
 *   1. Marker-delimited soul.md block: team assistant (not Amy / not the
 *      listing agent); after engagement, confirm timeline + free appraisal
 *      interest, then hand off via notify_team / reasoning handoff; never
 *      offer or book appointment slots.
 *   2. Disable SMS calendar tools (find / book / reschedule / cancel /
 *      waitlist) so the model cannot book even if soul is ignored.
 *   3. businesses.needs_human_team_first = true so handoff:true offers the
 *      roster first.
 *   4. business_configs.emoji_intensity = 4 (at least one emoji per text).
 *   5. Vault sync so the soul block reaches the VPS Rowboat agent.
 *
 * Idempotent. Dry-run by default; --apply writes + ledgers.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-amy-sms-handoff-and-emoji.ts
 *   npx tsx scripts/oneshot/patch-amy-sms-handoff-and-emoji.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { syncVaultToVpsAndLog } = await import("../../src/lib/vps/sync-vault.ts");

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const TARGET_EMOJI = 4;
const SMS_CALENDAR_TOOLS = [
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist"
] as const;

const BLOCK_START = "<!-- amy-sms-handoff:start -->";
const BLOCK_END = "<!-- amy-sms-handoff:end -->";
const BLOCK_RE = /<!-- amy-sms-handoff:start -->[\s\S]*?<!-- amy-sms-handoff:end -->/;

const SOUL_BLOCK_BODY = [
  "## Freeform SMS: nurture then hand off",
  "",
  "You are Amy Laidlaw's team assistant at HomeSmart, not Amy herself and not",
  "the listing agent. When a seller or lead engages after outreach (Clever,",
  "HomeLight, referral, or similar):",
  "",
  "1. Briefly acknowledge their reply.",
  "2. Confirm or ask about their timeline and interest in the free certified",
  "   appraisal (and cash offers when relevant).",
  "3. Then hand off: call notify_team with their phone, what they said, and any",
  "   preferred timing, and/or set reasoning handoff to true. Tell them you will",
  "   put Amy's team in touch to discuss the free appraisal. Thanks so much.",
  "",
  "Do NOT offer appointment slots, quote times to book, or call calendar tools.",
  "Do NOT pretend to be Amy. Do NOT promise that you will call them (a person",
  "from the team will follow up after notify_team succeeds)."
].join("\n");

const SOUL_BLOCK = `${BLOCK_START}\n${SOUL_BLOCK_BODY}\n${BLOCK_END}`;

function replaceOrAppendSoulBlock(document: string): { next: string; changed: boolean } {
  if (BLOCK_RE.test(document)) {
    const next = document.replace(BLOCK_RE, SOUL_BLOCK);
    return { next, changed: next !== document };
  }
  const base = document.trimEnd();
  const next = base.length > 0 ? `${base}\n\n${SOUL_BLOCK}\n` : `${SOUL_BLOCK}\n`;
  return { next, changed: true };
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function main(): Promise<void> {
  console.log(`Business : ${BUSINESS_ID}`);
  console.log(`Mode     : ${APPLY ? "APPLY" : "dry-run"}`);

  const { data: cfg, error: cfgErr } = await db
    .from("business_configs")
    .select("soul_md, emoji_intensity")
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

  const soulMd = typeof cfg.soul_md === "string" ? cfg.soul_md : "";
  const { next: nextSoul, changed: soulChanged } = replaceOrAppendSoulBlock(soulMd);
  const emojiNow = cfg.emoji_intensity;
  const emojiChanged = emojiNow !== TARGET_EMOJI;

  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("needs_human_team_first")
    .eq("id", BUSINESS_ID)
    .maybeSingle();
  if (bizErr) {
    console.error(`Read businesses: ${bizErr.message}`);
    process.exit(1);
  }
  const teamFirstNow = biz?.needs_human_team_first === true;
  const teamFirstChanged = !teamFirstNow;

  const { data: toolRows, error: toolErr } = await db
    .from("agent_tool_settings")
    .select("tool_key, enabled")
    .eq("business_id", BUSINESS_ID)
    .eq("agent_key", "sms")
    .in("tool_key", [...SMS_CALENDAR_TOOLS]);
  if (toolErr) {
    console.error(`Read agent_tool_settings: ${toolErr.message}`);
    process.exit(1);
  }
  const enabledByKey = new Map(
    (toolRows ?? []).map((r) => [r.tool_key as string, r.enabled as boolean])
  );
  const toolsToDisable = SMS_CALENDAR_TOOLS.filter((k) => enabledByKey.get(k) !== false);

  console.log(`Soul block : ${soulChanged ? "needs update" : "already present"}`);
  console.log(`Emoji      : ${emojiNow ?? "(unset)"} → ${TARGET_EMOJI}${emojiChanged ? "" : " (no-op)"}`);
  console.log(
    `Team-first : ${teamFirstNow} → true${teamFirstChanged ? "" : " (no-op)"}`
  );
  console.log(
    `SMS calendar tools to disable: ${toolsToDisable.length ? toolsToDisable.join(", ") : "(all already off)"}`
  );

  if (!soulChanged && !emojiChanged && !teamFirstChanged && toolsToDisable.length === 0) {
    console.log("\nAlready at target state. Nothing to do.");
    return;
  }

  if (!APPLY) {
    if (soulChanged) {
      console.log("\n[dry-run] Soul block would become:\n");
      console.log(SOUL_BLOCK);
    }
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  if (soulChanged || emojiChanged) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (soulChanged) patch.soul_md = nextSoul;
    if (emojiChanged) patch.emoji_intensity = TARGET_EMOJI;
    const { error } = await db.from("business_configs").update(patch).eq("business_id", BUSINESS_ID);
    if (error) {
      console.error(`Update business_configs: ${error.message}`);
      process.exit(1);
    }
    console.log("Updated business_configs.");
  }

  if (teamFirstChanged) {
    const { error } = await db
      .from("businesses")
      .update({ needs_human_team_first: true })
      .eq("id", BUSINESS_ID);
    if (error) {
      console.error(`Update businesses.needs_human_team_first: ${error.message}`);
      process.exit(1);
    }
    console.log("Set needs_human_team_first = true.");
  }

  for (const toolKey of toolsToDisable) {
    const { error } = await db.from("agent_tool_settings").upsert(
      {
        business_id: BUSINESS_ID,
        agent_key: "sms",
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
    console.log(`Disabled ${toolsToDisable.length} SMS calendar tool(s).`);
  }

  if (soulChanged) {
    console.log("Syncing vault to VPS…");
    await syncVaultToVpsAndLog(BUSINESS_ID);
    console.log("Vault sync finished (see logs for ok/skip).");
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-amy-sms-handoff-and-emoji.ts",
    businessId: BUSINESS_ID,
    details: {
      soulChanged,
      emojiIntensity: TARGET_EMOJI,
      teamFirst: true,
      disabledSmsCalendarTools: toolsToDisable
    }
  });
  console.log("\nApplied and ledgered.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
