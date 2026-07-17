#!/usr/bin/env tsx
/**
 * One-shot: append the "employee reports a bad phone number" path to Amy's
 * four lead-routing AiFlows (Realtor.com Lead, ReferralExchange Lead,
 * HomeLight Referral, Clever Lead - Accept).
 *
 * After a route_to_team claim, the flow now parks a wait_for_reply on the
 * CLAIMING teammate's phone (engine var claimed_agent_phone) for the ETA they
 * stated plus one hour (claimed_agent_eta_minutes + 60, via a math step and
 * wait_for_reply.timeoutMinutesTemplate). Their next free text is classified:
 *
 *   - bad_phone_number → email Amy the full lead info + the report, and email
 *     the lead (Amy's existing intro copy, from her connected mailbox) asking
 *     for their best phone number. A nested branch on lead_email splits Amy's
 *     report: with an address on file it says the lead HAS been emailed; a
 *     lead with no email ("none"/empty) gets no outreach and Amy's report
 *     explicitly says NO follow-up email was sent.
 *   - anything else (incl. the "unclear" fallback) → forward the teammate's
 *     note to Amy via notify_owner, so no report disappears silently.
 *
 * Digit replies never reach the wait: "1"/"2"/"86" (and comma'd forms) are
 * consumed by the offer/unclaim machinery in telnyx-sms-inbound first.
 * Unclaimed / owner-direct / no-phone runs have claimed_agent_phone = "none",
 * which the wait planner resolves straight to the no_reply sentinel — no
 * park, classify and both branch arms skip, flows end exactly as before.
 *
 * Patches the existing rows in place (no re-seed) so manual edits are
 * preserved, and re-validates each modified definition through the SAME
 * parseAiFlowDefinition the dashboard uses before writing. Dry-run by
 * default; prints the before/after definition of each changed flow for
 * rollback. Idempotent, and re-running after a copy change UPGRADES the
 * bp_* steps in place (they are rebuilt, never duplicated).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/add-bad-phone-agent-report.ts            # dry run
 *   npx tsx scripts/oneshot/add-bad-phone-agent-report.ts --apply    # write
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

/** Amy's connected amy@amylaidlaw.com mailbox (already used by these flows). */
export const AMY_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";
export const AMY_EMAIL = "amy@amylaidlaw.com";

type Step = Record<string, unknown> & { id?: string; type?: string };
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/** The ask inserted into every lead-facing email. */
const BAD_PHONE_ASK =
  "We tried to give you a call, but the phone number we have on file doesn't " +
  "seem to be working. Could you reply with your best phone number so we can connect?";

const AMY_SIGNATURE = "Thanks,\nAmy Laidlaw ~ HomeSmart \u{1F60A}";

/** One lead-facing email inside the bad-phone branch arm. */
type LeadEmail = {
  id: string;
  subject: string;
  body: string;
  /** Optional single-condition gate (e.g. ReferralExchange lead_type). */
  when?: { var: string; equals: string };
};

export type FlowConfig = {
  flowName: string;
  /** Templated "who is this about" fragment for the Amy email + owner forward. */
  leadLabel: string;
  /** Lead-info lines for the Amy notification email (templated). */
  leadInfoLines: string;
  sourceLabel: string;
  leadEmails: LeadEmail[];
};

const REALTOR_PITCH =
  "I'm an excellent Bulldog negotiator and have it down to an Art form on how I " +
  "write offers and get them accepted in this market.\n\n" +
  "I'd love to help you. I'm licensed since 1989. One of the top agents in Arizona. " +
  "By the way, feel free to check out my real time up to the minute listings on my site below:\n\n" +
  "http://PhoenixAreasBestRealtor.com\n\n" +
  "I'll send you some Real Time Home listings & you'll be able to stay familiar with " +
  "the market trends and you will be 1st alerted if your favorite home hits the market " +
  "or comes back on the market! How many bedrooms, bathrooms, carport or garage stalls " +
  "preference and what cities are you interested in? Preference on whether it's updated " +
  "or not updated? Single story or any story Preferred? Preference on a pool?";

const RE_BUYER_PITCH =
  "I'm an excellent negotiator and have it down to an Art Form on how I negotiate " +
  "offers in this market.\n\n" +
  "I'm licensed since 1989. One of the top agents in Arizona. I am extremely " +
  "experienced. I'll keep you calm, well-informed while holding your hand and guiding " +
  "you every step of the way. Looking forward to Exceeding your Expectations. We're " +
  "here for you. We are willing to do video tours of homes for you to save you time. " +
  "By the way, feel free to check out my real time up to the minute listings on my site below:\n\n" +
  "http://PhoenixAreasBestRealtor.com";

const RE_SELLER_PITCH =
  "I'm an excellent negotiator and have it down to an Art Form on how I negotiate " +
  "offers and create bidding wars in this market for your home.\n\n" +
  "I'm licensed since 1989. One of the top agents in Arizona. I have an appraiser as " +
  "part of my team to help price your listing with precision from the start as well " +
  "as keeping buyers from lowballing you — reply with your best number today to claim " +
  "your FREE APPRAISAL!\n\n" +
  "I have a low flexible commission. My goal is to make sure you're happy with your " +
  "bottom line. I have your bottom line 1st in mind!";

export const FLOW_CONFIGS: FlowConfig[] = [
  {
    flowName: "Realtor.com Lead",
    leadLabel: "{{vars.lead_name}} ({{vars.lead_phone}})",
    leadInfoLines:
      "Name: {{vars.lead_name}}\n" +
      "Phone on file (bad): {{vars.lead_phone}}\n" +
      "Email: {{vars.lead_email}}\n" +
      "Address: {{vars.lead_address}}\n" +
      "Price: {{vars.lead_price_details}}\n" +
      "( {{vars.lead_url}} )",
    sourceLabel: "Realtor.com (realtor.com)",
    leadEmails: [
      {
        id: "bp_email_lead",
        subject: "Re: Your recent inquiry on Realtor.com",
        body:
          "Re: Your recent inquiry on Realtor.com for the home on {{vars.lead_address}}.\n\n" +
          `Hi {{vars.lead_first_name}}.\n\nThanks for reaching out. ${BAD_PHONE_ASK}\n\n` +
          `${REALTOR_PITCH}\n\n${AMY_SIGNATURE}`
      }
    ]
  },
  {
    flowName: "ReferralExchange Lead",
    leadLabel: "{{vars.lead_name}} ({{vars.lead_phone}})",
    leadInfoLines:
      "Name: {{vars.lead_name}}\n" +
      "Phone on file (bad): {{vars.lead_phone}}\n" +
      "Email: {{vars.lead_email}}\n" +
      "Location: {{vars.location}}\n" +
      "Price: {{vars.price}}\n" +
      "Lead type: {{vars.lead_type}}",
    sourceLabel: "{{vars.web_source}}",
    leadEmails: [
      {
        id: "bp_email_lead_buyer",
        when: { var: "lead_type", equals: "buyer" },
        subject: "Re: Your recent inquiry on RealEstateAgents.com",
        body:
          "Re: searching for a home & Your recent inquiry with RealEstateAgents.com\n\n" +
          `Hi {{vars.lead_name}}.\n\nI'd love to help you. ${BAD_PHONE_ASK}\n\n` +
          `${RE_BUYER_PITCH}\n\n${AMY_SIGNATURE}`
      },
      {
        id: "bp_email_lead_seller",
        when: { var: "lead_type", equals: "seller" },
        subject: "Re: Your recent inquiry on RealEstateAgents.com",
        body:
          "Hi {{vars.lead_name}}.\n\nRe: Your recent inquiry on RealEstateAgents.com\n\n" +
          `I'd love to help you sell your home. ${BAD_PHONE_ASK}\n\n` +
          `${RE_SELLER_PITCH}\n\n${AMY_SIGNATURE}`
      },
      {
        id: "bp_email_lead_both",
        when: { var: "lead_type", equals: "both" },
        subject: "Re: Your recent inquiry on RealEstateAgents.com",
        body:
          "Hi {{vars.lead_name}}.\n\nRe: Your recent inquiry on RealEstateAgents.com\n\n" +
          `Thank you for your inquiry! I would love to help you with your next real estate move. ${BAD_PHONE_ASK}\n\n` +
          `${RE_SELLER_PITCH}\n\n` +
          "When you are looking to buy: we do live video tours to save you time, and my site " +
          "http://PhoenixAreasBestRealtor.com has up-to-the-minute listings so you're first " +
          `to know when your favorite home hits the market.\n\n${AMY_SIGNATURE}`
      }
    ]
  },
  {
    flowName: "HomeLight Referral",
    leadLabel: "{{vars.lead_name}} ({{vars.lead_phone}})",
    leadInfoLines:
      "Name: {{vars.lead_name}} ({{vars.lead_first_name}})\n" +
      "Phone on file (bad): {{vars.lead_phone}}\n" +
      "Email: {{vars.lead_email}}\n" +
      "Address: {{vars.lead_address}}\n" +
      "{{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}\n" +
      "Portal: {{vars.leadUrl}}",
    sourceLabel: "HomeLight",
    leadEmails: [
      {
        id: "bp_email_lead",
        subject: "Regarding your recent Inquiry to Sell your Home on HomeLight",
        body:
          "Hi {{vars.lead_first_name}},\n\n" +
          "Re: Your recent inquiry online & the value of your home with HomeLight.com.\n\n" +
          `${BAD_PHONE_ASK}\n\n` +
          "I'm an excellent negotiator and have it down to an Art Form on how I negotiate " +
          "offers and create bidding wars in this market for your home. I'd love to help you.\n\n" +
          "I'm licensed since 1989. One of the top agents in Arizona. I have systems in place " +
          "to get your home listed and sold in one weekend with a bidding war getting the price " +
          "to escalate rapidly thousands above list price. In addition I have an appraiser as " +
          "part of my team to help price your listing with precision from the start as well as " +
          "keeping buyers from lowballing you. I have a low flexible commission. My goal is to " +
          "make sure you are happy with your bottom line. I have your bottom line 1st in mind!\n\n" +
          "Reply with your best phone number and we'll set up your free appraisal & next steps " +
          "to get your home listed & sold.\n\n" +
          "Amy Laidlaw\nAmy@amylaidlaw.com\nHomeSmart\n602-695-1142"
      }
    ]
  },
  {
    flowName: "Clever Lead - Accept",
    leadLabel: "{{vars.lead_name}} ({{vars.lead_phone}})",
    leadInfoLines:
      "Name: {{vars.lead_name}}\n" +
      "Phone on file (bad): {{vars.lead_phone}}\n" +
      "Email: {{vars.lead_email}}\n" +
      "Address: {{vars.lead_address}}",
    sourceLabel: "Clever (listwithclever.com)",
    leadEmails: [
      {
        id: "bp_email_lead",
        subject: "Re: Your Clever inquiry — cash offers on your home",
        body:
          "Hi {{vars.lead_name}},\n\n" +
          "Re: Your recent inquiry about cash offers on your home through Clever.\n\n" +
          `${BAD_PHONE_ASK}\n\n` +
          `${RE_SELLER_PITCH}\n\n${AMY_SIGNATURE}`
      }
    ]
  }
];

/**
 * Build the appended steps for one flow. Step ids all start with "bp_"
 * (the idempotency marker).
 *
 * No `when` guards on the math/wait steps: an unclaimed / owner-direct run
 * has claimed_agent_phone = "none", which the wait planner resolves straight
 * to the no_reply sentinel (no park) — and the classify + both branch arms
 * are themselves gated off no_reply, so nothing fires for those runs.
 */
export function buildBadPhoneSteps(cfg: FlowConfig): Step[] {
  // Two report variants for Amy, split by a nested branch on whether the
  // lead actually has an email (contains "@" — extractions store the literal
  // "none", or "", when there is no address): the has-email arm states the
  // lead HAS been emailed for a better number; the else arm states NO
  // follow-up email could be sent, so Amy knows the report email is the only
  // outreach that happened.
  const amyReportIntro =
    `{{vars.claimed_agent}} tried calling the ${cfg.flowName} lead and reported the ` +
    "phone number we have is bad.\n" +
    'Their exact words: "{{vars.agent_report}}"\n\n' +
    `Lead info:\n${cfg.leadInfoLines}\n` +
    `Lead source: ${cfg.sourceLabel}\n\n`;
  // Runs AFTER the lead email steps in its arm, so actions_taken already
  // records whether each send actually went out ("emailed x@y" vs "skipped
  // email ... (no valid address)") — the report never overstates outreach
  // that a stricter send-time validation or an unmatched lead_type skipped.
  const amyEmailEmailed: Step = {
    id: "bp_email_amy",
    type: "send_email",
    to: AMY_EMAIL,
    subject: `BAD PHONE NUMBER — ${cfg.leadLabel}, ${cfg.flowName}`,
    body:
      amyReportIntro +
      "The lead has an email on file, so a follow-up asking for their best " +
      `phone number was attempted from ${AMY_EMAIL}. The outcome line below ` +
      'shows exactly what went out — look for "emailed ..." (sent) vs ' +
      '"skipped email ..." (unusable address; nothing was sent, so please ' +
      "get their best number if they reach out another way).\n\n" +
      "Everything this flow did: {{vars.actions_taken}}"
  };
  const amyEmailNoEmail: Step = {
    id: "bp_email_amy_no_email",
    type: "send_email",
    to: AMY_EMAIL,
    subject: `BAD PHONE NUMBER, NO EMAIL — ${cfg.leadLabel}, ${cfg.flowName}`,
    body:
      amyReportIntro +
      "This lead has NO email on file, so NO follow-up email was sent asking " +
      "for a better number — this report is the only outreach. If the seller " +
      "reaches out another way, please ask them for their best phone number."
  };
  const leadEmails: Step[] = cfg.leadEmails.map((e) => ({
    id: e.id,
    type: "send_email",
    to: "{{vars.lead_email}}",
    subject: e.subject,
    body: e.body,
    fromConnectionId: AMY_CONNECTION_ID,
    ...(e.when ? { when: e.when } : {})
  }));
  return [
    {
      id: "bp_wait_minutes",
      type: "math",
      operation: "add",
      left: "{{vars.claimed_agent_eta_minutes}}",
      right: "60",
      saveAs: "report_wait_minutes"
    },
    {
      id: "bp_wait",
      type: "wait_for_reply",
      phoneVar: "claimed_agent_phone",
      saveAs: "agent_report",
      timeoutMinutes: 60,
      timeoutMinutesTemplate: "{{vars.report_wait_minutes}}"
    },
    {
      id: "bp_classify",
      type: "classify",
      textVar: "agent_report",
      when: { var: "agent_report", notEquals: "no_reply" },
      question:
        "A team member claimed this lead and tried to call them. This is the " +
        "team member's follow-up text message about that lead.",
      categories: [
        {
          value: "bad_phone_number",
          description:
            "says the lead's phone number is bad - wrong number, disconnected, out of " +
            "service, fake, dead line, no longer in service, or otherwise describes the " +
            "lead's phone negatively"
        },
        {
          value: "other_update",
          description:
            "any other update about the lead - left a voicemail, no answer, will try " +
            "again later, spoke with them, or anything not about a bad phone number"
        }
      ],
      saveAs: "agent_report_class"
    },
    {
      id: "bp_branch",
      type: "branch",
      question: "Did the team member report a bad or invalid phone number for this lead?",
      branches: [
        {
          id: "bp_bad_phone",
          label: "Bad phone number reported",
          condition: { var: "agent_report_class", equals: "bad_phone_number" },
          steps: [
            {
              id: "bp_email_branch",
              type: "branch",
              question: "Does this lead have an email on file?",
              branches: [
                {
                  id: "bp_has_email",
                  label: "Lead has an email",
                  // Lead emails FIRST, Amy's report LAST — see amyEmailEmailed.
                  condition: { var: "lead_email", contains: "@" },
                  steps: [...leadEmails, amyEmailEmailed]
                }
              ],
              else: [amyEmailNoEmail]
            }
          ]
        }
      ],
      // other_update AND the classifier's "unclear" fallback: forward the
      // teammate's note to Amy so no report ever disappears silently. Gated
      // off no_reply so a silent timeout (or a never-claimed run) sends
      // nothing.
      else: [
        {
          id: "bp_forward",
          type: "notify_owner",
          when: { var: "agent_report", notEquals: "no_reply" },
          message:
            `${cfg.flowName} update from {{vars.claimed_agent}} about ` +
            `${cfg.leadLabel}: {{vars.agent_report}}`
        }
      ]
    }
  ];
}

/**
 * Install (or upgrade in place) the bad-phone-report steps on a definition:
 * any existing bp_* steps from an earlier version of this script are
 * replaced with the current build, so copy fixes re-apply without a manual
 * strip. Idempotent: returns false when the definition already matches.
 */
export function addBadPhoneAgentReport(def: Definition, cfg: FlowConfig): boolean {
  const steps = def.steps ?? [];
  const kept = steps.filter((s) => !(typeof s.id === "string" && s.id.startsWith("bp_")));
  const next = [...kept, ...buildBadPhoneSteps(cfg)];
  if (JSON.stringify(steps) === JSON.stringify(next)) return false;
  def.steps = next;
  return true;
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
  const names = FLOW_CONFIGS.map((c) => c.flowName);
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .in("name", names)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const found = new Set(((rows ?? []) as Array<{ name: string }>).map((r) => r.name));
  for (const name of names) {
    if (!found.has(name)) console.warn(`WARNING: no flow named "${name}" for ${businessId}`);
  }

  let changedCount = 0;
  const patched: Array<{ id: string; name: string }> = [];
  for (const row of (rows ?? []) as Array<{
    id: string;
    name: string;
    enabled: boolean;
    definition: Definition;
  }>) {
    const cfg = FLOW_CONFIGS.find((c) => c.flowName === row.name);
    if (!cfg) continue;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const before = JSON.stringify(row.definition);
    if (!addBadPhoneAgentReport(def, cfg)) {
      console.log(`\n=== ${row.name} (${row.id}) — already patched, skipping`);
      continue;
    }

    // Re-validate the patched definition exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`\nFlow "${row.name}" (${row.id}) would become INVALID — skipping:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    changedCount += 1;
    console.log(`\n=== ${row.name} (${row.id}, enabled=${row.enabled}) ===`);
    console.log(`  BEFORE: ${before}`);
    console.log(`  AFTER : ${JSON.stringify(def)}`);

    if (args.apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.id}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> updated.");
      patched.push({ id: row.id, name: row.name });
    }
  }

  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already patched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
  if (args.apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "add-bad-phone-agent-report.ts",
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
