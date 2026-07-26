#!/usr/bin/env tsx
/**
 * One-shot: put Amy Laidlaw back where she was before Jul 20 2026 for LEAD
 * DISTRIBUTION, without giving up the broadcast that day added.
 *
 * Background: `homelight-broadcast-offer.ts` (PR #790, applied 2026-07-20
 * 18:45 Phoenix) added Amy to ai_flow_team_members because a broadcast can
 * only offer roster members, and the HomeLight referral was moving from
 * Dave-only to "Dave and Amy, first to reply 1 wins". Roster membership is
 * global, so that also entered the OWNER into the round-robin rotation of
 * every unpinned route_to_team step in her tenant: `Realtor.com Lead` (s4),
 * `ReferralExchange Lead` (route_buyer), and `New Lead Intake` (route_buyer).
 * She never asked for buyer leads in rotation.
 *
 * What this sets on her roster row:
 *   routing_enabled          false  out of the rotation, auto-assign,
 *                                   contact-owner preference, and pins
 *   named_broadcast_enabled  true   HomeLight (agentNames) still reaches her
 *   team_broadcast_enabled   false  out of whole-roster fan-outs (the
 *                                   team-first human handoff, if she ever
 *                                   turns that on)
 *
 * Her owner alerts are unaffected either way: keep-for-owner ($1M+) alerts and
 * their nudges, the nobody-claimed fallback, and claim notices all resolve
 * business_telnyx_settings.forward_to_e164 and never read the roster.
 *
 * Requires the migration AND the ai-flow-worker deploy that reads these
 * columns to be live first; before that the columns exist but nothing honors
 * them, so an early apply is inert rather than harmful.
 *
 * Idempotent: a row already in this state is reported and left alone.
 * Dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-amy-roster-availability.ts            # dry run
 *   npx tsx scripts/oneshot/set-amy-roster-availability.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Member: --phone <e164> (defaults to Amy's cell).
 *
 * Exit codes: 0 applied/no-op/dry-run · 1 Supabase error · 2 bad env/arg or member not found.
 */
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null; phone: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null, phone: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else if (a === "--phone") args.phone = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
/** Amy's cell, which is also businesses.phone and the Telnyx forward number. */
const DEFAULT_PHONE = "+16026951142";

/** The target state: reachable by name, never by rotation or fan-out. */
const TARGET = {
  routing_enabled: false,
  named_broadcast_enabled: true,
  team_broadcast_enabled: false
} as const;

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

type MemberRow = {
  id: string;
  name: string;
  phone_e164: string;
  active: boolean;
  routing_enabled: boolean | null;
  named_broadcast_enabled: boolean | null;
  team_broadcast_enabled: boolean | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const phone = args.phone ?? DEFAULT_PHONE;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("ai_flow_team_members")
    .select(
      "id, name, phone_e164, active, routing_enabled, named_broadcast_enabled, team_broadcast_enabled"
    )
    .eq("business_id", businessId)
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error) {
    console.error(`Roster read failed: ${error.message}`);
    process.exit(1);
  }
  const member = data as MemberRow | null;
  if (!member) {
    console.error(`No roster member with phone ${phone} for business ${businessId}.`);
    process.exit(2);
  }

  // Null reads as the column default (true), which is what the engine does.
  const current = {
    routing_enabled: member.routing_enabled !== false,
    named_broadcast_enabled: member.named_broadcast_enabled !== false,
    team_broadcast_enabled: member.team_broadcast_enabled !== false
  };
  const changed = (Object.keys(TARGET) as (keyof typeof TARGET)[]).filter(
    (k) => current[k] !== TARGET[k]
  );

  console.log(`\n=== ${member.name} (${member.phone_e164}) ===`);
  console.log(`  active: ${member.active}`);
  for (const key of Object.keys(TARGET) as (keyof typeof TARGET)[]) {
    const mark = current[key] === TARGET[key] ? "already" : `${current[key]} -> ${TARGET[key]}`;
    console.log(`  ${key}: ${mark}`);
  }

  if (changed.length === 0) {
    console.log("\nAlready in the target state, nothing to do.");
    return;
  }
  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  const { error: upErr } = await db
    .from("ai_flow_team_members")
    .update(TARGET)
    .eq("id", member.id);
  if (upErr) {
    console.error(`Update failed for ${member.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("\n  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "set-amy-roster-availability.ts",
    businessId,
    details: {
      member_id: member.id,
      member_name: member.name,
      phone_e164: member.phone_e164,
      changed,
      ...TARGET
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
