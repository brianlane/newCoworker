/**
 * One-shot: validate + insert Truly's Lead Management flows (all DISABLED)
 * through the same parseAiFlowDefinition gate the API uses.
 *
 *   1. "Lead intake & follow-up (Privyr)" — replaces the two disabled
 *      "Leads Nurturing" drafts (they are deleted on --write).
 *   2. "Post-appointment follow-up" — courteous follow-up + broker outcome ask.
 *   3. Amends the existing 24h reminder flow with an update_contact step that
 *      tags "Appointment Scheduled".
 *
 * Usage: npx tsx debug/tmp-truly-lead-flows.ts [--write]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { parseAiFlowDefinition, summarizeDefinition } = await import("../src/lib/ai-flows/schema.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");

const BIZ = "690f85c0-ee16-4ee5-bde5-5829df2e5410";
const OLD_DRAFT_IDS = [
  "0f8ffb43-5b10-4a19-87db-48048774ab54",
  "b64eceaa-8920-4ea8-9c00-c3b784a9e393"
];
const REMINDER_24H_ID = "c491987c-ac9a-4d9c-ac7d-ce263770dc2e";

// ── Flow 1: lead intake, ack, follow-up sequence, broker routing ────────────
const leadFlow = {
  version: 1,
  trigger: {
    channel: "tenant_email",
    conditions: [{ type: "contains", value: "Privyr", caseInsensitive: true }]
  },
  // PRD business-hours rule: communication steps hold 21:00–08:00 (the run
  // defers and resumes in the morning). All seven days — leads are weekend
  // business for insurance shoppers.
  timeWindow: { timezone: "America/New_York", start: "08:00", end: "21:00" },
  steps: [
    {
      id: "extract",
      type: "extract_text",
      fields: [
        { name: "lead_name", description: "The lead's full name" },
        { name: "lead_phone", description: "The lead's phone number" },
        { name: "lead_email", description: "The lead's email address" },
        { name: "product", description: "What they want to insure (auto, home, business...)" }
      ]
    },
    {
      id: "save_contact",
      type: "upsert_customer",
      phoneVar: "lead_phone",
      nameVar: "lead_name",
      emailVar: "lead_email"
    },
    { id: "tag_new", type: "update_contact", phoneVar: "lead_phone", addTags: ["New Lead"] },
    {
      id: "ack",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body:
        "Hi {{vars.lead_name}}! Thanks for requesting a quote from Truly Insurance. I'm Truly's virtual assistant and I'll help get you connected with one of our licensed brokers. What prompted you to shop around today?"
    },
    {
      id: "tag_contacted",
      type: "update_contact",
      phoneVar: "lead_phone",
      removeTags: ["New Lead"],
      addTags: ["Contacted"]
    },
    {
      id: "wait_intro",
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_text",
      timeoutMinutes: 120
    },
    {
      id: "reply_fork",
      type: "branch",
      question: "Did the lead respond to the intro?",
      branches: [
        {
          id: "arm_called",
          label: "Called in",
          condition: { var: "reply_text", equals: "customer_called" },
          steps: [
            {
              id: "called_note",
              type: "notify_owner",
              message:
                "{{vars.lead_name}} ({{vars.lead_phone}}) called the office instead of texting back — their automated follow-ups are paused. Update their status on the Contacts page after the call."
            }
          ]
        },
        {
          id: "arm_replied",
          label: "Replied",
          condition: { var: "reply_text", notEquals: "no_reply" },
          steps: [
            {
              id: "continue_convo",
              type: "send_sms",
              to: "{{vars.lead_phone}}",
              body:
                "Thanks for sharing that — I've made a note for your broker. Approximately when does your current policy renew?"
            },
            {
              id: "tag_engaged",
              type: "update_contact",
              phoneVar: "lead_phone",
              removeTags: ["Contacted"],
              addTags: ["Engaged"]
            },
            {
              id: "offer_team",
              type: "route_to_team",
              preferContactOwner: true,
              responseMinutes: 10,
              offerWindow: {
                timezone: "America/New_York",
                quietStart: "21:00",
                quietEnd: "08:30",
                graceMinutes: 15
              },
              offerTemplate:
                "New Truly lead: {{vars.lead_name}} ({{vars.lead_phone}}) — {{vars.product}}. They just replied: \"{{vars.reply_text}}\". Reply 1 to claim or 2 to pass by {{offer.deadline}}. The assistant is booking them a call.",
              ownerFallbackTemplate:
                "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) — {{vars.product}}. Back to you.",
              claimedNotifyTemplate:
                "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}})."
            }
          ]
        }
      ],
      else: [
        {
          id: "nudge1",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}! Just checking in to see if you're still interested in reviewing your insurance options. Whenever you're ready, we can pick up right where we left off."
        },
        {
          id: "wait2",
          type: "wait_for_reply",
          phoneVar: "lead_phone",
          saveAs: "reply2",
          timeoutMinutes: 1440
        },
        {
          id: "late_engaged_1",
          type: "update_contact",
          phoneVar: "lead_phone",
          removeTags: ["Contacted"],
          addTags: ["Engaged"],
          when: { var: "reply2", notEquals: "no_reply" }
        },
        {
          id: "nudge2",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}, one of our licensed brokers would be happy to review your options whenever it suits you — no pressure at all. Would a quick call this week work?",
          when: { var: "reply2", equals: "no_reply" }
        },
        {
          id: "wait3",
          type: "wait_for_reply",
          phoneVar: "lead_phone",
          saveAs: "reply3",
          timeoutMinutes: 4320,
          when: { var: "reply2", equals: "no_reply" }
        },
        {
          id: "late_engaged_2",
          type: "update_contact",
          phoneVar: "lead_phone",
          removeTags: ["Contacted"],
          addTags: ["Engaged"],
          when: { var: "reply3", notEquals: "no_reply" }
        },
        {
          id: "final_touch",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}, we'll leave you be for now — if you'd ever like a no-pressure review of your insurance options, just reply here and we'll pick up right where we left off. Thanks for considering Truly Insurance!",
          when: { var: "reply3", equals: "no_reply" }
        },
        {
          id: "tag_inactive",
          type: "update_contact",
          phoneVar: "lead_phone",
          removeTags: ["New Lead", "Contacted", "Engaged"],
          addTags: ["Inactive"],
          when: { var: "reply3", equals: "no_reply" }
        }
      ]
    }
  ],
  options: { suppressDefaultReply: false }
};

// ── Flow 2: post-appointment follow-up (attended or missed) ─────────────────
const postAppointment = {
  version: 1,
  trigger: {
    channel: "calendar",
    on: "event_start",
    leadMinutes: 5,
    calendar: "shared",
    conditions: []
  },
  steps: [
    {
      id: "extract",
      type: "extract_text",
      fields: [
        { name: "customer_phone", description: "The attendee's phone number (the Phone: line)" },
        { name: "customer_name", description: "The attendee's name (the Attendee: line)" }
      ]
    },
    // Fires 5 min before the start; sleep past a typical appointment.
    { id: "wait_out", type: "sleep", minutes: 75 },
    {
      id: "follow_up",
      type: "send_sms",
      to: "{{vars.customer_phone}}",
      body:
        "Hi {{vars.customer_name}}, thanks for connecting with Truly Insurance today. If you missed your call or would like more time with your broker, just reply here and I'll happily set up another time."
    },
    {
      id: "clear_tag",
      type: "update_contact",
      phoneVar: "customer_phone",
      removeTags: ["Appointment Scheduled"]
    },
    {
      id: "broker_ask",
      type: "notify_owner",
      message:
        "The appointment with {{vars.customer_name}} ({{trigger.event_title}}) just wrapped. Please update their status on the Contacts page — Quote in Progress / Won / Lost — or, if they were a no-show, reply to their text and I'll rebook them."
    }
  ],
  options: { suppressDefaultReply: false }
};

// ── Amendment: 24h reminder flow also tags "Appointment Scheduled" ──────────
const reminder24hAmended = {
  version: 1,
  trigger: {
    channel: "calendar",
    on: "event_start",
    leadMinutes: 1440,
    calendar: "shared",
    conditions: []
  },
  steps: [
    {
      id: "s1",
      type: "extract_text",
      fields: [
        { name: "customer_phone", description: "The attendee's phone number (the Phone: line)" },
        { name: "customer_name", description: "The attendee's name (the Attendee: line)" }
      ]
    },
    {
      id: "tag_scheduled",
      type: "update_contact",
      phoneVar: "customer_phone",
      removeTags: ["Contacted", "Engaged"],
      addTags: ["Appointment Scheduled"]
    },
    {
      id: "s2",
      type: "send_sms",
      to: "{{vars.customer_phone}}",
      body:
        "Hi {{vars.customer_name}}, a friendly reminder from Truly Insurance: your call with one of our licensed brokers is booked for tomorrow ({{trigger.event_title}}). Reply here if you need to reschedule — happy to find another time."
    }
  ],
  options: { suppressDefaultReply: false }
};

const flows = [
  { name: "Lead intake & follow-up (Privyr)", definition: leadFlow },
  { name: "Post-appointment follow-up", definition: postAppointment }
];

for (const f of flows) {
  const parsed = parseAiFlowDefinition(f.definition);
  console.log(`[valid] ${f.name}: ${summarizeDefinition(parsed)}`);
}
parseAiFlowDefinition(reminder24hAmended);
console.log("[valid] 24h reminder amendment");

if (process.argv.includes("--write")) {
  const db = await createSupabaseServiceClient();
  for (const f of flows) {
    const { data, error } = await db
      .from("ai_flows")
      .insert({
        business_id: BIZ,
        name: f.name,
        enabled: false,
        definition: parseAiFlowDefinition(f.definition)
      })
      .select("id")
      .single();
    if (error) throw new Error(`${f.name}: ${error.message}`);
    console.log(`[created DISABLED] ${f.name} → ${data!.id}`);
  }
  const { error: amendErr } = await db
    .from("ai_flows")
    .update({ definition: parseAiFlowDefinition(reminder24hAmended) })
    .eq("id", REMINDER_24H_ID)
    .eq("business_id", BIZ);
  if (amendErr) throw new Error(`reminder amend: ${amendErr.message}`);
  console.log("[amended] 24h reminder now tags Appointment Scheduled (still disabled)");
  const { error: delErr } = await db
    .from("ai_flows")
    .delete()
    .in("id", OLD_DRAFT_IDS)
    .eq("business_id", BIZ)
    .eq("enabled", false);
  if (delErr) throw new Error(`old draft cleanup: ${delErr.message}`);
  console.log("[removed] 2 old 'Leads Nurturing' drafts");
}
