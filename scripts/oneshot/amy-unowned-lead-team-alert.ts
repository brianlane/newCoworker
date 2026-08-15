#!/usr/bin/env tsx
/**
 * One-shot: alert the lead-type-tagged team about an UNOWNED lead that fell
 * through both routing paths, by hand.
 *
 * Why this exists (Amy Laidlaw, 2026-08-15): a Clever seller replied "I'm
 * available now" the day he arrived, and the next day "I have not heard
 * anything from anyone". The AI's `notify_team` tool fired correctly both
 * times, but its recipient ladder (`contact_owner_target.ts`) has no team
 * rung: an unowned contact resolves straight to the business owner, so both
 * alerts went to Amy alone and no teammate ever saw the lead. The lead was
 * also priced under $500K, so the under-500K gate deliberately skipped the
 * claim offer, and the cadence tag that was supposed to pick him up instead
 * was keyed on a `lead_phone` that the Clever referral page never yielded.
 * No team offer by design, no cadence by accident, and nobody but Amy told.
 *
 * Amy's rule, 2026-08-15: "leads asking for a call means serious / asking for
 * a human, and unowned/unclaimed should go to all employees respective to
 * seller vs buyer employees before Amy broadcasted."
 *
 * The permanent fix is in the dispatcher (see the PR that adds a team rung to
 * the urgent-alert ladder). This script is the RECOVERY for leads already
 * stranded by the old behavior: it applies the same selection rule by hand so
 * a waiting lead does not sit until the fix ships.
 *
 * Selection mirrors `alertBroadcastTeam` in the AiFlow worker exactly:
 *   active, team_broadcast_enabled is not false, has a phone, tag matches
 *   (case-insensitive). A tag matching NOBODY alerts every eligible member
 *   rather than none: a typo costs noise, never a lead. Amy is excluded on
 *   her own account because her roster row sets team_broadcast_enabled=false,
 *   which is what makes her the backstop rather than the audience.
 *
 * NO CUSTOMER PII LIVES IN THIS FILE. Every lead detail is an argument.
 *
 * Idempotent: a recipient who already received an alert naming this lead's
 * phone is skipped, so a re-run converges instead of re-texting the team.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-unowned-lead-team-alert.ts \
 *     --lead-name "First Last" --lead-phone "+1..." --tag seller \
 *     --detail "Address: ... | Price: ..." \
 *     --said "what the lead texted"                         # dry run
 *   ... --apply                                             # send
 *
 * Exit codes: 0 sent/no-op/dry-run - 1 send or Supabase error - 2 bad args.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getTelnyxMessagingForBusiness,
  sendTelnyxSms
} from "@/lib/telnyx/messaging";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

export type RosterRow = {
  id: string;
  name: string | null;
  phone_e164: string | null;
  team_broadcast_enabled: boolean | null;
  tags: string[] | null;
};

/**
 * The eligible audience for an unowned-lead alert, narrowed by lead type.
 *
 * Kept as a pure function so the fail-safe is testable: `tag` matching nobody
 * must widen back to every eligible member, never collapse to an empty send.
 */
export function selectTaggedTeam(
  rows: readonly RosterRow[],
  tag: string
): RosterRow[] {
  const eligible = rows.filter(
    (r) =>
      r.team_broadcast_enabled !== false &&
      (r.phone_e164 ?? "").trim().length > 0
  );
  const want = tag.trim().toLowerCase();
  if (!want) return eligible;
  const tagged = eligible.filter((r) =>
    (r.tags ?? []).some((t) => String(t).trim().toLowerCase() === want)
  );
  return tagged.length > 0 ? tagged : eligible;
}

/**
 * The alert copy. Deliberately says "unclaimed" and names the next action:
 * this is an ALERT, not a claim offer, so there is no reply-1 affordance and
 * nothing is waiting on a response.
 */
export function buildAlertBody(args: {
  leadName: string;
  leadPhone: string;
  detail: string;
  said: string;
}): string {
  const lines = [
    `[Coworker] UNCLAIMED lead needs a human: ${args.leadName} (${args.leadPhone})`,
    args.detail.trim(),
    args.said.trim() ? `They said: "${args.said.trim()}"` : "",
    "Nobody owns this lead yet. Please reach out directly, then claim them in the dashboard."
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/** Has this recipient already been told about this lead? */
async function alreadyAlerted(
  db: SupabaseClient,
  businessId: string,
  toE164: string,
  leadPhone: string
): Promise<boolean> {
  const { data, error } = await db
    .from("sms_outbound_log")
    .select("id, body")
    .eq("business_id", businessId)
    .eq("to_e164", toE164)
    .eq("source", "owner_alert")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error(`Dedupe read failed: ${error.message}`);
    process.exit(1);
  }
  return (data ?? []).some((r: { body: string | null }) =>
    (r.body ?? "").includes(leadPhone)
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const businessId = arg("business-id") ?? DEFAULT_BUSINESS_ID;
  const leadName = arg("lead-name");
  const leadPhone = arg("lead-phone");
  const tag = arg("tag") ?? "";
  const detail = arg("detail") ?? "";
  const said = arg("said") ?? "";
  if (!leadName || !leadPhone) {
    console.error("Required: --lead-name <name> --lead-phone <e164>");
    process.exit(2);
  }

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id,name,phone_e164,team_broadcast_enabled,tags")
    .eq("business_id", businessId)
    .eq("active", true);
  if (error) {
    console.error(`Roster read failed: ${error.message}`);
    process.exit(1);
  }
  const recipients = selectTaggedTeam((data ?? []) as RosterRow[], tag);
  if (recipients.length === 0) {
    console.error("No eligible roster member. Nothing sent.");
    process.exit(1);
  }

  const body = buildAlertBody({ leadName, leadPhone, detail, said });
  console.log(`Business: ${businessId}`);
  console.log(`Tag filter: ${tag || "(none, every eligible member)"}`);
  console.log(
    `Recipients: ${recipients.map((r) => r.name ?? r.phone_e164).join(", ")}`
  );
  console.log(`\n--- message ---\n${body}\n---------------\n`);

  const pending: RosterRow[] = [];
  for (const r of recipients) {
    if (await alreadyAlerted(db, businessId, r.phone_e164!, leadPhone)) {
      console.log(`${r.name}: already alerted about this lead, skipping.`);
      continue;
    }
    pending.push(r);
  }
  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log(`[dry-run] Would text ${pending.length}. Re-run with --apply.`);
    return;
  }

  const config = await getTelnyxMessagingForBusiness(businessId, db);
  const sent: Array<{ name: string | null; to: string }> = [];
  for (const r of pending) {
    const to = r.phone_e164!;
    const { id: telnyxMessageId, channel } = await sendTelnyxSms(
      config,
      to,
      body,
      {
        meterBusinessId: businessId,
        meterMode: "operational"
      }
    );
    const { error: logErr } = await db.from("sms_outbound_log").insert({
      business_id: businessId,
      to_e164: to,
      from_e164: config.fromE164 ?? null,
      body,
      source: "owner_alert",
      run_id: null,
      flow_id: null,
      telnyx_message_id: telnyxMessageId,
      channel
    });
    if (logErr)
      console.error(
        `  log insert failed for ${r.name} (non-fatal): ${logErr.message}`
      );
    console.log(`  -> texted ${r.name} (${to}).`);
    sent.push({ name: r.name, to });
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-unowned-lead-team-alert.ts",
    businessId,
    details: {
      tag,
      lead_phone: leadPhone,
      recipients: sent.map((s) => s.name)
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
