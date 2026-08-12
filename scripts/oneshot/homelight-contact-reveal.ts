#!/usr/bin/env tsx
/**
 * One-shot: make HomeLight actually deliver the seller's contact details and
 * price, on every path HomeLight reveals them.
 *
 * Amy, 2026-08-12: "it broadcasts the lead to everyone but we never have the
 * contact information or the price."
 *
 * FOUR SEPARATE CAUSES, found by reading Kevin Duford's run (85d1bd1f,
 * 2026-08-11) against the portal screenshot Amy sent.
 *
 * 1. OUR OWN CLAIM WAS READ AS A RIVAL'S. `already_claimed` asks whether the
 *    referral was "already claimed by ANOTHER agent", but the portal renders a
 *    flat `Claimed By: Amy Laidlaw` row, which is US. The model answered "yes",
 *    the flow took the we-lost-it path, and 39 of 61 steps were skipped:
 *    save_contact, to_agent, qt_email, lead_sms, lead_email and notify all
 *    never ran. That single misread is most of Amy's complaint, and the fix is
 *    to name the team in the question so our own claim reads as ours.
 *
 * 2. THE EMAIL WAS NEVER READ UNLESS SOMEONE CLAIMED. `email_card` carried
 *    `when claimed_agent notEquals none`, so an unclaimed lead's details sat in
 *    amy@amylaidlaw.com and nothing fetched them, which is backwards: the team
 *    needs the details in order to decide whether to claim.
 *
 * 3. NO PRICE FROM THE EMAIL. Price came only from the alert text ("$560K").
 *    The email carries the exact figure ("$560,000") along with the timeframe
 *    and property type, and those are what a teammate wants before calling.
 *
 * 4. NOBODY HEARD ABOUT LATE DETAILS UNLESS THEY HAD CLAIMED. Every
 *    contact-info text addressed `{{vars.claimed_agent_phone}}`, so on an
 *    unclaimed lead the details arrived and went to no one.
 *
 * WHAT THIS DOES NOT DO, deliberately: HomeLight only ever reveals details
 * after a successful live transfer or a connected call. When a seller hangs up
 * before the transfer connects, no email is coming, ever. The flow already has
 * `late2_never_agent` / `late2_never_notify` for that; this widens them so the
 * message is honest about the reason rather than implying the wait continues.
 *
 * A SCREENSHOT OF THE EMAIL was Amy's phrasing, and the engine has no way to
 * screenshot an email (`attachScreenshot` attaches a BROWSE screenshot). The
 * full email text is captured instead and put in the email to Amy, which
 * carries everything an image would and is searchable in her inbox.
 *
 * Read-modify-write against the LIVE definition, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-contact-reveal.ts          # dry run
 *   npx tsx scripts/oneshot/homelight-contact-reveal.ts --apply
 *   npx tsx scripts/oneshot/homelight-contact-reveal.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStep } from "./amy-lead-price-in-notices";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "homelight-contact-reveal.ts";
export const FLOW_NAME = "HomeLight Referral";

/**
 * The claim question, reworded so OUR OWN claim is not mistaken for a rival's.
 *
 * The portal renders one flat `Claimed By: <name>` row whether the claimer is
 * this team or another agency, so the old wording ("claimed by another agent")
 * gave the model no way to tell them apart. Naming the team is what makes the
 * question answerable.
 */
export const ALREADY_CLAIMED_DESCRIPTION =
  "One lowercase word. Answer no when this referral is unclaimed, or when the " +
  "page shows it claimed by Amy Laidlaw or her team: that is OUR claim and the " +
  "lead is ours to work. Answer yes ONLY when a different brokerage or an agent " +
  "outside this team holds it, or it is no longer available to claim.";

/** Details HomeLight reveals in the email, which the alert text never carries. */
export const EMAIL_FIELDS = [
  {
    name: "email_price",
    description:
      "The exact asking price from this email (e.g. $560,000), not the rounded " +
      "figure from the text alert. If the email shows no price, answer exactly: none"
  },
  {
    name: "email_timeframe",
    description:
      "The seller's timeframe from this email (e.g. Unsure, 1-3 months). " +
      "If it is not shown, answer exactly: none"
  },
  {
    name: "email_summary",
    description:
      "The client-details section of this email as plain text: side, phone, email, " +
      "address, price, timeframe, property type, claimed by, and the request notes. " +
      "Copy what is there, never invent. If there are none, answer exactly: none"
  }
];

/**
 * The fields every unclaimed mailbox read pulls, plus its OWN status var.
 *
 * A status var PER READ, mirroring the claimed ladder's
 * contact_status / late_contact_status / late2_contact_status. One shared
 * status would not work: the reads carry `fillOnlyEmpty`, so a status written
 * "missing" on the first pass could never be updated to "found" by a later one.
 */
function readFieldsFor(statusVar: string): Array<{ name: string; description: string }> {
  return [
    { name: "lead_phone", description: "The lead's phone number, labeled 'Phone' in the HomeLight email" },
    { name: "lead_email", description: "The lead's email, labeled 'Email' in the HomeLight email, or 'none'" },
    { name: "lead_address", description: "The property street address labeled 'Address' in the HomeLight email" },
    ...EMAIL_FIELDS.map((f) => ({ ...f })),
    {
      name: statusVar,
      description:
        "Answer exactly one lowercase word: found if this email lists the CLIENT's own " +
        "phone number, missing if it does not. Never count the agent's own number or a " +
        "HomeLight support number."
    }
  ];
}

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

export type PatchResult = { changed: boolean; touched: string[] };

/** Add fields to an extract step, skipping any already present. */
export function addFields(step: AnyStep, fields: typeof EMAIL_FIELDS): boolean {
  const existing = (step.fields as Array<{ name?: string }> | undefined) ?? [];
  const missing = fields.filter((f) => !existing.some((e) => e.name === f.name));
  if (missing.length === 0) return false;
  step.fields = [...existing, ...missing.map((f) => ({ ...f }))];
  return true;
}

/**
 * Apply every fix in place. Throws rather than guessing when a step it expects
 * is gone: a renamed step means the live flow moved and these assumptions need
 * re-checking before anything is written.
 */
export function patchHomeLight(def: Definition): PatchResult {
  const steps = def.steps ?? [];
  const touched: string[] = [];
  const need = (id: string): AnyStep => {
    const s = findStep(steps, id);
    if (!s) throw new Error(`${FLOW_NAME}: step "${id}" is missing`);
    return s;
  };

  // 1. Our own claim is not a rival's.
  for (const id of ["open", "card"]) {
    const step = need(id);
    const fields = (step.fields as Array<{ name?: string; description?: string }>) ?? [];
    const f = fields.find((x) => x.name === "already_claimed");
    if (!f) throw new Error(`${FLOW_NAME}: step "${id}" has no already_claimed field`);
    if (f.description !== ALREADY_CLAIMED_DESCRIPTION) {
      f.description = ALREADY_CLAIMED_DESCRIPTION;
      touched.push(`${id}.already_claimed`);
    }
  }

  // 2. Read the email for an UNCLAIMED lead too, via its OWN step.
  //
  // The obvious move is to drop `email_card`'s `when claimed_agent notEquals
  // none`, and it is wrong: the late-retry ladder gates on
  // `contact_status equals missing`, and that gate is only a claim gate
  // BECAUSE email_card never ran for unclaimed leads. Ungating it would walk
  // unclaimed leads into `late` / `late2`, where every delivery step addresses
  // {{vars.claimed_agent_phone}} and there is no claimer (Bugbot, #1324).
  //
  // So the existing ladder keeps its shape untouched and the unclaimed case
  // gets a step of its own, copying email_card's connection and matching so
  // the two cannot drift apart.
  const emailCard = need("email_card");
  if (!findStep(steps, "unclaimed_email_read")) {
    const at = steps.findIndex((s) => s.id === "email_card");
    if (at < 0) throw new Error(`${FLOW_NAME}: step "email_card" is not top level`);
    steps.splice(at + 1, 0, {
      id: "unclaimed_email_read",
      type: "email_extract",
      connectionId: emailCard.connectionId,
      ...(emailCard.fromContains ? { fromContains: emailCard.fromContains } : {}),
      ...(emailCard.matchTemplates ? { matchTemplates: emailCard.matchTemplates } : {}),
      ...(emailCard.lookbackMinutes ? { lookbackMinutes: emailCard.lookbackMinutes } : {}),
      // Never overwrite something an earlier read already found.
      fillOnlyEmpty: true,
      fields: [...readFieldsFor("u1_status")],
      when: { var: "claimed_agent", equals: "none" }
    });
    touched.push("unclaimed_email_read inserted");
  }

  // 3. Price, timeframe and the full client-details block, on every read.
  for (const id of ["email_card", "late_read", "late2_read"]) {
    if (addFields(need(id), EMAIL_FIELDS)) touched.push(`${id}.fields`);
  }

  // 4. Put the newly revealed detail in front of whoever should see it.
  const priceLine =
    "\nPrice: {{vars.email_price}}\nTimeframe: {{vars.email_timeframe}}";
  for (const id of ["to_agent", "late_to_agent", "late2_to_agent"]) {
    const step = need(id);
    const body = step.body;
    if (typeof body !== "string") throw new Error(`${FLOW_NAME}: step "${id}" has no body`);
    if (!body.includes("{{vars.email_price}}")) {
      step.body = body + priceLine;
      touched.push(`${id}.body`);
    }
  }

  // Amy's own copy carries the whole client-details block, which is the
  // "screenshot the entire email" ask in the form the engine can actually
  // deliver: text, in her inbox, searchable.
  const qt = need("qt_email");
  const qtBody = qt.body;
  if (typeof qtBody !== "string") throw new Error(`${FLOW_NAME}: step "qt_email" has no body`);
  if (!qtBody.includes("{{vars.email_summary}}")) {
    qt.body =
      qtBody +
      "\n\nWhat HomeLight revealed in the email:\n{{vars.email_summary}}" +
      "\nExact price: {{vars.email_price}}\nTimeframe: {{vars.email_timeframe}}";
    touched.push("qt_email.body");
  }

  // 5. An unclaimed lead whose details just arrived must reach SOMEONE.
  //    notify_lead_owner resolves the contact's owner at run time and, with no
  //    owner, alerts the team instead of the business owner alone. Inserted
  //    after the late reads so it fires on the path where details arrive after
  //    the claim window has already lapsed.
  if (!findStep(steps, "late_unclaimed_alert")) {
    const at = steps.findIndex((s) => s.id === "late2");
    if (at < 0) throw new Error(`${FLOW_NAME}: step "late2" is missing; cannot place the alert`);
    /**
     * The unclaimed tail: alert as soon as the details land, and only keep
     * waiting while they have not.
     *
     * WHY RETRIES AT ALL: HomeLight's reveal email is DELAYED, which is the
     * entire reason the claimed path has late rungs. Those gate on
     * `contact_status`, which only the claimed read sets, so they never run for
     * an unclaimed lead: a single read finds nothing and nothing looks again.
     * Amy: "sometimes there is a delay so they have to check more than once."
     *
     * WHY EACH RUNG IS GATED: sleeping unconditionally before testing made the
     * team wait the full 75 minutes even when the FIRST read already had the
     * number. The claimed ladder waits only while details are missing and
     * delivers the moment a read finds them; this now does the same. A found
     * status skips every later wait, read and duplicate alert, because their
     * guards are unmet.
     *
     * WHY NESTED IN ONE BRANCH: definitions cap TOP-LEVEL steps at 30 and this
     * flow is near it, so seven flat steps were rejected by the validator
     * before anything was written. Nested steps cost one.
     */
    const alert = (id: string, statusVar: string): AnyStep => ({
      id,
      type: "notify_lead_owner",
      phoneVar: "lead_phone",
      nameVar: "lead_name",
      message:
        "HomeLight just revealed {{vars.lead_first_name}}'s details: {{vars.lead_name}} " +
        "{{vars.lead_phone}} {{vars.lead_email}}\nAddress: {{vars.lead_address}}\n" +
        "Price: {{vars.email_price}}\nTimeframe: {{vars.email_timeframe}}\n" +
        "Nobody has claimed this one yet.",
      unownedFallback: "team",
      when: { var: statusVar, equals: "found" }
    });
    const rung = (n: number, minutes: number, lookback: number, prev: string): AnyStep[] => [
      { id: `unclaimed_wait_${n}`, type: "sleep", minutes, when: { var: prev, equals: "missing" } },
      {
        id: `unclaimed_email_read_${n}`,
        type: "email_extract",
        connectionId: emailCard.connectionId,
        ...(emailCard.fromContains ? { fromContains: emailCard.fromContains } : {}),
        ...(emailCard.matchTemplates ? { matchTemplates: emailCard.matchTemplates } : {}),
        lookbackMinutes: lookback,
        // Fills only what is still missing, so the first read to succeed wins.
        fillOnlyEmpty: true,
        fields: readFieldsFor(`u${n}_status`),
        when: { var: prev, equals: "missing" }
      },
      alert(`late_unclaimed_alert_${n}`, `u${n}_status`)
    ];
    steps.splice(at + 1, 0, {
      id: "late_unclaimed",
      type: "branch",
      question: "Nobody claimed it: watch for HomeLight's reveal?",
      branches: [
        {
          id: "late_unclaimed_go",
          label: "Still unclaimed, deliver the details as soon as they land",
          condition: { var: "claimed_agent", equals: "none" },
          steps: [
            // The early read may already have them: say so immediately.
            alert("late_unclaimed_alert", "u1_status"),
            ...rung(2, 15, 120, "u1_status"),
            ...rung(3, 60, 240, "u2_status")
          ]
        }
      ],
      else: []
    });
    touched.push("late_unclaimed (short-circuiting retry ladder) inserted");
  }

  // 6. Say WHY nothing is coming when the transfer never connected. HomeLight
  //    reveals details only after a successful transfer or connected call, so
  //    "still waiting" is misleading once the call never happened.
  const never = need("late2_never_agent");
  const neverBody = never.body;
  if (typeof neverBody === "string" && !neverBody.includes("only releases contact details")) {
    never.body =
      neverBody +
      "\nHomeLight only releases contact details after a successful live transfer " +
      "or a connected call, so if the seller hung up before connecting, none are coming.";
    touched.push("late2_never_agent.body");
  }

  def.steps = steps;
  return { changed: touched.length > 0, touched };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
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
    console.error(`Flow "${FLOW_NAME}" not found on ${businessId}`);
    process.exit(2);
  }
  const row = data as { id: string; definition: Definition };

  if (isRevert) {
    const { data: rows, error: lErr } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", basename(SCRIPT))
      .order("applied_at", { ascending: false });
    if (lErr) {
      console.error(`Ledger read failed: ${lErr.message}`);
      process.exit(1);
    }
    const prev = ((rows ?? []) as Array<{ details: Record<string, unknown> | null }>)
      .map((r) => r.details)
      .find((d) => d && d.reverted !== true && d.previous_definition);
    if (!prev) {
      console.error("No applied ledger row with a previous_definition to revert to.");
      process.exit(2);
    }
    console.log(`revert ${FLOW_NAME} to ${(prev.previous_definition as Definition).steps?.length} steps`);
    if (!apply) {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
      return;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: prev.previous_definition })
      .eq("id", row.id);
    if (upErr) {
      console.error(`Revert failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: { flow_id: row.id, flow_name: FLOW_NAME, reverted: true }
    });
    return;
  }

  const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
  const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
  let result: PatchResult;
  try {
    result = patchHomeLight(def);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (!result.changed) {
    console.log(`${FLOW_NAME}: already delivers the details, nothing to do.`);
    return;
  }
  try {
    parseAiFlowDefinition(def);
  } catch (e) {
    console.error(`${FLOW_NAME} would become INVALID, aborting before any write:`);
    if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
    else console.error(e);
    process.exit(2);
  }
  console.log(`${FLOW_NAME}: ${previous.steps?.length} -> ${def.steps?.length} steps`);
  for (const t of result.touched) console.log(`  - ${t}`);
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flow_id: row.id,
      flow_name: FLOW_NAME,
      touched: result.touched,
      previous_definition: previous
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
