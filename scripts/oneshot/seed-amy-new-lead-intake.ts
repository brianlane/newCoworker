#!/usr/bin/env tsx
/**
 * One-shot: seed the "New Lead Intake" AiFlow for Amy Laidlaw Real Estate.
 *
 * Why: when Amy texts lead info to her own coworker line ("I got a new lead,
 * please deal with it. <name> <number> <details>"), the owner-operator SMS
 * surface (/api/internal/owner-sms-turn) can only offer `run_aiflow` on flows
 * she actually has — and every enabled flow is lead-source-specific (Clever /
 * HomeLight / Realtor.com / ReferralExchange). This manual-channel flow is the
 * generic answer the operator can offer by name and run with her raw text as
 * the trigger window text ({{trigger.windowText}}).
 *
 * Shape (per Amy's direction: mirror the ReferralExchange flow — the AI
 * worker texts the lead AND routes to the team):
 *
 *   parse (extract_text over the owner's message)
 *     -> save_contact (upsert_customer, only when a phone was parsed)
 *     -> intro SMS to the lead (buyer/seller/both variants, Amy's RE copy
 *        with the source-site references neutralized; RE quiet hours with
 *        email fallback)
 *     -> intro EMAIL to the lead (only when NO phone but an email was given)
 *     -> route_to_team (buyer = un-pinned roster cascade; seller/both pinned
 *        to Dave Lane; $1M+ kept for Amy via ownerDirectWhen price_band)
 *     -> notify_owner outcome (plus an honest no-phone variant)
 *
 * Deliberately out of v1: the bad-phone report loop (bp_wait/classify) — the
 * lead came from Amy herself.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API
 * use. Dry-run by default; idempotent by flow name unless --force.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-amy-new-lead-intake.ts            # dry run
 *   npx tsx scripts/oneshot/seed-amy-new-lead-intake.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_NEW_LEAD_FLOW_NAME       (default "New Lead Intake")
 *   AIFLOW_NEW_LEAD_AGENT_NAME     (default "Dave Lane" — seller/both routes)
 *   AIFLOW_NEW_LEAD_MAILBOX_ID     (default Amy's connected mailbox — email
 *                                   fallback + no-phone intro email sender)
 *
 * Exit codes: 0 seeded/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; enable: boolean; force: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, enable: false, force: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--force") args.force = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
export const DEFAULT_FLOW_NAME = "New Lead Intake";
/** Seller/both leads route to Dave first, exactly like her ReferralExchange flow. */
const DEFAULT_AGENT_NAME = "Dave Lane";
/**
 * Amy's connected mailbox (the same connection her ReferralExchange flow
 * sends from) — used for the quiet-hours email fallback and the no-phone
 * intro email.
 */
const DEFAULT_MAILBOX_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

const PHOENIX_TZ = "America/Phoenix";

/**
 * Amy's ReferralExchange intro copy, verbatim except the source-site
 * references ("Your recent inquiry on RealEstateAgents.com") — an owner-handed
 * lead never made a portal inquiry, so those lines are neutralized.
 */
const BUYER_INTRO_BODY =
  "Re: searching for a home\n\n" +
  "Hi {{vars.lead_name}}.\n\n" +
  "I'd love to help you.\n\n" +
  "When is the best time to communicate with you for a brief few minutes?\n\n" +
  "I'm an excellent negotiator and have it down to an Art Form on how I negotiate offers in this market.\n\n" +
  "I'm licensed since 1989. One of the top agents in Arizona. I am extremely experienced. " +
  "I'll keep you calm, well-informed while holding your hand and guiding you every step of the way. " +
  "Please call or text me when you're available to speak briefly on 602-695-1142. " +
  "Looking forward to Exceeding your Expectations. We're here for you. " +
  "We are willing to do video tours of homes for you to save you time. " +
  "Let us know if you need anything at all or have any questions or concerns. " +
  "By the way, Feel free to check out my real time up to the minute listings on my site below:\n\n" +
  "http://PhoenixAreasBestRealtor.com\n\n" +
  "I'll send you some Real Time Home listings & you'll be able to stay familiar with the market trends " +
  "and you will be 1st alerted if your favorite home hits the market or comes back on the market! " +
  "How many bedrooms, bathrooms, carport or garage stalls preference and what cities are you interested in? " +
  "Preference on whether it's updated or not updated? Single story or any story Preferred? Preference on a pool?\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart \u{1F60A}";

const SELLER_INTRO_BODY =
  "Hi {{vars.lead_name}}.\n\n" +
  "When is a good time to discuss next steps selling your home?\n\n" +
  "I'm an excellent negotiator and have created an Art Form for bidding wars in this market for your home.\n\n" +
  "I'm licensed since 1989. I have an appraiser as part of my team to help price your listing with precision " +
  "from the start as well as keeping buyers from lowballing you. " +
  "Please text/call me back today on 602-695-1142 to claim your FREE APPRAISAL!\n\n" +
  "I have a low flexible commission. My goal is to make sure you're happy with your bottom line. " +
  "I have your bottom line 1st in mind!\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart \u{1F60A}";

const BOTH_INTRO_BODY =
  "Hi {{vars.lead_name}}.\n\n" +
  "Thank you for reaching out! I would love to help you with your next real estate move.\n\n" +
  "I have been licensed since 1989 and am one of the top, most experienced agents in Arizona. " +
  "I hold your bottom line first in mind. I will keep you calm, well-informed, and guided every step of the way!\n\n" +
  "When you are looking to sell your home:\n" +
  "Bidding Wars: I am an expert negotiator who knows how to create bidding wars.\n" +
  "Free Appraisal: I have an appraiser on my team to price your home with precision.\n" +
  "Text or call me today to claim your FREE APPRAISAL and stop lowball offers!\n" +
  "Low Fees: I offer a low, flexible commission to maximize your profit.\n\n" +
  "When you are looking to buy a home:\n" +
  "Video Tours: We do live video tours of homes to save you time.\n" +
  "Instant Alerts: Check out my website at http://PhoenixAreasBestRealtor.com to get up-to-the-minute listings. " +
  "You will be the first to know when your favorite home hits the market!\n" +
  "Your Preferences: To help me search, how many bedrooms, bathrooms, and garage spaces do you need? " +
  "Do you prefer a single-story, a pool, an updated home, and which cities do you like?\n\n" +
  "Let me know a good time for a brief call, or feel free to call or text me anytime at 602-695-1142. " +
  "I look forward to exceeding your expectations!\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart \u{1F60A}";

const INTRO_SUBJECTS: Record<"buyer" | "seller" | "both", string> = {
  buyer: "Re: Your home search",
  seller: "Re: Selling your home",
  both: "Re: Your next real estate move"
};

const INTRO_BODIES: Record<"buyer" | "seller" | "both", string> = {
  buyer: BUYER_INTRO_BODY,
  seller: SELLER_INTRO_BODY,
  both: BOTH_INTRO_BODY
};

/** Shared lead summary line for offers/alerts. */
const LEAD_SUMMARY_LINE =
  "{{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}) in {{vars.location}}, " +
  "around {{vars.price}}. Looking for: {{vars.lead_details}}.";

const LEAD_SOURCE_LINE = "Lead source: Amy (direct)";

const PASS_REASON_LINE =
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").';

const OWNER_DIRECT_TEMPLATE =
  "****************\n" +
  "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you \u2014 not offered to the team.\n" +
  `${LEAD_SUMMARY_LINE}\n${LEAD_SOURCE_LINE}\n` +
  "****************";

const CLAIMED_NOTIFY_TEMPLATE =
  "{{agent.name}} claimed the {{vars.lead_type}} lead {{vars.lead_name}} " +
  `({{vars.lead_phone}}, email: {{vars.lead_email}}).\n${LEAD_SOURCE_LINE}`;

type When = { var: string; equals?: string; notEquals?: string };

/** Quiet hours mirroring her ReferralExchange lead texts (email fallback). */
function introQuietHours(mailboxConnectionId: string, leadType: "buyer" | "seller" | "both") {
  return {
    resumeAt: "08:30",
    timezone: PHOENIX_TZ,
    noSendAfter: "22:00",
    emailSubject: INTRO_SUBJECTS[leadType],
    emailFallbackVar: "lead_email",
    emailFromConnectionId: mailboxConnectionId
  };
}

function introSmsStep(mailboxConnectionId: string, leadType: "buyer" | "seller" | "both") {
  return {
    id: `send_${leadType}`,
    type: "send_sms",
    to: "{{vars.lead_phone}}",
    body: INTRO_BODIES[leadType],
    when: { var: "phone_lead_type", equals: leadType } satisfies When,
    quietHours: introQuietHours(mailboxConnectionId, leadType)
  };
}

/** No-phone intro email (only when the owner gave an email but no number). */
function introEmailStep(mailboxConnectionId: string, leadType: "buyer" | "seller" | "both") {
  return {
    id: `email_lead_${leadType}`,
    type: "send_email",
    to: "{{vars.lead_email}}",
    subject: INTRO_SUBJECTS[leadType],
    body: INTRO_BODIES[leadType],
    when: { var: "email_intro_type", equals: leadType } satisfies When,
    fromConnectionId: mailboxConnectionId
  };
}

function routeStep(
  leadType: "buyer" | "seller" | "both",
  agentName: string
): Record<string, unknown> {
  // Buyer leads cascade through the whole roster (un-pinned, exactly like her
  // ReferralExchange buyer route); seller/both offer Dave first.
  const pinned = leadType !== "buyer";
  const claimLine = pinned
    ? "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
      'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").'
    : "Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.";
  return {
    id: `route_${leadType}`,
    type: "route_to_team",
    ...(pinned ? { agentName } : {}),
    when: { var: "phone_lead_type", equals: leadType } satisfies When,
    offerWindow: {
      quietStart: "21:00",
      quietEnd: "08:30",
      timezone: PHOENIX_TZ,
      graceMinutes: 10
    },
    responseMinutes: 10,
    offerTemplate:
      `New {{vars.lead_type}} lead from Amy: ${LEAD_SUMMARY_LINE}\n` +
      `${claimLine}\n${LEAD_SOURCE_LINE}\n${PASS_REASON_LINE}`,
    ownerDirectWhen: { var: "price_band", equals: "over_1m" } satisfies When,
    ownerDirectTemplate: OWNER_DIRECT_TEMPLATE,
    ownerDirectNudges: true,
    claimedNotifyTemplate: CLAIMED_NOTIFY_TEMPLATE,
    ownerFallbackTemplate: pinned
      ? `${agentName} didn't claim the {{vars.lead_type}} lead {{vars.lead_name}} ` +
        `({{vars.lead_phone}}, email: {{vars.lead_email}}) in {{vars.location}}.\n${LEAD_SOURCE_LINE}`
      : "No agent claimed the {{vars.lead_type}} lead {{vars.lead_name}} " +
        `({{vars.lead_phone}}, email: {{vars.lead_email}}) in {{vars.location}}.\n${LEAD_SOURCE_LINE}`
  };
}

/**
 * The full definition. Pure — exported for the unit test, which pins it
 * through the real parseAiFlowDefinition.
 */
export function buildDefinition(opts?: {
  agentName?: string;
  mailboxConnectionId?: string;
}): unknown {
  const agentName = opts?.agentName ?? DEFAULT_AGENT_NAME;
  const mailbox = opts?.mailboxConnectionId ?? DEFAULT_MAILBOX_CONNECTION_ID;
  return {
    version: 1,
    // Manual-only: started from the Run-now button or the coworker's
    // run_aiflow tool — the owner's message text becomes {{trigger.windowText}}.
    trigger: { channel: "manual" },
    steps: [
      {
        id: "parse",
        type: "extract_text",
        fields: [
          {
            name: "lead_name",
            description:
              "The lead's name as given (first and last if provided, else the first name alone). " +
              "Never the sender's own name. If no name is given, answer exactly: none"
          },
          {
            name: "lead_phone",
            description:
              "The NEW lead's phone number in E.164 (+1...). This is the number included in the " +
              "message for the lead — never the business's own number and never 602-695-1142. " +
              "If no phone number is given, answer exactly: none"
          },
          {
            name: "lead_email",
            description: "The lead's email address, if given. If none, answer exactly: none"
          },
          {
            name: "lead_type",
            description:
              "Is this lead a buyer, a seller, or both? Answer with exactly one lowercase word " +
              "and nothing else: buyer, seller, or both. Use 'both' when the lead is explicitly " +
              "looking to both buy and sell, or when the message does not say either way."
          },
          {
            name: "lead_details",
            description:
              "What the lead is looking for, in the message's own words (e.g. 4bd/2ba, area, " +
              "timeline, must-haves). If nothing is given, answer exactly: none"
          },
          {
            name: "location",
            description: "The city/area of the lead, if given. If none, answer exactly: none"
          },
          {
            name: "price",
            description:
              "The price, budget, or home value if given (e.g. $450K). If none, answer exactly: none"
          },
          {
            name: "price_band",
            description:
              "Answer exactly one lowercase token: over_1m or under_1m. Is the price/budget/home " +
              "value ONE MILLION DOLLARS or more? $1M, $1,000,000, $1.2M and above are over_1m; " +
              "$999,999 and below are under_1m. If no price is given, answer under_1m."
          },
          {
            name: "phone_lead_type",
            description:
              "If the message includes a phone number for the lead, answer with the lead type as " +
              "exactly one lowercase word: buyer, seller, or both (the same answer as lead_type). " +
              "If NO phone number is given for the lead, answer exactly: none"
          },
          {
            name: "email_intro_type",
            description:
              "If the message gives NO phone number for the lead but DOES give an email address, " +
              "answer with the lead type as exactly one lowercase word: buyer, seller, or both. " +
              "Otherwise answer exactly: none"
          }
        ]
      },
      // File the lead as a contact BEFORE any outreach — gated on a parsed
      // phone (upsert_customer fails hard on an unusable phoneVar).
      {
        id: "save_contact",
        type: "upsert_customer",
        when: { var: "phone_lead_type", notEquals: "none" } satisfies When,
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email"
      },
      // Intro text from the AI worker (RE copy, quiet hours + email fallback).
      introSmsStep(mailbox, "buyer"),
      introSmsStep(mailbox, "seller"),
      introSmsStep(mailbox, "both"),
      // No phone at all: intro email instead (when an email was given).
      introEmailStep(mailbox, "buyer"),
      introEmailStep(mailbox, "seller"),
      introEmailStep(mailbox, "both"),
      // Route to the team (RE shape): buyer un-pinned, seller/both to Dave,
      // $1M+ kept for Amy.
      routeStep("buyer", agentName),
      routeStep("seller", agentName),
      routeStep("both", agentName),
      {
        id: "notify",
        type: "notify_owner",
        when: { var: "phone_lead_type", notEquals: "none" } satisfies When,
        message:
          "New Lead Intake handled the {{vars.lead_type}} lead you sent in.\n" +
          `Lead: ${LEAD_SUMMARY_LINE}\n${LEAD_SOURCE_LINE}\n` +
          "Outcome: {{vars.actions_taken}}."
      },
      {
        id: "notify_no_phone",
        type: "notify_owner",
        when: { var: "phone_lead_type", equals: "none" } satisfies When,
        message:
          "New Lead Intake got a lead with NO usable phone number, so no text went out and " +
          "no one was offered the lead.\n" +
          "Lead: {{vars.lead_name}} (email: {{vars.lead_email}}) in {{vars.location}}, " +
          "around {{vars.price}}. Looking for: {{vars.lead_details}}.\n" +
          "If an email was on file, an intro email was sent instead \u2014 the outcome line " +
          "shows exactly what went out.\n" +
          "Outcome: {{vars.actions_taken}}."
      }
    ]
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

  const name = process.env.AIFLOW_NEW_LEAD_FLOW_NAME ?? DEFAULT_FLOW_NAME;
  const definitionInput = buildDefinition({
    agentName: process.env.AIFLOW_NEW_LEAD_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    mailboxConnectionId:
      process.env.AIFLOW_NEW_LEAD_MAILBOX_ID ?? DEFAULT_MAILBOX_CONNECTION_ID
  });

  let definition;
  try {
    definition = parseAiFlowDefinition(definitionInput);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Name     : ${name}`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: existing, error: readErr } = await db
    .from("ai_flows")
    .select("id,enabled")
    .eq("business_id", businessId)
    .eq("name", name)
    .maybeSingle();
  if (readErr) {
    console.error(`Read failed: ${readErr.message}`);
    process.exit(1);
  }
  if (existing && !args.force) {
    console.log(
      `\nFlow "${name}" already exists (id=${existing.id}, enabled=${existing.enabled}). ` +
        "Nothing to do. Pass --force to create a duplicate."
    );
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to insert.");
    return;
  }

  const { data, error } = await db
    .from("ai_flows")
    .insert({ business_id: businessId, name, enabled: args.enable, definition })
    .select("id")
    .single();
  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "seed-amy-new-lead-intake.ts",
    businessId,
    details: { flow_id: data.id, flow_name: name, enabled: args.enable }
  });
}

// Run only when executed directly (not when imported by the unit test, which
// exercises the exported buildDefinition above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
