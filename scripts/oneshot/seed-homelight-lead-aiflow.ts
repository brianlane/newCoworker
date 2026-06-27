#!/usr/bin/env tsx
/**
 * One-shot: seed the "HomeLight Referral" lead AiFlow for a single tenant.
 *
 * Flow (single flow, portal-fetch, gated on Dave's acceptance):
 *   trigger : inbound SMS containing a URL AND "HomeLight Referral"
 *             (the "New HomeLight Referral: <name> - $<price> <type> in <city>"
 *             alert that carries the hmlt.co link).
 *   1. extract_url      -> leadUrl (the hmlt.co link).
 *   2. extract_text     -> lead_first_name / price / price_digits / city /
 *                          lead_type, read from the alert text (no browser needed).
 *                          price_digits (e.g. "429") is the lead-matching token for
 *                          the email fallback in step 5b.
 *   3. browse_extract   -> open leadUrl (credentialed), screenshot it, and
 *                          capture the "Call me to claim referral" button's href
 *                          into {{vars.claim_link}} via the new extractLinks.
 *   4. route_to_team    -> offer the lead to Dave Lane ONLY (no rotation),
 *                          5-minute claim window, BOTH links clearly labeled,
 *                          screenshot MMS, owner fallback to Amy. After this step
 *                          the engine sets {{vars.claimed_agent}} (the claimer's
 *                          name, or "none" on owner fallback / no claim).
 *   5. browse_extract   -> re-open leadUrl (credentialed) and pull the claimed
 *                          lead's name/phone/email/address off the portal contact
 *                          card. GATED on claimed_agent != none.
 *   6. upsert_customer  -> file the lead (gated).
 *   7. send_sms (Dave)  -> the lead's contact info to the agent who claimed it
 *                          (gated).
 *   8. send_email (Amy) -> the "QT" with the screenshot attached (gated).
 *   9. send_sms (lead)  -> marketing intro to the lead, with a quiet-hours email
 *                          fallback (gated).
 *  10. send_email (lead)-> the full HomeLight inquiry marketing email (gated),
 *                          optionally from Amy's connected mailbox.
 *  11. notify_owner     -> the outcome ({{vars.actions_taken}}), UNGATED so the
 *                          owner always learns what happened (claimed or not).
 *
 * Steps 5-10 carry `when: { var: "claimed_agent", notEquals: "none" }` so they
 * run ONLY after a teammate accepted; on owner fallback only notify_owner fires.
 *
 * Requires the claimed-agent gating + button-link extraction engine additions
 * (this PR) on BOTH the ai-flow-worker Edge function and the tenant render VPS,
 * and the "HomeLight" custom integration stored so the credentialed browse can
 * log in to the portal.
 *
 * Validated through the SAME `parseAiFlowDefinition` the dashboard + CRUD API
 * use. Dry-run by default; idempotent (won't create a 2nd flow with the same
 * name unless --force). Reads every tenant value from env/argv so the file stays
 * PII-free (the bundled defaults are overridable).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-homelight-lead-aiflow.ts                 # dry run
 *   npx tsx scripts/oneshot/seed-homelight-lead-aiflow.ts --apply         # insert (disabled)
 *   npx tsx scripts/oneshot/seed-homelight-lead-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_HOMELIGHT_INTEGRATION_LABEL    (default "Home Light" — must match the
 *                                          stored custom_integrations label EXACTLY)
 *   AIFLOW_HOMELIGHT_MATCH_TEXT           (default "HomeLight Referral")
 *   AIFLOW_HOMELIGHT_CLAIM_BUTTON_TEXT    (default "Call me to claim referral")
 *   AIFLOW_HOMELIGHT_AGENT_NAME           (default "Dave Lane")
 *   AIFLOW_HOMELIGHT_RESPONSE_MINUTES     (default 5)
 *   AIFLOW_HOMELIGHT_QT_EMAIL_TO          (default "amy@amylaidlaw.com")
 *   AIFLOW_HOMELIGHT_QT_SUBJECT           (default "{{vars.lead_name}} QT HL CC DAVE")
 *   AIFLOW_HOMELIGHT_LEAD_EMAIL_SUBJECT   (default see below)
 *   AIFLOW_HOMELIGHT_LEAD_EMAIL_BODY      (default see below)
 *   AIFLOW_HOMELIGHT_LEAD_SMS             (default condensed of the email)
 *   AIFLOW_HOMELIGHT_LEAD_EMAIL_CONNECTION_ID (Amy's Outlook connection uuid; omit = default mailbox)
 *   AIFLOW_HOMELIGHT_OWNER_TZ             (default "America/Phoenix")
 *   AIFLOW_HOMELIGHT_EMAIL_CONNECTION_ID  (mailbox the HomeLight alert lands in for the
 *                                          address/phone email FALLBACK; default Amy's Outlook)
 *   AIFLOW_HOMELIGHT_EMAIL_FROM_CONTAINS  (default "homelight.com")
 *   AIFLOW_HOMELIGHT_EMAIL_LOOKBACK_MIN   (default 60)
 *
 * Exit codes: 0 seeded/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";

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

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

// Amy's connected Outlook mailbox (workspace_oauth_connections.id) where the
// HomeLight "Client Details" alert emails arrive — the email_extract fallback
// reads it. Override with AIFLOW_HOMELIGHT_EMAIL_CONNECTION_ID for another tenant.
const DEFAULT_EMAIL_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

const DEFAULT_LEAD_EMAIL_SUBJECT =
  "Regarding your recent Inquiry to Sell your Home on HomeLight";

// The owner-provided marketing copy. {{vars.lead_first_name}} comes from the
// alert text (step 2), so the greeting renders even before the portal card loads.
const DEFAULT_LEAD_EMAIL_BODY =
  "Hi {{vars.lead_first_name}},\n\n" +
  "Re: Your recent inquiry online & the value of your home with HomeLight.com.\n\n" +
  "I'm an excellent negotiator and have it down to an Art Form on how I negotiate " +
  "offers and create bidding wars in this market for your home. Call me today to " +
  "claim your FREE listing appraisal! 602-695-1142. I'd love to help you.\n\n" +
  "I'm licensed since 1989. One of the top agents in Arizona. I have systems in " +
  "place to get your home listed and sold in one weekend with a bidding war getting " +
  "the price to escalate rapidly thousands above list price with the offer being " +
  "as is and waving the appraisal contingency most of the time. In addition I have " +
  "an appraiser as part of my team to help price your listing with precision from " +
  "the start as well as keeping buyers from lowballing you. I have a low flexible " +
  "commission. My goal is to make sure you are happy with your bottom line. I have " +
  "your bottom line 1st in mind!\n\n" +
  "When is a good time to discuss next steps for your free appraisal & to get your " +
  "home listed & sold?\n\n" +
  "Amy Laidlaw\nAmy@amylaidlaw.com\nHomeSmart\n602-695-1142";

// Condensed SMS version (kept well under the 1600-char cap).
const DEFAULT_LEAD_SMS =
  "Hi {{vars.lead_first_name}}, this is Amy Laidlaw (HomeSmart) re: your HomeLight " +
  "inquiry to sell your home. I'm a top AZ agent (licensed since 1989) and create " +
  "bidding wars that push offers thousands over list. Call me for your FREE listing " +
  "appraisal: 602-695-1142. When's a good time to talk?";

function buildDefinition(opts: {
  integrationLabel: string;
  matchText: string;
  claimButtonText: string;
  agentName: string;
  responseMinutes: number;
  qtEmailTo: string;
  qtSubject: string;
  leadEmailSubject: string;
  leadEmailBody: string;
  leadSms: string;
  leadEmailConnectionId: string | null;
  ownerTimezone: string;
  /** Connected mailbox (workspace_oauth_connections.id) HomeLight alerts land in; "" disables the email fallback. */
  emailConnectionId: string;
  /** Sender filter for the HomeLight alert email. */
  emailFromContains: string;
  /** How far back to look for the alert email (minutes). */
  emailLookbackMinutes: number;
}): unknown {
  // Gate for every post-claim step: run only when a teammate accepted the lead.
  const gateOnClaim = { var: "claimed_agent", notEquals: "none" } as const;
  const offerWindow = {
    timezone: opts.ownerTimezone,
    quietStart: "21:00",
    quietEnd: "08:30",
    graceMinutes: 10
  };

  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "has_url" },
        { type: "contains", value: opts.matchText, caseInsensitive: true }
      ]
    },
    steps: [
      // 1. The hmlt.co lead link.
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      // 2. Read the alert text (e.g. "Javier - $429K seller in Mesa, AZ") for the
      //    fields the offer/marketing copy needs before the portal card loads.
      {
        id: "alert",
        type: "extract_text",
        fields: [
          { name: "lead_first_name", description: "The lead's first name from the alert" },
          { name: "price", description: "The listing/asking price from the alert, e.g. $429K" },
          {
            name: "price_digits",
            description:
              "The price's leading digits ONLY — no $, commas, K or M. For $429K answer " +
              "429; for $264,000 answer 264. Used to match this lead against the portal " +
              "alert email, which writes the price in full (e.g. $429,000), so the bare " +
              "leading digits are the token that reliably appears in BOTH."
          },
          { name: "city", description: "The city/area from the alert, e.g. Mesa, AZ" },
          {
            name: "lead_type",
            description:
              "Is the lead a buyer or a seller? Answer exactly one lowercase word: buyer or seller."
          }
        ]
      },
      // 3. Open the lead link, screenshot it, and capture the claim button's href.
      //    Links-only browse_extract (no AI field extraction) — just the screenshot
      //    and the direct claim URL. This pre-claim referral-page screenshot lands
      //    in {{vars.screenshot_path}} and is what step 4 (route) attaches to
      //    Dave's offer MMS, because route runs BEFORE the step-5 card re-shoots it.
      {
        id: "open",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: opts.integrationLabel },
        screenshot: true,
        extractLinks: [{ name: "claim_link", matchText: opts.claimButtonText }]
      },
      // 4. Offer to Dave only (agentName pins the roster pick — no rotation), with
      //    BOTH links clearly labeled and a short claim window. Owner fallback to
      //    Amy. Sets {{vars.claimed_agent}} for the gated steps below.
      {
        id: "route",
        type: "route_to_team",
        agentName: opts.agentName,
        responseMinutes: opts.responseMinutes,
        offerWindow,
        attachScreenshot: true,
        // "2, <eta>" (or a bare "2") is the accept-with-timeframe option; there is
        // no "pass" digit on this pinned, Dave-only offer.
        claimTimeframeOption: 2,
        offerTemplate:
          "New HomeLight referral: {{vars.lead_first_name}} — {{vars.lead_type}} in " +
          "{{vars.city}} (~{{vars.price}}).\n" +
          "Tap to claim: {{vars.leadUrl}}\n" +
          "Direct claim button: {{vars.claim_link}}\n" +
          "Reply 1 to confirm you're taking it by {{offer.deadline}}.\n" +
          'Reply 2 with a timeframe to claim and tell us when you\'ll reach out ' +
          '(e.g. "2, 20 min").',
        ownerFallbackTemplate:
          "Dave didn't claim the HomeLight referral {{vars.lead_first_name}} " +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}) in time — it's back to you.\n" +
          "Tap to claim: {{vars.leadUrl}}",
        claimedNotifyTemplate:
          "{{agent.name}} claimed the HomeLight referral {{vars.lead_first_name}} " +
          "({{vars.lead_type}} in {{vars.city}})."
      },
      // 5. Re-open the (now claimed) lead link and read the real contact card off
      //    the portal. GATED — only runs after Dave accepted. screenshot:true here
      //    DELIBERATELY overwrites {{vars.screenshot_path}} with the post-claim
      //    contact-card image (lead name/phone/email/address) — that richer "QT"
      //    is exactly what step 8 attaches to Amy's email. Dave's offer MMS already
      //    fired in step 4 with the pre-claim referral-page shot, so re-shooting
      //    here doesn't affect what he received.
      {
        id: "card",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: opts.integrationLabel },
        screenshot: true,
        when: gateOnClaim,
        fields: [
          { name: "lead_name", description: "The lead's full name from the portal contact card" },
          {
            name: "lead_phone",
            description: "The lead's mobile phone from the contact card, in E.164 if possible"
          },
          { name: "lead_email", description: "The lead's email from the contact card, or 'none'" },
          { name: "lead_address", description: "The property street address from the contact card" }
        ]
      },
      // 5b. Fallback: if the portal contact card was delayed/empty, read the
      //     HomeLight "Client Details" alert email (it lists Phone/Email/Address
      //     in plain labels) from Amy's connected mailbox and BACKFILL the missing
      //     fields, so Dave always has the phone + property address to call back
      //     on. fillOnlyEmpty means the portal values (step 5) win; the email only
      //     fills gaps. Matched to THIS lead by first name AND price within the
      //     window (both must appear), so two leads who share a first name in the
      //     same window don't collide. Price beats city as the second term because a
      //     realtor works one city (so city repeats across leads) while the exact
      //     price is near-unique. We match price_digits (e.g. "429"), not "$429K",
      //     because the portal email writes the price in full ("$429,000") — the
      //     bare leading digits are the token present in BOTH. Gated on claim and
      //     only when a mailbox is configured.
      ...(opts.emailConnectionId
        ? [
            {
              id: "email_card",
              type: "email_extract",
              connectionId: opts.emailConnectionId,
              fromContains: opts.emailFromContains,
              matchTemplates: ["{{vars.lead_first_name}}", "{{vars.price_digits}}"],
              lookbackMinutes: opts.emailLookbackMinutes,
              fillOnlyEmpty: true,
              when: gateOnClaim,
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
                  description: "The property street address, labeled 'Address' in the HomeLight email"
                }
              ]
            }
          ]
        : []),
      // 6. File the lead so it shows on the Contacts page with a name + email.
      {
        id: "save_contact",
        type: "upsert_customer",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email",
        when: gateOnClaim
      },
      // 7. Send the lead's contact info to the agent who claimed it.
      {
        id: "to_agent",
        type: "send_sms",
        toAgentName: opts.agentName,
        body:
          "HomeLight lead is yours: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\n" +
          "Address: {{vars.lead_address}}\n" +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}})",
        when: gateOnClaim
      },
      // 8. Email Amy the "QT" — the post-claim contact-card screenshot captured in
      //    step 5 (the latest {{vars.screenshot_path}}), i.e. the lead's details.
      {
        id: "qt_email",
        type: "send_email",
        to: opts.qtEmailTo,
        subject: opts.qtSubject,
        body:
          "HomeLight referral claimed by {{vars.claimed_agent}}.\n" +
          "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
          "Address: {{vars.lead_address}}\n" +
          "{{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}\n" +
          "Lead source: HomeLight\n\n" +
          "Original alert:\n{{trigger.windowText}}\n\nQT attached.",
        attachScreenshot: true,
        when: gateOnClaim
      },
      // 9. Text the lead the marketing intro; inside quiet hours, defer and email
      //    the same body instead (quiet-hours fallback).
      {
        id: "lead_sms",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: opts.leadSms,
        quietHours: {
          timezone: opts.ownerTimezone,
          noSendAfter: "21:00",
          resumeAt: "08:00",
          emailFallbackVar: "lead_email",
          emailSubject: opts.leadEmailSubject,
          ...(opts.leadEmailConnectionId
            ? { emailFromConnectionId: opts.leadEmailConnectionId }
            : {})
        },
        when: gateOnClaim
      },
      // 10. Email the lead the full HomeLight inquiry marketing email. If the
      //     portal card had no email, {{vars.lead_email}} is "none" and the
      //     worker skips the send (it doesn't fail the run) — the SMS in step 9
      //     still reaches the lead.
      {
        id: "lead_email",
        type: "send_email",
        to: "{{vars.lead_email}}",
        subject: opts.leadEmailSubject,
        body: opts.leadEmailBody,
        ...(opts.leadEmailConnectionId ? { fromConnectionId: opts.leadEmailConnectionId } : {}),
        when: gateOnClaim
      },
      // 11. Always tell the owner the outcome — claimed (with everything that was
      //     sent) or not (owner fallback). Ungated.
      {
        id: "notify",
        type: "notify_owner",
        message:
          "HomeLight referral: {{vars.lead_first_name}} ({{vars.lead_type}} in {{vars.city}}, " +
          "~{{vars.price}}).\nOutcome: {{vars.actions_taken}}."
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

  const name = process.env.AIFLOW_SEED_NAME ?? "HomeLight Referral";
  const responseMinutes = Number(process.env.AIFLOW_HOMELIGHT_RESPONSE_MINUTES ?? "5");
  if (!Number.isInteger(responseMinutes) || responseMinutes < 1) {
    console.error("AIFLOW_HOMELIGHT_RESPONSE_MINUTES must be a positive integer");
    process.exit(2);
  }

  const definitionInput = buildDefinition({
    integrationLabel: process.env.AIFLOW_HOMELIGHT_INTEGRATION_LABEL ?? "Home Light",
    matchText: process.env.AIFLOW_HOMELIGHT_MATCH_TEXT ?? "HomeLight Referral",
    claimButtonText:
      process.env.AIFLOW_HOMELIGHT_CLAIM_BUTTON_TEXT ?? "Call me to claim referral",
    agentName: process.env.AIFLOW_HOMELIGHT_AGENT_NAME ?? "Dave Lane",
    responseMinutes,
    qtEmailTo: process.env.AIFLOW_HOMELIGHT_QT_EMAIL_TO ?? "amy@amylaidlaw.com",
    qtSubject: process.env.AIFLOW_HOMELIGHT_QT_SUBJECT ?? "{{vars.lead_name}} QT HL CC DAVE",
    leadEmailSubject:
      process.env.AIFLOW_HOMELIGHT_LEAD_EMAIL_SUBJECT ?? DEFAULT_LEAD_EMAIL_SUBJECT,
    leadEmailBody: process.env.AIFLOW_HOMELIGHT_LEAD_EMAIL_BODY ?? DEFAULT_LEAD_EMAIL_BODY,
    leadSms: process.env.AIFLOW_HOMELIGHT_LEAD_SMS ?? DEFAULT_LEAD_SMS,
    leadEmailConnectionId: process.env.AIFLOW_HOMELIGHT_LEAD_EMAIL_CONNECTION_ID ?? null,
    ownerTimezone: process.env.AIFLOW_HOMELIGHT_OWNER_TZ ?? "America/Phoenix",
    emailConnectionId:
      process.env.AIFLOW_HOMELIGHT_EMAIL_CONNECTION_ID ?? DEFAULT_EMAIL_CONNECTION_ID,
    emailFromContains: process.env.AIFLOW_HOMELIGHT_EMAIL_FROM_CONTAINS ?? "homelight.com",
    emailLookbackMinutes: Number(process.env.AIFLOW_HOMELIGHT_EMAIL_LOOKBACK_MIN ?? "60")
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
  if (!args.enable) {
    console.log("Review it in /dashboard/aiflows and toggle it on when ready.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
