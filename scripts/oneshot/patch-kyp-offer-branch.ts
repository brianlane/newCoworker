/**
 * patch-kyp-offer-branch.ts — KYP Ads lead follow-up offer routing.
 *
 * $100/week path (deterministic, no LLM classify):
 *   - Facebook form "Simple form setup 5/7/26…"
 *   - Any form_name mentioning 100/week
 * Everything else → $200/week (default Meta lead-gen path).
 *
 * ASSUMPTION: leads arrive via the Zapier bridge ("Send Lead to Coworker"),
 * whose Lead Fields include the Facebook form_name — that's what
 * lead_form_name extracts from. The DIRECT Meta connection enqueues form_id
 * (no form title), so name-based routing would fall through to the $200
 * else-arm there. KYP has no meta_connections row (bridge-only tenant); if
 * they ever switch to the direct connection, revisit this routing (match on
 * form_id, or map ids → offers).
 *
 * Usage (business id from --business or KYP_BUSINESS_ID — never hard-coded,
 * per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-offer-branch.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kyp-offer-branch.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KYP_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
  process.exit(1);
}
const FLOW_NAME = "Lead follow-up (white-glove build)";

const LINK_100 = "calendly.com/james-kyp-ads/my-free-scale-plan";
const LINK_200 = "https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2";

const GREETING_BASE =
  "Hey {{vars.lead_name}}, thanks for your interest in KYP Ads! I saw you're in {{vars.lead_industry}} " +
  "and looking to grow your leads. I'd love to map out a plan for your business on a quick free strategy call. " +
  "You can grab a time here: ";

function nudgeBody(attempt: number, bookingLink: string): string {
  if (attempt === 1) {
    return (
      "Hey {{vars.lead_name}}, just floating this back up — happy to answer any questions whenever you're ready. " +
      `You can grab a time here: ${bookingLink}`
    );
  }
  if (attempt === 2) {
    return (
      "Hi {{vars.lead_name}}, I don't want you to slip through the cracks! " +
      `Booking only takes a minute: ${bookingLink}`
    );
  }
  return (
    "Hey {{vars.lead_name}}, still here whenever you're ready — grab a time that works: " + bookingLink
  );
}

type FlowStepJson = Record<string, unknown>;

function offerArmSteps(prefix: string, bookingLink: string, offerLabel: string): FlowStepJson[] {
  const steps: FlowStepJson[] = [
    {
      id: `${prefix}_greet`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: GREETING_BASE + bookingLink
    },
    {
      id: `${prefix}_notify`,
      type: "notify_owner",
      message:
        `New ${offerLabel} lead: {{vars.lead_name}} — {{vars.lead_phone}} / {{vars.lead_email}}. ` +
        "Details: {{vars.lead_notes}}. I sent them your greeting and I'm on follow-up duty."
    }
  ];

  for (let i = 1; i <= 3; i++) {
    const replyVar = `reply_${i}`;
    steps.push({
      id: `${prefix}_wait_${i}`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: replyVar,
      timeoutMinutes: i === 1 ? 120 : 1440,
      ...(i > 1 ? { when: { var: `reply_${i - 1}`, equals: "no_reply" } } : {})
    });
    steps.push({
      id: `${prefix}_nudge_${i}`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: nudgeBody(i, bookingLink),
      when: { var: replyVar, equals: "no_reply" }
    });
  }

  steps.push(
    {
      id: `${prefix}_wait_final`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_final",
      timeoutMinutes: 1440,
      when: { var: "reply_3", equals: "no_reply" }
    },
    {
      id: `${prefix}_flag_owner`,
      type: "notify_owner",
      message:
        "Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) hasn't replied to 3 follow-ups. " +
        "I've marked them Inactive — they're never deleted, and if they reply later the conversation picks right back up.",
      when: { var: "reply_final", equals: "no_reply" }
    },
    {
      id: `${prefix}_mark_inactive`,
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: ["Inactive"],
      when: { var: "reply_final", equals: "no_reply" }
    }
  );

  return steps;
}

const ARM_100 = offerArmSteps("s100", LINK_100, "$100/week");

function buildDefinition(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "webhook", conditions: [] },
    steps: [
      {
        id: "s_extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number, digits and + only" },
          { name: "lead_email", description: "The lead's email address" },
          {
            name: "lead_notes",
            description:
              "Everything else the lead provided: custom question answers, city, budget, timeframe. 'none' if nothing."
          },
          {
            name: "lead_industry",
            description:
              'The lead\'s industry from the lead form; if not provided, a short natural fallback like "your industry"'
          },
          {
            name: "lead_form_name",
            description:
              "The Facebook lead form name (form_name field from the webhook payload); 'unknown' if missing."
          }
        ]
      },
      {
        id: "s_file",
        type: "upsert_customer",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email"
      },
      {
        id: "s_branch_offer",
        type: "branch",
        question: "Route by offer",
        branches: [
          {
            id: "arm_simple_form",
            label: "$100/week (Simple form)",
            condition: {
              var: "lead_form_name",
              contains: "Simple form setup 5/7/26",
              caseInsensitive: true
            },
            steps: ARM_100
          },
          {
            id: "arm_100_week",
            label: "$100/week (form says 100/week)",
            condition: {
              var: "lead_form_name",
              contains: "100/week",
              caseInsensitive: true
            },
            steps: offerArmSteps("s100b", LINK_100, "$100/week")
          }
        ],
        else: offerArmSteps("s200", LINK_200, "$200/week")
      },
      {
        id: "s_goal",
        type: "goal",
        label: "Lead replied or booked",
        events: [{ kind: "replied" }, { kind: "appointment_booked" }]
      }
    ]
  };
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: row, error: fetchErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();

if (fetchErr || !row) {
  console.error("[oneshot] flow not found:", fetchErr?.message ?? FLOW_NAME);
  process.exit(1);
}

let definition;
try {
  definition = parseAiFlowDefinition(buildDefinition());
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("[oneshot] validation failed:", err.issues);
  } else {
    console.error("[oneshot] validation failed:", err);
  }
  process.exit(1);
}

console.log("[oneshot] target:", { businessId: BUSINESS_ID, flowId: row.id, enabled: row.enabled });
console.log("[oneshot] new definition:", summarizeDefinition(definition));
console.log(
  "[oneshot] routing: Simple form setup 5/7/26 OR form_name contains 100/week → $100; else → $200"
);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const { error: updateErr } = await db
  .from("ai_flows")
  .update({ definition, updated_at: new Date().toISOString() })
  .eq("id", row.id)
  .eq("business_id", BUSINESS_ID);

if (updateErr) {
  console.error("[oneshot] update failed:", updateErr.message);
  process.exit(1);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    flow_id: row.id,
    flow_name: FLOW_NAME,
    offer_routing: "simple_form_and_100_week_vs_else_200"
  }
});

console.log("[oneshot] applied.");
