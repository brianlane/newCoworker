#!/usr/bin/env tsx
/**
 * One-shot: stop Realtor.com lead re-triggers + make $1M+ alerts unmissable.
 *
 * Incident (Jennifer Phillips, Jul 19 2026): a $1.75M Realtor.com lead was
 * correctly kept for the owner, but the lead's REPLY relayed by realtor.com
 * ("New text reply from …" + a fresh rltr.pro link) re-matched the flow's
 * lone `contains rltr.pro` condition, enrolled a second run with no
 * price/phone extracted, and routed the lead to the team.
 *
 * Four idempotent edits for one business (default: Amy's):
 *   1. "Realtor.com Lead" trigger: add a regex condition so only genuine
 *      inquiry notifications ("New inquiry:" / "Repeat inquiry:") enroll —
 *      reply relays no longer start lead runs.
 *   2. "Realtor.com Lead" options: set dedupeLeadRuns=true so a repeat
 *      inquiry for the same person+property with a non-failed prior run is
 *      canceled by the worker before any send (engine support shipped with
 *      this script — deploy the ai-flow-worker BEFORE running --apply).
 *   3. Seed "Realtor.com Reply — forward to lead owner": a flow that opens
 *      the relay's rltr.pro link in a credentialed browser session (the
 *      stored "Realtor.com" integration — the relay SMS always truncates the
 *      message), extracts the lead's FULL reply, and forwards it to whoever
 *      the lead belongs to: the teammate who claimed it (contact owner),
 *      else the business owner (Jennifer's $1M+ owner-direct case).
 *   4. Wrap EVERY ownerDirectTemplate (the $1M+ keep-for-owner SMS across
 *      all lead flows) in a full row of '*' above and below the body so the
 *      high-value alert stands out from routine [AiFlow] notifications, and
 *      set ownerDirectNudges so an unacknowledged alert re-fires as ALL-CAPS
 *      reminders at 10 and 30 minutes until the owner replies "1".
 *
 * Validates each patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/realtor-retrigger-guard.ts            # dry run
 *   npx tsx scripts/oneshot/realtor-retrigger-guard.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

export const LEAD_FLOW_NAME = "Realtor.com Lead";
export const REPLY_FLOW_NAME = "Realtor.com Reply — forward to lead owner";

/** Amy's stored credentialed-browse integration for realtor.com pages. */
export const REALTOR_INTEGRATION_LABEL = "Realtor.com";

/**
 * Only genuine inquiry notifications enroll the lead flow. realtor.com's
 * relay texts open with "New inquiry:" / "Repeat inquiry:" for leads and
 * "New text reply from …" for conversation replies — the latter must never
 * start a lead run (it carries no price/phone, so it re-routes the lead).
 */
export const INQUIRY_REGEX = "(new|repeat) inquiry:";

type Condition = { type?: string; value?: string; caseInsensitive?: boolean };
type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  ownerDirectTemplate?: unknown;
  ownerDirectNudges?: unknown;
  steps?: unknown;
};
type Definition = {
  steps?: Step[];
  trigger?: { conditions?: Condition[] } & Record<string, unknown>;
  options?: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Edit 1+2: tighten the lead flow's trigger to inquiry notifications and
 * opt it into the worker's post-extraction lead-dedupe gate. Pure and
 * idempotent (second run returns false).
 */
export function addRetriggerGuard(def: Definition): boolean {
  let changed = false;
  const conditions = def.trigger?.conditions;
  if (Array.isArray(conditions)) {
    const hasInquiryRegex = conditions.some(
      (c) => c.type === "regex" && c.value === INQUIRY_REGEX
    );
    if (!hasInquiryRegex) {
      conditions.push({ type: "regex", value: INQUIRY_REGEX, caseInsensitive: true });
      changed = true;
    }
  }
  if (def.options?.dedupeLeadRuns !== true) {
    def.options = { ...def.options, dedupeLeadRuns: true };
    changed = true;
  }
  return changed;
}

/** A full SMS-width row of asterisks framing the $1M+ owner alert. */
export const STAR_ROW = "****************";

/** First line is already an asterisk row (4+ stars) → don't wrap again. */
function startsWithStarRow(template: string): boolean {
  return /^\*{4,}\s*(\n|$)/.test(template.trimStart());
}

/**
 * Edit 4: on every route_to_team with a keep-for-owner rule (any nesting
 * depth) — wrap ownerDirectTemplate in a row of '*' above and below, and
 * set ownerDirectNudges (the worker's 10/30-minute ALL-CAPS reminders,
 * acked by the owner replying "1"). Idempotent: an already-wrapped template
 * is left byte-identical, so re-runs and later manual tweaks inside the
 * frame survive.
 */
export function hardenOwnerDirectAlerts(def: Definition): boolean {
  let changed = false;
  const visit = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps as Step[]) {
      if (
        step.type === "route_to_team" &&
        typeof step.ownerDirectTemplate === "string" &&
        step.ownerDirectTemplate.trim().length > 0
      ) {
        if (!startsWithStarRow(step.ownerDirectTemplate)) {
          step.ownerDirectTemplate = `${STAR_ROW}\n${step.ownerDirectTemplate.trim()}\n${STAR_ROW}`;
          changed = true;
        }
        if (step.ownerDirectNudges !== true) {
          step.ownerDirectNudges = true;
          changed = true;
        }
      }
      // Branch arms nest steps: { branches: [{ steps: [...] }], else: [...] }.
      if (Array.isArray(step.branches)) {
        for (const arm of step.branches as Array<{ steps?: unknown }>) visit(arm?.steps);
      }
      visit(step.else);
      visit(step.steps);
    }
  };
  visit(def.steps);
  return changed;
}

/**
 * Edit 3: the reply-forward flow seeded alongside the tightened trigger.
 * "New text reply from" + a rltr.pro link = a lead replying through
 * realtor.com. The relay ALWAYS truncates the message, so the flow opens
 * the rltr.pro conversation link in a credentialed browser session (the
 * stored "Realtor.com" integration handles login when the page demands it)
 * and reads the lead's complete reply plus their contact details — then
 * notify_lead_owner forwards it to whoever the lead BELONGS to: the
 * teammate who claimed it (contacts.owner_employee_id), else the business
 * owner (the $1M+ owner-direct case). suppressDefaultReply keeps the AI
 * assistant from also answering the relay text; if the browse/extraction
 * comes up empty the forward still goes out with the relay text (the
 * truncated version beats silence).
 */
export function replyForwardDefinition(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      conditions: [
        { type: "contains", value: "rltr.pro", caseInsensitive: true },
        { type: "contains", value: "New text reply from", caseInsensitive: true }
      ],
      correlationWindowMinutes: 1
    },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [
          {
            name: "lead_name",
            description:
              'The full name of the person who replied — the name right after "New text reply from"'
          }
        ]
      },
      { id: "s2", type: "extract_url", saveAs: "reply_url" },
      {
        id: "s3",
        type: "browse_extract",
        urlVar: "reply_url",
        auth: { integrationLabel: REALTOR_INTEGRATION_LABEL },
        fields: [
          {
            name: "full_message",
            description:
              "The complete text of the lead's newest reply message(s) in the conversation — " +
              "every message from the lead that the notification was about, in full, not truncated"
          },
          {
            name: "lead_phone",
            description:
              "The lead's phone number shown anywhere on the page (contact details or profile); empty if not shown"
          }
        ]
      },
      {
        id: "s4",
        type: "notify_lead_owner",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        message:
          "Realtor.com: {{vars.lead_name}} replied — full message:\n" +
          "{{vars.full_message}}\n" +
          "Respond via realtor.com: {{vars.reply_url}}\n" +
          "Original notification: {{trigger.windowText}}"
      }
    ],
    options: { suppressDefaultReply: true }
  };
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
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const flows = (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>;

  // Pass 1: patch + validate EVERY flow in memory before writing ANY, so an
  // invalid later flow can never leave the tenant half-patched.
  const pending: Array<{ id: string; name: string; def: Definition }> = [];
  for (const row of flows) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let changed = false;
    if (row.name.trim().toLowerCase() === LEAD_FLOW_NAME.toLowerCase()) {
      changed = addRetriggerGuard(def);
    }
    if (hardenOwnerDirectAlerts(def)) changed = true;
    if (!changed) continue;

    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(
        `\nFlow "${row.name}" (${row.id}) would become INVALID — aborting before any write:`
      );
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    console.log(`\n=== ${row.name} (${row.id}) ===`);
    console.log(`  AFTER: ${JSON.stringify(def)}`);
    pending.push({ id: row.id, name: row.name, def });
  }

  // The reply-forward flow: seed only when absent (name-keyed idempotency).
  const replyFlowExists = flows.some(
    (f) => f.name.trim().toLowerCase() === REPLY_FLOW_NAME.toLowerCase()
  );
  let replyDef: Record<string, unknown> | null = null;
  if (!replyFlowExists) {
    replyDef = replyForwardDefinition();
    try {
      parseAiFlowDefinition(replyDef);
    } catch (err) {
      console.error("Reply-forward seed definition is INVALID — aborting:");
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }
    console.log(`\n=== ${REPLY_FLOW_NAME} (new) ===`);
    console.log(`  SEED: ${JSON.stringify(replyDef)}`);
  }

  // Pass 2: write.
  const patched: Array<{ id: string; name: string }> = [];
  if (args.apply) {
    for (const p of pending) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: p.def })
        .eq("id", p.id);
      if (upErr) {
        console.error(`Update failed for ${p.id}: ${upErr.message}`);
        console.error(
          patched.length > 0
            ? `Already written before the failure: ${patched.map((x) => x.name).join(", ")} — re-run after fixing; the patcher is idempotent.`
            : "Nothing had been written yet."
        );
        process.exit(1);
      }
      console.log(`  -> updated ${p.name}.`);
      patched.push({ id: p.id, name: p.name });
    }
    if (replyDef) {
      const { data: inserted, error: insErr } = await db
        .from("ai_flows")
        .insert({
          business_id: businessId,
          name: REPLY_FLOW_NAME,
          enabled: true,
          definition: replyDef
        })
        .select("id")
        .single();
      if (insErr) {
        console.error(`Reply-forward flow insert failed: ${insErr.message}`);
        process.exit(1);
      }
      const newId = (inserted as { id: string }).id;
      console.log(`  -> seeded ${REPLY_FLOW_NAME} (${newId}).`);
      patched.push({ id: newId, name: REPLY_FLOW_NAME });
    }
  }

  const changedCount = pending.length + (replyDef ? 1 : 0);
  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already patched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
  if (args.apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "realtor-retrigger-guard.ts",
      businessId,
      details: { patched }
    });
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
