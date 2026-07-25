#!/usr/bin/env tsx
/**
 * One-shot: get HomeLight's LATE client contact details to whoever claimed the
 * lead, and stop texting out referrals HomeLight already gave away.
 *
 * Incident (Salma A., Jul 25 2026, run d8935e28): Dave claimed a HomeLight
 * referral and was texted "HomeLight lead is yours: Salma A. none". Two causes,
 * both visible in the captured page source:
 *   1. The referral page NEVER carries the client's contact info. The only phone
 *      on it is the agent's own cell ("We will call you at Amy's Cell ..."), so
 *      the post-claim browse can't produce a phone/email/street address; the
 *      "address" it returned was just the city. The contact details arrive by
 *      EMAIL, and that email had not landed yet when the flow looked (the
 *      owner's words: "sometimes there's a late delay for the contact info").
 *      Nothing ever looked again: the flow's only retry is nested in the
 *      bad-phone branch and needs the agent to report a bad number first.
 *   2. The same read returned "Salma was already claimed by another agent" and
 *      the flow sailed past it, so the claim-confirmation text went out for a
 *      referral that was gone.
 *
 * Five idempotent edits to ONE flow (Amy's "HomeLight Referral"). It stays one
 * flow deliberately: only the referral run knows WHO claimed the lead
 * ({{vars.claimed_agent_phone}}), and a second, email-triggered flow could
 * neither resolve the claimer (the engine's identity lookup keys on the
 * extracted lead phone/email, which is exactly what is missing here) nor see
 * that this run had already texted them.
 *
 *   1. `contact_status` sentinel on the `email_card` step: "found"/"missing",
 *      the gate for retry rung 1. A sentinel is REQUIRED because "the phone is
 *      missing" cannot be written as a `when` guard: whenSchema takes exactly
 *      one of equals/contains/notEquals, all min(1), and a missing phone lands
 *      as the empty string, which slips past `notEquals: "none"`.
 *   2. `already_claimed` sentinel on the `card` step ("yes"/"no").
 *   3. Retry rung 1, inserted after `notify_unclaimed`: when the details were
 *      still missing, sleep 10 minutes, re-read the mailbox, and on success
 *      file the contact, text the CLAIMER, notify the owner, and send the lead
 *      the intro SMS + email that were skipped for want of a phone.
 *   4. Retry rung 2, appended after `bp_branch` (so it runs AFTER the existing
 *      ~60-minute agent-report wait, adding no new dead time): same shape with
 *      a 60-minute sleep, and if the details STILL never arrived, say so to the
 *      claimer and the owner instead of going quiet.
 *   5. Wrap the six post-claim send steps in an already-claimed guard, and drop
 *      the dead "Direct claim button:" offer line (the claim control is a
 *      <button>, so extractLinks never had an href to capture and the line has
 *      always rendered empty).
 *
 * Each rung writes a FRESH sentinel var (`late_contact_status`, then
 * `late2_contact_status`): `fillOnlyEmpty` keeps a non-empty prior value and
 * "missing" does not count as empty, so a reused sentinel would stay stale
 * forever and rung 2 would never fire.
 *
 * Validates the patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-late-contact-retry.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-late-contact-retry.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
 *           HOMELIGHT_RETRY_1_MINUTES (default 10)
 *           HOMELIGHT_RETRY_2_MINUTES (default 60)
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
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

export type BranchArm = Record<string, unknown> & { steps?: unknown };
export type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Array<{ name?: string; description?: string }>;
  branches?: BranchArm[];
  else?: unknown;
  steps?: unknown;
};
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Step ids this patch reads or moves. */
export const CARD_STEP_ID = "card";
export const EMAIL_CARD_STEP_ID = "email_card";
export const ROUTE_STEP_ID = "route";
export const OPEN_STEP_ID = "open";
export const NOTIFY_UNCLAIMED_STEP_ID = "notify_unclaimed";
export const LEAD_SMS_STEP_ID = "lead_sms";
export const LEAD_EMAIL_STEP_ID = "lead_email";

/** The post-claim sends that must not fire for a referral HomeLight reassigned. */
export const GUARDED_SEND_IDS = [
  "save_contact",
  "to_agent",
  "qt_email",
  LEAD_SMS_STEP_ID,
  LEAD_EMAIL_STEP_ID,
  "notify"
] as const;

export const LOST_BRANCH_ID = "lost_branch";
export const RUNG_1_BRANCH_ID = "late";
export const RUNG_2_BRANCH_ID = "late2";

/** Sentinel var names. Deliberately not phone-ish: isPhoneFieldName would
 *  otherwise run the extracted "found"/"missing" through the phone sanitizer
 *  and turn it into "none". */
export const CONTACT_STATUS_VAR = "contact_status";
export const RUNG_1_STATUS_VAR = "late_contact_status";
export const RUNG_2_STATUS_VAR = "late2_contact_status";
export const ALREADY_CLAIMED_VAR = "already_claimed";
/**
 * Set to "1" by rung 1 when it ran and did NOT come away with the details.
 *
 * Rung 2 cannot gate on rung 1's sentinel alone, because the sentinel is UNSET
 * in two opposite cases: rung 1 never ran (the details arrived on the first
 * pass, so rung 2 must stay away) and rung 1's mailbox lookup matched nothing
 * (so rung 2 must run). `when` carries one condition, so rung 1 records the
 * distinction explicitly instead.
 */
export const RUNG_1_UNRESOLVED_VAR = "late_unresolved";

const CONTACT_STATUS_FIELD = {
  name: CONTACT_STATUS_VAR,
  description:
    "Answer exactly one lowercase word: found if this email lists the CLIENT's own " +
    "phone number, missing if it does not. Never count the agent's own number or a " +
    "HomeLight support number."
};

const ALREADY_CLAIMED_FIELD = {
  name: ALREADY_CLAIMED_VAR,
  description:
    "Answer exactly one lowercase word: yes if the page says this referral was " +
    "already claimed by another agent or is no longer available to claim, no otherwise."
};

/** Walk the trunk and every nested arm, yielding each step. */
function walkSteps(steps: unknown, visit: (step: Step) => void): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    visit(step);
    if (Array.isArray(step.branches)) {
      for (const arm of step.branches) walkSteps(arm?.steps, visit);
    }
    walkSteps(step.else, visit);
    walkSteps(step.steps, visit);
  }
}

/** Find a step by id anywhere in the definition (trunk or nested arm). */
export function findStep(def: Definition, id: string): Step | null {
  let found: Step | null = null;
  walkSteps(def.steps, (step) => {
    if (found === null && step.id === id) found = step;
  });
  return found;
}

/** Index of a TRUNK step by id, or -1. */
function trunkIndex(def: Definition, id: string): number {
  return (def.steps ?? []).findIndex((s) => s.id === id);
}

function hasField(step: Step, name: string): boolean {
  return (step.fields ?? []).some((f) => f?.name === name);
}

/**
 * Edit 1+2: add the two extraction sentinels the gates below read. Pure and
 * idempotent (a second run returns false). Throws when the flow does not have
 * the expected steps, so a renamed/rebuilt flow fails loudly instead of being
 * half-patched.
 */
export function addSentinels(def: Definition): boolean {
  let changed = false;
  const emailCard = findStep(def, EMAIL_CARD_STEP_ID);
  if (!emailCard) throw new Error(`step "${EMAIL_CARD_STEP_ID}" not found`);
  if (!hasField(emailCard, CONTACT_STATUS_VAR)) {
    emailCard.fields = [...(emailCard.fields ?? []), { ...CONTACT_STATUS_FIELD }];
    changed = true;
  }
  const card = findStep(def, CARD_STEP_ID);
  if (!card) throw new Error(`step "${CARD_STEP_ID}" not found`);
  if (!hasField(card, ALREADY_CLAIMED_VAR)) {
    card.fields = [...(card.fields ?? []), { ...ALREADY_CLAIMED_FIELD }];
    changed = true;
  }
  return changed;
}

/** `when` guard: the named sentinel says the details arrived. */
function foundWhen(statusVar: string): Record<string, unknown> {
  return { var: statusVar, equals: "found" };
}

const CLAIMED_WHEN = { var: "claimed_agent", notEquals: "none" } as const;

/**
 * Clone the lead-facing intro send (`lead_sms` / `lead_email`) under a new id
 * and gate, so a rung re-sends the owner's EXACT marketing copy instead of a
 * drifting second version of it.
 */
function cloneLeadSend(
  def: Definition,
  sourceId: string,
  newId: string,
  statusVar: string
): Step {
  const source = findStep(def, sourceId);
  if (!source) throw new Error(`step "${sourceId}" not found`);
  return { ...JSON.parse(JSON.stringify(source)), id: newId, when: foundWhen(statusVar) };
}

/** The mailbox read a rung performs, reusing the flow's own email_card config. */
function rungRead(def: Definition, id: string, statusVar: string, lookbackMinutes: number): Step {
  const emailCard = findStep(def, EMAIL_CARD_STEP_ID);
  if (!emailCard) throw new Error(`step "${EMAIL_CARD_STEP_ID}" not found`);
  const connectionId = emailCard.connectionId;
  if (typeof connectionId !== "string" || !connectionId) {
    throw new Error(`step "${EMAIL_CARD_STEP_ID}" has no connectionId to reuse`);
  }
  return {
    id,
    type: "email_extract",
    connectionId,
    fromContains: typeof emailCard.fromContains === "string" ? emailCard.fromContains : "homelight.com",
    matchTemplates: Array.isArray(emailCard.matchTemplates)
      ? emailCard.matchTemplates
      : ["{{vars.lead_first_name}}"],
    lookbackMinutes,
    // The browse/first-pass values still win; this only backfills the gaps.
    fillOnlyEmpty: true,
    fields: [
      {
        name: "lead_phone",
        description: "The lead's phone number, labeled 'Phone' in the HomeLight email"
      },
      {
        name: "lead_email",
        description: "The lead's email, labeled 'Email' in the HomeLight email, or 'none'"
      },
      {
        name: "lead_address",
        description:
          "The property street address, labeled 'Address' in the HomeLight email, the " +
          "FULL address including street, city, state, and ZIP code"
      },
      { ...CONTACT_STATUS_FIELD, name: statusVar }
    ]
  };
}

/** The delivery steps a rung runs once the details finally arrive. */
function rungDelivery(def: Definition, prefix: string, statusVar: string): Step[] {
  const when = foundWhen(statusVar);
  return [
    {
      id: `${prefix}_save`,
      type: "upsert_customer",
      when,
      phoneVar: "lead_phone",
      nameVar: "lead_name",
      emailVar: "lead_email"
    },
    {
      id: `${prefix}_to_agent`,
      type: "send_sms",
      to: "{{vars.claimed_agent_phone}}",
      when,
      body:
        "HomeLight just sent {{vars.lead_first_name}}'s contact info: " +
        "{{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\n" +
        "Address: {{vars.lead_address}}\n" +
        "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}})"
    },
    {
      id: `${prefix}_notify`,
      type: "notify_owner",
      when,
      message:
        "HomeLight sent {{vars.lead_first_name}}'s contact info after the claim and it " +
        "went to {{vars.claimed_agent}}.\n" +
        "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
        "Address: {{vars.lead_address}}"
    },
    cloneLeadSend(def, LEAD_SMS_STEP_ID, `${prefix}_lead_sms`, statusVar),
    cloneLeadSend(def, LEAD_EMAIL_STEP_ID, `${prefix}_lead_email`, statusVar)
  ];
}

/**
 * A retry rung: "still ours?" on the outside, "details still missing?" inside.
 *
 * Both gates are REQUIRED and `when` carries exactly one condition, so the AND
 * has to be structural. Without the outer gate a referral HomeLight reassigned
 * would still retry: `email_card` is claim-gated, not already-claimed-gated, so
 * it reports `missing` for a lead that is no longer ours and the rung would
 * text the claimer (and the lead) about someone else's referral, undoing the
 * whole point of the lost-referral guard.
 *
 * Mirrors the nesting the flow's own `bp_branch` already uses (trunk branch,
 * one nested branch, then steps), so it stays inside MAX_BRANCH_DEPTH.
 */
function rungBranch(args: {
  id: string;
  outerQuestion: string;
  innerId: string;
  innerQuestion: string;
  innerLabel: string;
  innerCondition: Record<string, unknown>;
  steps: Step[];
}): Step {
  return {
    id: args.id,
    type: "branch",
    question: args.outerQuestion,
    branches: [
      {
        id: `${args.id}_still_ours`,
        label: "Still ours",
        // notEquals "yes" so an UNSET var still passes: an unclaimed referral
        // never runs `card`, and the inner sentinel gate stops it there.
        condition: { var: ALREADY_CLAIMED_VAR, notEquals: "yes" },
        steps: [
          {
            id: args.innerId,
            type: "branch",
            question: args.innerQuestion,
            branches: [
              {
                id: `${args.innerId}_hit`,
                label: args.innerLabel,
                condition: args.innerCondition,
                steps: args.steps
              }
            ],
            else: []
          }
        ]
      }
    ],
    else: []
  };
}

/**
 * Edit 3: retry rung 1, a single trunk branch inserted after
 * `notify_unclaimed`. The inner sentinel gate doubles as the claim gate: only a
 * CLAIMED lead ever runs `email_card`, so `contact_status` is unset (and the
 * arm untaken) for an unclaimed one. Pure and idempotent.
 */
export function addRung1(def: Definition, sleepMinutes: number): boolean {
  if (findStep(def, RUNG_1_BRANCH_ID)) return false;
  const at = trunkIndex(def, NOTIFY_UNCLAIMED_STEP_ID);
  if (at === -1) throw new Error(`trunk step "${NOTIFY_UNCLAIMED_STEP_ID}" not found`);
  const branch = rungBranch({
    id: RUNG_1_BRANCH_ID,
    outerQuestion: "Is this referral still ours?",
    innerId: "late_missing",
    innerQuestion: "Did HomeLight send the client contact details yet?",
    innerLabel: "Contact details still missing",
    innerCondition: { var: CONTACT_STATUS_VAR, equals: "missing" },
    steps: [
      { id: "late_wait", type: "sleep", minutes: sleepMinutes },
      rungRead(def, "late_read", RUNG_1_STATUS_VAR, 90),
      // "Rung 1 ran and still does not have the details." notEquals catches
      // BOTH a "missing" sentinel and an UNSET one (no mailbox message matched
      // at all, where email_extract writes nothing).
      {
        id: "late_unresolved",
        type: "math",
        operation: "add",
        left: "1",
        right: "0",
        saveAs: RUNG_1_UNRESOLVED_VAR,
        when: { var: RUNG_1_STATUS_VAR, notEquals: "found" }
      },
      ...rungDelivery(def, "late", RUNG_1_STATUS_VAR)
    ]
  });
  const steps = [...(def.steps ?? [])];
  steps.splice(at + 1, 0, branch);
  def.steps = steps;
  return true;
}

/**
 * Edit 4: retry rung 2, appended after the existing agent-report block so it
 * costs no extra dead time (the run has already waited ~60 minutes there).
 * Gated on rung 1's explicit "ran and still unresolved" marker, so a lead whose
 * details arrived on the first pass never re-reads the mailbox (which would
 * duplicate every send) while a rung 1 whose lookup matched nothing still
 * escalates here. Pure and idempotent.
 */
export function addRung2(def: Definition, sleepMinutes: number): boolean {
  if (findStep(def, RUNG_2_BRANCH_ID)) return false;
  // notEquals, so a lookup that matched NO message (sentinel unwritten) still
  // reports the outcome instead of going quiet. The delivery steps use the
  // opposite (`equals "found"`), so an unset sentinel never sends anything.
  const missing = { var: RUNG_2_STATUS_VAR, notEquals: "found" };
  const branch = rungBranch({
    id: RUNG_2_BRANCH_ID,
    outerQuestion: "Is this referral still ours?",
    innerId: "late2_missing",
    innerQuestion: "Did the client contact details ever arrive?",
    innerLabel: "Still missing after the first retry",
    innerCondition: { var: RUNG_1_UNRESOLVED_VAR, equals: "1" },
    steps: [
      { id: "late2_wait", type: "sleep", minutes: sleepMinutes },
      rungRead(def, "late2_read", RUNG_2_STATUS_VAR, 240),
      ...rungDelivery(def, "late2", RUNG_2_STATUS_VAR),
      {
        id: "late2_never_agent",
        type: "send_sms",
        to: "{{vars.claimed_agent_phone}}",
        when: missing,
        body:
          "HomeLight still has not sent {{vars.lead_first_name}}'s contact info " +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}). Nothing to call yet.\n" +
          "Check the portal: {{vars.leadUrl}}"
      },
      {
        id: "late2_never_notify",
        type: "notify_owner",
        when: missing,
        message:
          "HomeLight never sent {{vars.lead_first_name}}'s contact info " +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}), claimed by " +
          "{{vars.claimed_agent}}. No phone, email, or address arrived by email, so " +
          "no outreach went out.\nPortal: {{vars.leadUrl}}"
      }
    ]
  });
  def.steps = [...(def.steps ?? []), branch];
  return true;
}

/**
 * Edit 5a: wrap the post-claim sends in an already-claimed guard. `when` takes
 * exactly ONE condition, so the claim gate the steps already carry cannot also
 * test `already_claimed`; a branch is the only way to AND the two. The steps
 * move VERBATIM (each keeps its own claim gate), and the else arm tells the
 * claimer and the owner that HomeLight reassigned the referral rather than
 * ending the run silently the way skipWhenText would. Pure and idempotent.
 */
export function addAlreadyClaimedGuard(def: Definition): boolean {
  if (findStep(def, LOST_BRANCH_ID)) return false;
  const steps = [...(def.steps ?? [])];
  const guardedIds = new Set<string>(GUARDED_SEND_IDS);
  const guarded: Step[] = [];
  for (const id of GUARDED_SEND_IDS) {
    const at = steps.findIndex((s) => s.id === id);
    if (at === -1) throw new Error(`trunk step "${id}" not found`);
    guarded.push(steps[at]);
  }
  // Splice out the guarded steps, remembering where the first one sat.
  const insertAt = steps.findIndex((s) => s.id === GUARDED_SEND_IDS[0]);
  const remaining = steps.filter((s) => !guardedIds.has(String(s.id)));
  const branch: Step = {
    id: LOST_BRANCH_ID,
    type: "branch",
    question: "Is this referral still ours?",
    branches: [
      {
        id: "still_ours",
        label: "Still ours",
        // An unclaimed lead never runs `card`, so the var is unset and this
        // arm is taken; the steps inside then skip on their own claim gates.
        condition: { var: ALREADY_CLAIMED_VAR, notEquals: "yes" },
        steps: guarded
      }
    ],
    else: [
      {
        id: "lost_to_agent",
        type: "send_sms",
        to: "{{vars.claimed_agent_phone}}",
        when: { ...CLAIMED_WHEN },
        body:
          "Heads up: HomeLight had already given the {{vars.lead_first_name}} referral " +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}) to another agent, so " +
          "there is nothing to work. No contact details and nothing sent to them.\n" +
          "Portal: {{vars.leadUrl}}"
      },
      {
        id: "lost_notify",
        type: "notify_owner",
        when: { ...CLAIMED_WHEN },
        message:
          "HomeLight referral {{vars.lead_first_name}} ({{vars.lead_type}} in " +
          "{{vars.city}}, ~{{vars.price}}) was already claimed by another agent by the " +
          "time {{vars.claimed_agent}} took it. No contact details and no outreach.\n" +
          "Portal: {{vars.leadUrl}}"
      }
    ]
  };
  remaining.splice(insertAt, 0, branch);
  def.steps = remaining;
  return true;
}

/** The offer line that has always rendered empty (the claim control is a button). */
export const DEAD_CLAIM_LINE = "Direct claim button: {{vars.claim_link}}\n";

/**
 * Edit 5b: drop the dead claim-button line from the offer, and retire the
 * `extractLinks` capture that fed it. `browse_extract` needs at least one of
 * fields/extractLinks, and the step still exists for its screenshot (the offer
 * MMS), so the link capture is REPLACED by the already-claimed read, which is
 * useful there: it also runs for a referral nobody claims. Pure and idempotent.
 */
export function dropDeadClaimLink(def: Definition): boolean {
  let changed = false;
  const route = findStep(def, ROUTE_STEP_ID);
  if (!route) throw new Error(`step "${ROUTE_STEP_ID}" not found`);
  if (typeof route.offerTemplate === "string" && route.offerTemplate.includes(DEAD_CLAIM_LINE)) {
    route.offerTemplate = route.offerTemplate.split(DEAD_CLAIM_LINE).join("");
    changed = true;
  }
  const open = findStep(def, OPEN_STEP_ID);
  if (!open) throw new Error(`step "${OPEN_STEP_ID}" not found`);
  if (open.extractLinks !== undefined) {
    delete open.extractLinks;
    changed = true;
  }
  if (!hasField(open, ALREADY_CLAIMED_VAR)) {
    open.fields = [...(open.fields ?? []), { ...ALREADY_CLAIMED_FIELD }];
    changed = true;
  }
  return changed;
}

/**
 * Every edit, in the order they depend on each other: the sentinels first (the
 * rungs gate on them), then the rungs (they clone the lead-facing sends while
 * those are still on the trunk), then the guard (which moves those sends into
 * a branch arm), then the offer cleanup. Returns which edits changed anything.
 */
export function patchDefinition(
  def: Definition,
  opts: { rung1Minutes: number; rung2Minutes: number }
): string[] {
  const applied: string[] = [];
  if (addSentinels(def)) applied.push("sentinels");
  if (addRung1(def, opts.rung1Minutes)) applied.push("retry rung 1");
  if (addRung2(def, opts.rung2Minutes)) applied.push("retry rung 2");
  if (addAlreadyClaimedGuard(def)) applied.push("already-claimed guard");
  if (dropDeadClaimLink(def)) applied.push("dead claim-button line");
  return applied;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function positiveMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 43200) {
    console.error(`${name} must be an integer 1..43200`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const rung1Minutes = positiveMinutes("HOMELIGHT_RETRY_1_MINUTES", 10);
  const rung2Minutes = positiveMinutes("HOMELIGHT_RETRY_2_MINUTES", 60);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`Flow "${flowName}" not found for business ${businessId}.`);
    process.exit(2);
  }
  const flow = row as { id: string; name: string; definition: Definition };
  const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;

  let applied: string[];
  try {
    applied = patchDefinition(def, { rung1Minutes, rung2Minutes });
  } catch (err) {
    console.error(
      `Unexpected shape for "${flow.name}" (${flow.id}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "The flow was rebuilt or renamed; re-read it before patching."
    );
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Flow     : ${flow.name} (${flow.id})`);
  console.log(`Retries  : ${rung1Minutes} min, then ${rung2Minutes} min after the report wait`);
  if (applied.length === 0) {
    console.log("\nAlready patched, nothing to do.");
    return;
  }
  console.log(`Edits    : ${applied.join(", ")}`);

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`\nPatched "${flow.name}" would be INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`\nTrunk steps: ${(flow.definition.steps ?? []).length} -> ${(def.steps ?? []).length}`);
  console.log(`AFTER: ${JSON.stringify(def)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update failed for ${flow.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-late-contact-retry.ts",
    businessId,
    details: {
      flow_id: flow.id,
      flow_name: flow.name,
      edits: applied,
      rung1_minutes: rung1Minutes,
      rung2_minutes: rung2Minutes
    }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
