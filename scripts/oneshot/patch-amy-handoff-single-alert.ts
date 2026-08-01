#!/usr/bin/env tsx
/**
 * One-shot: Amy Laidlaw freeform SMS handoff, one alert per request (Aug 1 2026).
 *
 * The Jul 28 soul block (patch-amy-sms-handoff-and-emoji.ts) told the
 * freeform SMS coworker to "call notify_team ... and/or set reasoning
 * handoff to true". The model took "and/or" literally: on Jul 30-31 four
 * leads (Jeremy Vaught, the Clever group intro, Donna Robinson, Kolton
 * Bottolfson) each produced TWO texts to the claimed agent within seconds,
 * the "[Coworker] Follow up ..." notify_team page and the "New Coworker
 * Alert: ... take over ..." handoff page. The platform now also dedupes
 * these at the transport level (notifications function,
 * `recent_team_notify` skips), but the persona should stop asking for both
 * in the first place.
 *
 * This rewrites step 3 of the marker-delimited soul block: notify_team is
 * the handoff for follow-up requests; reasoning handoff is reserved for a
 * human taking over the conversation itself, and never both for the same
 * request. Same markers as the Jul 28 block, so this replaces it in place.
 *
 * Idempotent. Dry-run by default; --apply writes + ledgers.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-amy-handoff-single-alert.ts
 *   npx tsx scripts/oneshot/patch-amy-handoff-single-alert.ts --apply
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
  "   preferred timing. Do NOT also set reasoning handoff to true for the same",
  "   request: notify_team already reaches the team, and a second alert pages",
  "   the same person twice. Reserve reasoning handoff for when a human must",
  "   take over this conversation itself and notify_team is not enough. Tell",
  "   them you will put Amy's team in touch to discuss the free appraisal.",
  "   Thanks so much.",
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
    .select("soul_md")
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

  console.log(`Soul block : ${soulChanged ? "needs update" : "already at target"}`);

  if (!APPLY) {
    if (soulChanged) {
      console.log("\n[dry-run] Soul block would become:\n");
      console.log(SOUL_BLOCK);
    } else {
      console.log("\n[dry-run] Soul already at target; --apply would still re-sync the vault.");
    }
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  if (soulChanged) {
    const { error } = await db
      .from("business_configs")
      .update({ soul_md: nextSoul, updated_at: new Date().toISOString() })
      .eq("business_id", BUSINESS_ID);
    if (error) {
      console.error(`Update business_configs: ${error.message}`);
      process.exit(1);
    }
    console.log("Updated business_configs.");
  } else {
    // A prior --apply may have written the soul and then died on the vault
    // sync, exiting before the ledger (Bugbot, PR #1115). "Already at
    // target" therefore never early-returns in apply mode: the sync and
    // ledger below still run so a re-run converges instead of no-opping.
    console.log("Soul already at target; re-syncing the vault.");
  }

  console.log("Syncing vault to VPS…");
  const vault = await syncVaultToVps(BUSINESS_ID);
  if (!vault.ok) {
    console.error(
      `Vault sync failed (${vault.reason}${vault.detail ? `: ${vault.detail}` : ""}). ` +
        "Soul is updated in Supabase but freeform SMS still has the old vault. " +
        "Fix the VPS/SSH issue and re-run with --apply (idempotent)."
    );
    process.exit(1);
  }
  console.log(
    `Vault sync ok (projectId=${vault.projectId}, instructionsLength=${vault.instructionsLength}).`
  );

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-amy-handoff-single-alert.ts",
    businessId: BUSINESS_ID,
    details: { soulChanged, singleAlertHandoff: true }
  });
  console.log("\nApplied and ledgered.");
}

await main();
