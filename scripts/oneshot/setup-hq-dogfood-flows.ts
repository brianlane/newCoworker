/**
 * setup-hq-dogfood-flows.ts — one-shot: author the HQ tenant's sales-funnel
 * AiFlows (the "HQ works for New Coworker" dogfooding plan):
 *
 *   1. "Demo caller follow-up (HQ)"  — contact_created, tag "Voice Capture"
 *      (fired by the capture-contact promotion, PR #771): recap SMS with the
 *      pricing/signup pitch (quiet-hours deferred, email fallback), a 2-day
 *      reply wait, owner notify on any reply, one gentle nudge on silence,
 *      and an appointment_booked goal so a booked lead skips the nudge.
 *   2. "Webchat lead follow-up (HQ)" — same shape for tag "Webchat Lead".
 *   3. "Contact form triage (HQ)"    — webhook source "contact_form" (fed by
 *      the admin contact-form sink, PR #773): extract + owner notify.
 *
 * Flows are upserted BY NAME (idempotent re-runs refresh the definition) and
 * created ENABLED — they cannot fire until the upstream PRs deploy, and
 * enabling then requires no second pass. Every definition passes
 * parseAiFlowDefinition before any write.
 *
 * Usage:
 *   npx tsx scripts/oneshot/setup-hq-dogfood-flows.ts          # dry-run
 *   npx tsx scripts/oneshot/setup-hq-dogfood-flows.ts --apply  # write flows
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const HQ_TZ = "America/Phoenix";

const { parseAiFlowDefinition } = await import("../../src/lib/ai-flows/schema.ts");
const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

type FlowSpec = { name: string; definition: unknown };

const QUIET_HOURS = {
  timezone: HQ_TZ,
  noSendAfter: "20:00",
  resumeAt: "08:00",
  emailFallbackVar: "lead_email",
  emailSubject: "Thanks for trying New Coworker"
};

const EXTRACT_LEAD_FIELDS = [
  {
    name: "lead_name",
    description: "The lead's first name only; 'there' when no name is present"
  },
  {
    name: "lead_phone",
    description: "The lead's phone number exactly as shown, digits and + only"
  },
  {
    name: "lead_email",
    description: "The lead's email address; 'none' when not present"
  }
];

/** Shared tail: wait → notify on reply → nudge on silence → booked goal. */
function followUpTail(sourceLabel: string) {
  return [
    {
      id: "s_wait",
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_text",
      timeoutMinutes: 2880
    },
    {
      id: "s_notify_reply",
      type: "notify_owner",
      when: { var: "reply_text", notEquals: "no_reply" },
      message:
        `${sourceLabel} lead {{vars.lead_name}} ({{vars.lead_phone}}) replied: ` +
        "{{vars.reply_text}}"
    },
    {
      id: "s_nudge",
      type: "send_sms",
      when: { var: "reply_text", equals: "no_reply" },
      to: "{{vars.lead_phone}}",
      quietHours: QUIET_HOURS,
      body:
        "Quick follow-up from New Coworker — if you'd like your own AI coworker " +
        "answering your business calls and texts, setup takes about 10 minutes at " +
        "newcoworker.com. Reply here any time and the team will help."
    },
    {
      id: "s_goal_booked",
      type: "goal",
      label: "Appointment booked",
      events: [{ kind: "appointment_booked" }]
    }
  ];
}

const FLOWS: FlowSpec[] = [
  {
    name: "Demo caller follow-up (HQ)",
    definition: {
      version: 1,
      trigger: {
        channel: "contact_created",
        conditions: [{ type: "contains", value: "Voice Capture" }]
      },
      steps: [
        { id: "s_extract", type: "extract_text", fields: EXTRACT_LEAD_FIELDS },
        {
          id: "s_intro",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          quietHours: QUIET_HOURS,
          body:
            "Hi {{vars.lead_name}} — thanks for calling the New Coworker demo line! " +
            "You just talked to the product itself: a 24/7 AI coworker that answers " +
            "calls and texts, books appointments, and follows up (like right now). " +
            "Plans start at $9.99/mo — newcoworker.com. Reply here with any " +
            "questions and I'll pass them straight to the team."
        },
        ...followUpTail("Demo-line")
      ],
      options: { allowReentry: false }
    }
  },
  {
    name: "Webchat lead follow-up (HQ)",
    definition: {
      version: 1,
      trigger: {
        channel: "contact_created",
        conditions: [{ type: "contains", value: "Webchat Lead" }]
      },
      steps: [
        { id: "s_extract", type: "extract_text", fields: EXTRACT_LEAD_FIELDS },
        {
          id: "s_intro",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          quietHours: QUIET_HOURS,
          body:
            "Hi {{vars.lead_name}} — thanks for chatting with us at newcoworker.com! " +
            "That chat was the product itself: a 24/7 AI coworker that answers calls " +
            "and texts, books appointments, and follows up (like right now). Plans " +
            "start at $9.99/mo. Reply here with any questions and I'll pass them " +
            "straight to the team."
        },
        ...followUpTail("Webchat")
      ],
      options: { allowReentry: false }
    }
  },
  {
    name: "Contact form triage (HQ)",
    definition: {
      version: 1,
      trigger: {
        channel: "webhook",
        conditions: [{ type: "from_matches", value: "contact_form" }]
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            { name: "sender_name", description: "The sender's name" },
            { name: "sender_email", description: "The sender's email address" },
            {
              name: "sender_business",
              description: "The sender's business name; 'none' when not given"
            },
            {
              name: "sender_topic",
              description:
                "The subject plus a one-sentence summary of what the sender wants"
            }
          ]
        },
        {
          id: "s_notify",
          type: "notify_owner",
          message:
            "Contact form: {{vars.sender_name}} ({{vars.sender_email}}, business: " +
            "{{vars.sender_business}}) — {{vars.sender_topic}}"
        }
      ]
    }
  }
];

// Validate every definition BEFORE any write — a schema failure aborts the
// whole run, apply or not.
for (const spec of FLOWS) {
  parseAiFlowDefinition(spec.definition);
  console.log(`[flows] "${spec.name}" definition valid`);
}

const db = await createSupabaseServiceClient();

const { data: hqBusiness, error: bizErr } = await db
  .from("businesses")
  .select("id, name")
  .eq("id", HQ_BUSINESS_ID)
  .maybeSingle();
if (bizErr || !hqBusiness) {
  console.error("[flows] HQ business not found — aborting", bizErr?.message ?? "");
  process.exit(1);
}

const { data: existingRows, error: listErr } = await db
  .from("ai_flows")
  .select("id, name, enabled")
  .eq("business_id", HQ_BUSINESS_ID)
  .in(
    "name",
    FLOWS.map((f) => f.name)
  );
if (listErr) {
  console.error("[flows] existing-flow lookup failed:", listErr.message);
  process.exit(1);
}
const existingByName = new Map(
  ((existingRows ?? []) as Array<{ id: string; name: string; enabled: boolean }>).map((r) => [
    r.name,
    r
  ])
);

for (const spec of FLOWS) {
  const existing = existingByName.get(spec.name);
  console.log(
    `[flows] "${spec.name}": ${existing ? `exists (id=${existing.id}) — will refresh` : "will create (enabled)"}`
  );
}

if (!APPLY) {
  console.log("[flows] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const flowIds: string[] = [];
for (const spec of FLOWS) {
  const existing = existingByName.get(spec.name);
  if (existing) {
    const { error } = await db
      .from("ai_flows")
      .update({ definition: spec.definition, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(`flow update (${spec.name}): ${error.message}`);
    flowIds.push(existing.id);
    console.log(`[flows] refreshed "${spec.name}" (id=${existing.id})`);
  } else {
    const { data, error } = await db
      .from("ai_flows")
      .insert({
        business_id: HQ_BUSINESS_ID,
        name: spec.name,
        enabled: true,
        definition: spec.definition
      })
      .select("id")
      .single();
    if (error) throw new Error(`flow insert (${spec.name}): ${error.message}`);
    flowIds.push((data as { id: string }).id);
    console.log(`[flows] created "${spec.name}" (id=${(data as { id: string }).id})`);
  }
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "setup-hq-dogfood-flows.ts",
  businessId: HQ_BUSINESS_ID,
  details: { flowIds, flowNames: FLOWS.map((f) => f.name) }
});
console.log("[flows] ledger recorded. Done.");
process.exit(0);
