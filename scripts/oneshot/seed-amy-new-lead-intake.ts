#!/usr/bin/env tsx
/**
 * One-shot: seed the "New Lead Intake" AiFlow for Amy Laidlaw Real Estate.
 *
 * Why: when Amy texts lead info to her own coworker line ("I got a new lead,
 * please deal with it. <name> <number> <details>"), the owner-operator SMS
 * surface (/api/internal/owner-sms-turn) can only offer `run_aiflow` on flows
 * she actually has, and every enabled flow is lead-source-specific (Clever /
 * HomeLight / Realtor.com / ReferralExchange). This manual-channel flow is the
 * generic answer the operator can offer by name and run with her raw text as
 * the trigger window text ({{trigger.windowText}}).
 *
 * Shape (per Amy's direction: mirror the ReferralExchange flow, the AI
 * worker texts the lead AND routes to the team):
 *
 *   parse (extract_text over the owner's message)
 *     -> save_contact (upsert_customer, only when a phone was parsed)
 *     -> intro branch: when the message names a referrer ("it's a referral
 *        from Donald"), the intro opens with a personal referral touch
 *        crediting them by name; otherwise the standard copy. Both arms are
 *        buyer/seller/both SMS variants of Amy's RE copy (source-site
 *        references neutralized; RE quiet hours with email fallback) plus
 *        the no-phone intro EMAIL variants.
 *     -> "call this lead": the AI places the call in the lead's language
 *        (place_ai_call, no live transfer) and Amy gets the summary. A call
 *        request suppresses the intro TEXT but never the team routing.
 *     -> route_to_team: when Amy names a teammate ("I want Gabby to have
 *        this"), the DYNAMIC pin (agentNameVar) resolves the extracted name
 *        against the live roster at run time, so any current or FUTURE
 *        roster member is pinnable by name (explicit hand-off, so no $1M+
 *        override); otherwise by lead type (buyer = un-pinned roster
 *        cascade; seller/both pinned to Dave Lane; $1M+ kept for Amy via
 *        ownerDirectWhen price_band)
 *     -> notify_owner outcome (plus an honest no-phone variant)
 *
 * The referral gate is equals-matched, so a missed extraction fails CLOSED
 * into the standard copy; the referral fact also rides lead_details into the
 * team offer and owner notify.
 *
 * Deliberately out of v1: the bad-phone report loop (bp_wait/classify), the
 * lead came from Amy herself.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API
 * use. Dry-run by default; idempotent by flow name unless --force, and
 * --update refreshes an existing flow's definition in place.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-amy-new-lead-intake.ts            # dry run
 *   npx tsx scripts/oneshot/seed-amy-new-lead-intake.ts --apply --enable
 *   npx tsx scripts/oneshot/seed-amy-new-lead-intake.ts --update --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_NEW_LEAD_FLOW_NAME       (default "New Lead Intake")
 *   AIFLOW_NEW_LEAD_AGENT_NAME     (default "Dave Lane", seller/both routes)
 *   AIFLOW_NEW_LEAD_MAILBOX_ID     (default Amy's connected mailbox, email
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

type Args = {
  apply: boolean;
  enable: boolean;
  force: boolean;
  update: boolean;
  businessId: string | null;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    apply: false,
    enable: false,
    force: false,
    update: false,
    businessId: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--force") args.force = true;
    else if (a === "--update") args.update = true;
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
 * sends from), used for the quiet-hours email fallback and the no-phone
 * intro email.
 */
const DEFAULT_MAILBOX_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

const PHOENIX_TZ = "America/Phoenix";

/**
 * The AI call Amy can ask for ("call this lead"). Two persona variants so a
 * lead already known to speak Spanish is called in Spanish; either way the
 * voice AI follows the language the callee actually speaks once they answer.
 * No live transfer by design: the AI calls and does what it normally does,
 * then Amy gets the summary.
 */
const CALL_PERSONA_EN =
  "Hi, is this {{vars.lead_name.first}}? I'm calling from Amy Laidlaw's office at " +
  "HomeSmart. Amy asked me to reach out about your real estate plans. Is now a good " +
  "time for a couple of quick questions?";

const CALL_PERSONA_ES =
  "Hola, habla usted con {{vars.lead_name.first}}? Le llamo de la oficina de Amy " +
  "Laidlaw en HomeSmart. Amy me pidio comunicarme con usted sobre sus planes de bienes " +
  "raices. Es buen momento para hacerle unas preguntas rapidas?";

/** What the AI already knows, so it never re-asks what Amy already sent. */
const CALL_CONTEXT =
  "Their name: {{vars.lead_name}}. Phone: {{vars.lead_phone}}. " +
  "What they are looking for: {{vars.lead_details}}. " +
  "Price or budget: {{vars.price}}.";

/** Lead details the AI should come back with from the call. */
const CALL_CAPTURE_FIELDS = [
  "what they are looking for",
  "their timeline",
  "best time to reach them"
];

/**
 * The referral personal touch: when Amy's message says who referred the
 * lead ("it's a referral from Donald"), the intro opens by crediting them
 * by name. Inserted right after the greeting paragraph, ONLY on the
 * referral branch (gated on referral_gate, so the template can never
 * render a "none" sentinel or an empty name to the lead).
 */
export const REFERRAL_TOUCH_LINE =
  "{{vars.referred_by}} shared your info with me and thought I could help. " +
  "I'm so glad they connected us!";

/** The same credit, in Spanish, for the Spanish intro. */
export const REFERRAL_TOUCH_LINE_ES =
  "{{vars.referred_by}} me compartio su informacion y penso que yo podria ayudarle. " +
  "Me alegra mucho que nos haya conectado!";

/** The Spanish intro's greeting paragraph (its insertion anchor). */
const SPANISH_GREETING_PARAGRAPH = "Hola {{vars.lead_name.first}}.\n\n";

/** The greeting paragraph every intro variant opens with (insertion anchor). */
const GREETING_PARAGRAPH = "Hi {{vars.lead_name}}.\n\n";

/**
 * Amy's ReferralExchange intro copy, verbatim except the source-site
 * references ("Your recent inquiry on RealEstateAgents.com"), an owner-handed
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

/**
 * The Spanish intro. Deliberately SHORT and claim-free next to Amy's English
 * pitch: every fact here already appears in her own copy (licensed since 1989,
 * a top Arizona agent, the free appraisal for sellers, her number), because
 * inventing marketing claims in a language the owner has not reviewed is worse
 * than a plainer message.
 *
 * REVIEW NOTE for Amy: replace this with your own Spanish wording whenever you
 * like. It is one flow edit (/dashboard/aiflows) and needs no code change.
 * Until then this is what a Spanish-speaking lead receives.
 */
const SPANISH_INTRO_BODY =
  "Hola {{vars.lead_name.first}}.\n\n" +
  "Soy Amy Laidlaw de HomeSmart. Tengo licencia desde 1989 y soy una de las agentes " +
  "con mas experiencia en Arizona.\n\n" +
  "Si esta pensando en vender, le ofrezco una evaluacion GRATIS de su casa. Si esta " +
  "buscando comprar, le puedo enviar las casas disponibles en las zonas que le " +
  "interesen.\n\n" +
  "Cuando es un buen momento para hablar unos minutos? Puede llamarme o escribirme al " +
  "602-695-1142.\n\n" +
  "Gracias, Amy Laidlaw ~ HomeSmart \u{1F60A}";

/**
 * Intro variants. `es` is a language variant rather than a lead type: one
 * Spanish body covers buyer, seller, and both (it speaks to each), which keeps
 * the reviewed-copy surface small.
 */
type IntroVariant = "buyer" | "seller" | "both" | "es";

const INTRO_VARIANTS: readonly IntroVariant[] = ["buyer", "seller", "both", "es"];

const INTRO_SUBJECTS: Record<IntroVariant, string> = {
  buyer: "Re: Your home search",
  seller: "Re: Selling your home",
  both: "Re: Your next real estate move",
  es: "Sobre su busqueda de casa"
};

const INTRO_BODIES: Record<IntroVariant, string> = {
  buyer: BUYER_INTRO_BODY,
  seller: SELLER_INTRO_BODY,
  both: BOTH_INTRO_BODY,
  es: SPANISH_INTRO_BODY
};

/** Shared lead summary line for offers/alerts. */
const LEAD_SUMMARY_LINE =
  "{{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}) around {{vars.price}}. Looking for: {{vars.lead_details}}.";

const LEAD_SOURCE_LINE = "Lead source: Amy (direct)";

const PASS_REASON_LINE =
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").';

const OWNER_DIRECT_TEMPLATE =
  "****************\n" +
  "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you, not offered to the team.\n" +
  `${LEAD_SUMMARY_LINE}\n${LEAD_SOURCE_LINE}\n` +
  "****************";

const CLAIMED_NOTIFY_TEMPLATE =
  "{{agent.name}} claimed the {{vars.lead_type}} lead {{vars.lead_name}} " +
  `({{vars.lead_phone}}, email: {{vars.lead_email}}).\n${LEAD_SOURCE_LINE}`;

type When = { var: string; equals?: string; notEquals?: string };

/** Quiet hours mirroring her ReferralExchange lead texts (email fallback). */
function introQuietHours(mailboxConnectionId: string, variant: IntroVariant) {
  return {
    resumeAt: "08:30",
    timezone: PHOENIX_TZ,
    noSendAfter: "22:00",
    emailSubject: INTRO_SUBJECTS[variant],
    emailFallbackVar: "lead_email",
    emailFromConnectionId: mailboxConnectionId
  };
}

/**
 * The intro body for a variant, with the referral personal touch inserted
 * after the greeting on the referral branch. Both branch arms are generated
 * from the same base copy, so they can never drift. The Spanish variant gets
 * the Spanish credit line.
 */
function introBody(variant: IntroVariant, referral: boolean): string {
  const base = INTRO_BODIES[variant];
  if (!referral) return base;
  const touch = variant === "es" ? REFERRAL_TOUCH_LINE_ES : REFERRAL_TOUCH_LINE;
  const anchor = variant === "es" ? SPANISH_GREETING_PARAGRAPH : GREETING_PARAGRAPH;
  return base.replace(anchor, `${anchor}${touch}\n\n`);
}

function introSmsStep(
  mailboxConnectionId: string,
  variant: IntroVariant,
  referral: boolean
) {
  return {
    id: referral ? `send_${variant}_ref` : `send_${variant}`,
    type: "send_sms",
    to: "{{vars.lead_phone}}",
    body: introBody(variant, referral),
    when: { var: "phone_lead_type", equals: variant } satisfies When,
    quietHours: introQuietHours(mailboxConnectionId, variant)
  };
}

/** No-phone intro email (only when the owner gave an email but no number). */
function introEmailStep(
  mailboxConnectionId: string,
  variant: IntroVariant,
  referral: boolean
) {
  return {
    id: referral ? `email_lead_${variant}_ref` : `email_lead_${variant}`,
    type: "send_email",
    to: "{{vars.lead_email}}",
    subject: INTRO_SUBJECTS[variant],
    body: introBody(variant, referral),
    when: { var: "email_intro_type", equals: variant } satisfies When,
    fromConnectionId: mailboxConnectionId
  };
}

/**
 * The AI call, in the language the lead is known to speak. No live transfer by
 * design (Amy asked for "the AI calls and does what it normally does"), and the
 * summary goes to her. Two steps, one per language, gated on the same token so
 * exactly one can fire.
 */
function callStep(language: "en" | "es"): Record<string, unknown> {
  return {
    id: `call_lead_${language}`,
    type: "place_ai_call",
    toVar: "lead_phone",
    // Inside the call branch: Spanish when the lead speaks it, English for
    // EVERYTHING else. English is deliberately notEquals rather than
    // equals-"none" so an extraction that answered "" (or anything unexpected)
    // still places the call Amy asked for. equals-"none" would have left both
    // steps unmatched and silently skipped the call. The voice AI follows the
    // language the callee actually speaks anyway, so a wrong guess
    // self-corrects live.
    when:
      language === "es"
        ? ({ var: "lead_language", equals: "es" } satisfies When)
        : ({ var: "lead_language", notEquals: "es" } satisfies When),
    personaTemplate: language === "es" ? CALL_PERSONA_ES : CALL_PERSONA_EN,
    contextTemplate: CALL_CONTEXT,
    captureFields: CALL_CAPTURE_FIELDS,
    // notifyOwner rather than her hardcoded cell: the summary follows her
    // configured alert number, so changing it in Settings is enough.
    notifyOwner: true,
    saveAs: "call_outcome"
  };
}

/**
 * The intro for one referral arm, forked again on language. Spanish is a
 * nested branch rather than another extraction token because the extract step
 * is capped at 15 fields: one `lead_language` answer drives the Spanish intro
 * AND the call persona AND the contact's stored language.
 *
 * Inside the Spanish arm the two steps still gate on the SAME phone/email
 * tokens the English steps use, so "which channel" and "which language" stay
 * independent decisions.
 */
function introSteps(mailboxConnectionId: string, referral: boolean) {
  const englishTypes = ["buyer", "seller", "both"] as const;
  return [
    {
      id: referral ? "intro_lang_ref" : "intro_lang",
      type: "branch",
      question: "Does this lead speak Spanish?",
      branches: [
        {
          id: referral ? "intro_es_ref" : "intro_es",
          label: "Spanish speaker",
          condition: { var: "lead_language", equals: "es" } satisfies When,
          steps: [
            {
              ...introSmsStep(mailboxConnectionId, "es", referral),
              when: { var: "phone_lead_type", notEquals: "none" } satisfies When
            },
            {
              ...introEmailStep(mailboxConnectionId, "es", referral),
              when: { var: "email_intro_type", notEquals: "none" } satisfies When
            }
          ]
        }
      ],
      else: [
        ...englishTypes.map((t) => introSmsStep(mailboxConnectionId, t, referral)),
        ...englishTypes.map((t) => introEmailStep(mailboxConnectionId, t, referral))
      ]
    }
  ];
}

/**
 * The call, as its own branch so "should we call?" and "in which language?"
 * stay one extraction token each. An empty else means no call was asked for and
 * nothing happens.
 */
function callBranch(): Record<string, unknown> {
  return {
    id: "call_branch",
    type: "branch",
    question: "Did the message ask for this lead to be called?",
    branches: [
      {
        id: "call_yes",
        label: "Call the lead",
        condition: { var: "call_gate", equals: "yes" } satisfies When,
        steps: [callStep("es"), callStep("en")]
      }
    ],
    else: []
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
    when: { var: "route_variant", equals: leadType } satisfies When,
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
        `({{vars.lead_phone}}, email: {{vars.lead_email}}).\n${LEAD_SOURCE_LINE}`
      : "No agent claimed the {{vars.lead_type}} lead {{vars.lead_name}} " +
        `({{vars.lead_phone}}, email: {{vars.lead_email}}).\n${LEAD_SOURCE_LINE}`
  };
}

/**
 * Explicit hand-offs ("I want Gabby to have this") ride the engine's DYNAMIC
 * pin (route_to_team.agentNameVar, PR #876): the extracted assigned_agent
 * value is resolved against the LIVE roster at execution time (exact name,
 * first name, unique prefix with nickname tolerance), so a new hire is
 * pinnable the day they join and a rename never breaks the pin. An unmatched
 * name falls back to Amy, never to an unintended teammate. Deliberately NO
 * ownerDirectWhen: naming a person IS Amy's routing decision, so the $1M+
 * keep-for-owner rule never overrides it.
 */
function assignedRouteStep(): Record<string, unknown> {
  return {
    id: "route_assigned",
    type: "route_to_team",
    agentNameVar: "assigned_agent",
    when: { var: "route_variant", equals: "assigned" } satisfies When,
    offerWindow: {
      quietStart: "21:00",
      quietEnd: "08:30",
      timezone: PHOENIX_TZ,
      graceMinutes: 10
    },
    responseMinutes: 10,
    offerTemplate:
      `Amy asked for this lead to go to YOU. New {{vars.lead_type}} lead: ${LEAD_SUMMARY_LINE}\n` +
      "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
      'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").\n' +
      `${LEAD_SOURCE_LINE}\n${PASS_REASON_LINE}`,
    claimedNotifyTemplate: CLAIMED_NOTIFY_TEMPLATE,
    ownerFallbackTemplate:
      "{{vars.assigned_agent}} didn't claim the {{vars.lead_type}} lead {{vars.lead_name}} " +
      "({{vars.lead_phone}}, email: {{vars.lead_email}}), " +
      `even though you asked for them to take it. It's back with you.\n${LEAD_SOURCE_LINE}`
  };
}

/**
 * The full definition. Pure, exported for the unit test, which pins it
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
    // run_aiflow tool, the owner's message text becomes {{trigger.windowText}}.
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
              "message for the lead, never the business's own number and never 602-695-1142. " +
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
              "timeline, must-haves), including who referred them when the message says so " +
              "(e.g. 'referral from Donald'). If nothing is given, answer exactly: none"
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
            name: "lead_language",
            description:
              "Answer exactly es when the message says this lead speaks (or prefers) Spanish. " +
              "Otherwise answer exactly: none"
          },
          {
            name: "phone_lead_type",
            description:
              "Which intro TEXT to send. If there is a phone and the message does not ask ONLY " +
              "for a call: answer es when the lead speaks Spanish, else the lead type (buyer, " +
              "seller, or both). If it asks only for a call, or there is no phone, answer " +
              "exactly: none"
          },
          {
            name: "email_intro_type",
            description:
              "Which intro EMAIL to send. Only when there is NO phone but there IS an email: " +
              "answer es when the lead speaks Spanish, else the lead type (buyer, seller, or " +
              "both). Otherwise answer exactly: none"
          },
          {
            name: "call_gate",
            description:
              "Answer exactly yes when the message asks for the lead to be CALLED (e.g. 'call " +
              "this lead', 'give them a call') AND a phone number is given. Otherwise answer " +
              "exactly: none"
          },
          {
            name: "referred_by",
            description:
              "The name of the person who referred this lead, when the message says it is a " +
              "referral (e.g. 'it's a referral from Donald' answers: Donald). Politely cased, " +
              "first name is enough. If it is not a referral or no referrer is named, " +
              "answer exactly: none"
          },
          {
            name: "referral_gate",
            description:
              "If the message says this lead was referred by a NAMED person, answer exactly " +
              "one lowercase word: referral. Otherwise answer exactly: none"
          },
          {
            name: "assigned_agent",
            description:
              "The teammate's name exactly as the message wrote it, when the message says " +
              "a specific teammate should get or handle this lead (e.g. 'I want Gabby to " +
              "have this' answers: Gabby). If no teammate is named, answer exactly: none"
          },
          {
            name: "route_variant",
            description:
              "EXACTLY ONE lowercase token. When the message names a specific teammate " +
              "who should get this lead, answer exactly: assigned. Otherwise answer the " +
              "lead type: buyer, seller, or both. If NO phone number is given for the " +
              "lead, answer exactly: none"
          }
        ]
      },
      // File the lead as a contact BEFORE any outreach, gated on a parsed
      // phone (upsert_customer fails hard on an unusable phoneVar). It also
      // stamps the language when the message named one, so every LATER surface
      // (AI replies, follow-ups, the next flow) speaks it without being told
      // again; stored as a detection, so the lead's own replies can correct it.
      {
        id: "save_contact",
        type: "upsert_customer",
        when: { var: "route_variant", notEquals: "none" } satisfies When,
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email",
        languageVar: "lead_language"
      },
      // Intro from the AI worker (RE copy, quiet hours + email fallback),
      // forked on the referral personal touch. The gate is equals-matched
      // ("referral"), so a missing/failed extraction fails CLOSED into the
      // standard copy: the referral opening (and its {{vars.referred_by}})
      // can only ever render when a named referrer was actually parsed.
      {
        id: "intro",
        type: "branch",
        question: "Was this lead referred by a named person?",
        branches: [
          {
            id: "intro_referral",
            label: "Referral with a named referrer",
            condition: { var: "referral_gate", equals: "referral" } satisfies When,
            steps: introSteps(mailbox, true)
          }
        ],
        else: introSteps(mailbox, false)
      },
      // "Call this lead": the AI places the call and does what it normally
      // does, in the lead's language, then Amy gets the summary. Exactly one
      // of the two fires (call_language is es, en, or none), and none means
      // no call at all. The lead is still routed to a teammate below either
      // way, because a call does not replace ownership of the lead.
      callBranch(),
      // Explicit hand-off ("I want Gabby to have this"): the DYNAMIC pin
      // resolves the extracted name against the live roster at run time, so
      // any current or future roster member is pinnable by name.
      assignedRouteStep(),
      // Otherwise route by lead type (RE shape): buyer un-pinned roster
      // cascade, seller/both to Dave, $1M+ kept for Amy.
      routeStep("buyer", agentName),
      routeStep("seller", agentName),
      routeStep("both", agentName),
      {
        id: "notify",
        type: "notify_owner",
        when: { var: "route_variant", notEquals: "none" } satisfies When,
        message:
          "New Lead Intake handled the {{vars.lead_type}} lead you sent in.\n" +
          `Lead: ${LEAD_SUMMARY_LINE}\n${LEAD_SOURCE_LINE}\n` +
          // The call outcome is spelled out so a call that never connected is
          // never reported as handled ("none" when no call was asked for).
          "Call outcome: {{vars.call_outcome}}.\n" +
          "Outcome: {{vars.actions_taken}}."
      },
      {
        id: "notify_no_phone",
        type: "notify_owner",
        when: { var: "route_variant", equals: "none" } satisfies When,
        message:
          "New Lead Intake got a lead with NO usable phone number, so no text went out and " +
          "no one was offered the lead.\n" +
          "Lead: {{vars.lead_name}} (email: {{vars.lead_email}}) " +
          "around {{vars.price}}. Looking for: {{vars.lead_details}}.\n" +
          "If an email was on file, an intro email was sent instead; the outcome line " +
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
  // --update: the flow exists and its definition is replaced in place with
  // the current builder output (validated above). Enabled state is kept.
  //
  // Guard (Bugbot #870): runs resume BY STEP ID after a flow edit, and this
  // update moves the intro send steps INSIDE a branch arm. A run parked on
  // one of those ids (e.g. a quiet-hours deferral) would resume inside a
  // branch it never evaluated and could skip the lead's intro entirely. So
  // the update refuses while ANY non-terminal run exists for this flow;
  // re-run once they drain (or cancel them from /dashboard/aiflows).
  if (existing && args.update) {
    const ACTIVE_RUN_STATUSES = [
      "queued",
      "running",
      "awaiting_reply",
      "awaiting_agent",
      "awaiting_approval"
    ];
    const { count: activeRuns, error: runsErr } = await db
      .from("ai_flow_runs")
      .select("id", { count: "exact", head: true })
      .eq("flow_id", existing.id)
      .in("status", ACTIVE_RUN_STATUSES);
    if (runsErr) {
      console.error(`Active-run check failed: ${runsErr.message}`);
      process.exit(1);
    }
    if ((activeRuns ?? 0) > 0) {
      console.error(
        `Refusing to update: ${activeRuns} active run(s) exist for this flow ` +
          `(statuses ${ACTIVE_RUN_STATUSES.join("/")}). A parked run resumes by step ` +
          "id and the update moves the intro sends into a branch arm, so it could " +
          "skip the lead's intro. Wait for them to finish (or cancel them from " +
          "/dashboard/aiflows), then re-run."
      );
      process.exit(2);
    }
    if (!args.apply) {
      console.log(
        `\n[dry-run] Would UPDATE flow "${name}" (id=${existing.id}, ` +
          `enabled=${existing.enabled}) in place. Re-run with --update --apply to write.`
      );
      return;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition })
      .eq("id", existing.id);
    if (upErr) {
      console.error(`Update failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log(
      `\nUpdated AiFlow id=${existing.id} in place (enabled=${existing.enabled}).`
    );
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "seed-amy-new-lead-intake.ts",
      businessId,
      details: { flow_id: existing.id, flow_name: name, updated: true }
    });
    return;
  }
  if (existing && !args.force) {
    console.log(
      `\nFlow "${name}" already exists (id=${existing.id}, enabled=${existing.enabled}). ` +
        "Nothing to do. Pass --update to refresh its definition in place, or --force " +
        "to create a duplicate."
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
