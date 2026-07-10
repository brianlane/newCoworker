#!/usr/bin/env tsx
/**
 * One-shot: apply Truly Insurance's testing-feedback fixes to their two
 * Privyr lead-intake flows (the enabled "(copy)" and the disabled original;
 * the "(copy) Dania" experiment is deliberately untouched).
 *
 * 1. Late-reply dead end (their feedback item 2, the "Dawnia" case): the
 *    reply_fork else-arm used to capture a late reply into `reply2`, tag the
 *    contact Engaged, and END — no routing, no notification, and the wait
 *    suppressed the default assistant for that turn, so "I would like to
 *    book a call" got silence. The else-arm now forks on the late reply and
 *    mirrors the first-reply arm: classify (wants_a_call / not_interested /
 *    gave_info) and route_to_team with owner fallback.
 *
 * 2. Lead source visibility (their item 5): the tag_new step also tags the
 *    contact "Privyr", and the staff offer texts carry the source
 *    ("New Truly lead (Privyr): ...") so brokers see where the lead came
 *    from before claiming.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent
 * (re-running detects the already-patched shape). Dry-run by default.
 * Records to applied_oneshots on --apply. Does NOT enqueue any runs.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-truly-late-reply-and-source.ts          # dry run
 *   npx tsx scripts/oneshot/patch-truly-late-reply-and-source.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410"; // Truly Insurance
const FLOW_NAMES = [
  "Lead intake & follow-up (Privyr) (copy)", // enabled, live
  "Lead intake & follow-up (Privyr)" // disabled original, kept consistent
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };
type AnyStep = Record<string, unknown>;

async function loadFlow(name: string): Promise<Row> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`read "${name}": ${error.message}`);
  if (!data) throw new Error(`no "${name}" flow for business ${BUSINESS_ID}`);
  return data as Row;
}

const QUIET_HOURS = {
  timezone: "America/New_York",
  resumeAt: "08:00",
  noSendAfter: "21:00"
};
const OFFER_WINDOW = {
  timezone: "America/New_York",
  quietStart: "21:00",
  quietEnd: "08:30",
  graceMinutes: 15
};
const CLASSIFY_CATEGORIES = [
  {
    value: "wants_a_call",
    description: "asks to talk to someone, book, schedule, or be called now"
  },
  {
    value: "not_interested",
    description: "declines, says they're all set, or asks to stop texting"
  },
  {
    value: "gave_info",
    description: "shared details - a reason, renewal timing, or other info"
  }
];

/** The rebuilt reply_fork else-arm: nudge → wait → fork on the late reply. */
function buildLateReplyElse(nudge1: AnyStep, wait2: AnyStep): AnyStep[] {
  return [
    nudge1,
    wait2,
    {
      id: "late_fork",
      type: "branch",
      question: "Did the lead reply to the check-in?",
      branches: [
        {
          id: "arm_late_replied",
          label: "Replied late",
          condition: { var: "reply2", notEquals: "no_reply" },
          steps: [
            {
              id: "late_engaged_1",
              type: "update_contact",
              phoneVar: "lead_phone",
              addTags: ["Engaged"],
              removeTags: ["Contacted"]
            },
            {
              id: "classify_late",
              type: "classify",
              saveAs: "late_intent",
              textVar: "reply2",
              question:
                "An insurance lead was nudged about reviewing their options. This is their reply.",
              categories: CLASSIFY_CATEGORIES
            },
            {
              id: "late_intent_fork",
              type: "branch",
              question: "What does the lead want?",
              branches: [
                {
                  id: "arm_late_call",
                  label: "Wants a call",
                  condition: { var: "late_intent", equals: "wants_a_call" },
                  steps: [
                    {
                      id: "late_call_ack",
                      type: "send_sms",
                      to: "{{vars.lead_phone}}",
                      body: "Absolutely - I'll get you connected with one of our licensed brokers right away. You can also reply here anytime with a day and time that suits you best.",
                      quietHours: QUIET_HOURS
                    },
                    {
                      id: "late_offer_call",
                      type: "route_to_team",
                      offerTemplate:
                        'Hot Truly lead (Privyr) - WANTS A CALL: {{vars.lead_name}} ({{vars.lead_phone}}) - {{vars.product}}. Their reply: "{{vars.reply2}}". Reply 1 to claim or 2 to pass by {{offer.deadline}}.',
                      responseMinutes: 10,
                      preferContactOwner: true,
                      offerWindow: OFFER_WINDOW,
                      claimedNotifyTemplate:
                        "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}) - call requested.",
                      ownerFallbackTemplate:
                        "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - they asked for a call. Back to you."
                    }
                  ]
                },
                {
                  id: "arm_late_not_interested",
                  label: "Not interested",
                  condition: { var: "late_intent", equals: "not_interested" },
                  steps: [
                    {
                      id: "late_polite_close",
                      type: "send_sms",
                      to: "{{vars.lead_phone}}",
                      body: "No problem at all, {{vars.lead_name}} - thanks for letting us know. If anything changes, we'd be happy to help. Have a great day!",
                      quietHours: QUIET_HOURS
                    },
                    {
                      id: "late_tag_lost",
                      type: "update_contact",
                      phoneVar: "lead_phone",
                      addTags: ["Lost"],
                      removeTags: ["New Lead", "Contacted", "Engaged"]
                    },
                    {
                      id: "late_lost_note",
                      type: "notify_owner",
                      message:
                        '{{vars.lead_name}} ({{vars.lead_phone}}) said they\'re not interested - closed out politely and tagged Lost. Their reply: "{{vars.reply2}}"'
                    }
                  ]
                }
              ],
              else: [
                {
                  id: "late_continue",
                  type: "send_sms",
                  to: "{{vars.lead_phone}}",
                  body: "Thanks for getting back to us - I've made a note for your broker, and one of our licensed brokers will follow up with you shortly.",
                  quietHours: QUIET_HOURS
                },
                {
                  id: "late_offer_team",
                  type: "route_to_team",
                  offerTemplate:
                    'New Truly lead (Privyr): {{vars.lead_name}} ({{vars.lead_phone}}) - {{vars.product}}. They replied to the check-in: "{{vars.reply2}}". Reply 1 to claim or 2 to pass by {{offer.deadline}}.',
                  responseMinutes: 10,
                  preferContactOwner: true,
                  offerWindow: OFFER_WINDOW,
                  claimedNotifyTemplate:
                    "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}).",
                  ownerFallbackTemplate:
                    "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - {{vars.product}} (Privyr). Back to you."
                }
              ]
            }
          ]
        }
      ],
      // reply2 == "no_reply" is guaranteed here, so the old per-step `when`
      // guards on the nudge/wait pair are no longer needed; the reply3 ones
      // still are (the second wait can itself time out).
      else: [
        {
          id: "nudge2",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body: "Hi {{vars.lead_name}}, one of our licensed brokers would be happy to review your options whenever it suits you — no pressure at all. Would a quick call this week work?",
          quietHours: QUIET_HOURS
        },
        {
          id: "wait3",
          type: "wait_for_reply",
          phoneVar: "lead_phone",
          saveAs: "reply3",
          timeoutMinutes: 4320
        },
        {
          id: "late_engaged_2",
          type: "update_contact",
          when: { var: "reply3", notEquals: "no_reply" },
          phoneVar: "lead_phone",
          addTags: ["Engaged"],
          removeTags: ["Contacted"]
        },
        {
          id: "final_touch",
          type: "send_sms",
          when: { var: "reply3", equals: "no_reply" },
          to: "{{vars.lead_phone}}",
          body: "Hi {{vars.lead_name}}, we'll leave you be for now — if you'd ever like a no-pressure review of your insurance options, just reply here and we'll pick up right where we left off. Thanks for considering Truly Insurance!",
          quietHours: QUIET_HOURS
        },
        {
          id: "tag_inactive",
          type: "update_contact",
          when: { var: "reply3", equals: "no_reply" },
          phoneVar: "lead_phone",
          addTags: ["Inactive"],
          removeTags: ["New Lead", "Contacted", "Engaged"]
        }
      ]
    }
  ];
}

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: string[] } {
  const changed: string[] = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  // 2a. Source tag on the contact.
  const tagNew = steps.find((s) => s.id === "tag_new");
  if (tagNew && Array.isArray(tagNew.addTags) && !tagNew.addTags.includes("Privyr")) {
    tagNew.addTags = [...(tagNew.addTags as string[]), "Privyr"];
    changed.push("tag_new: +Privyr source tag");
  }

  // 2b. Source in the staff offer texts (deep walk: route steps live inside
  // branch arms).
  const renameOffers = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.type === "route_to_team" && typeof step.offerTemplate === "string") {
        const before = step.offerTemplate as string;
        step.offerTemplate = before
          .replace(/^New Truly lead:/, "New Truly lead (Privyr):")
          .replace(/^Hot Truly lead - WANTS A CALL:/, "Hot Truly lead (Privyr) - WANTS A CALL:");
        if (step.offerTemplate !== before) changed.push(`${step.id}: offer text carries (Privyr)`);
      }
      if (step.type === "branch") {
        for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) {
          renameOffers(arm.steps);
        }
        if (Array.isArray(step.else)) renameOffers(step.else as AnyStep[]);
      }
    }
  };
  renameOffers(steps);

  // 1. Rebuild the reply_fork else-arm unless already patched.
  const replyFork = steps.find((s) => s.id === "reply_fork" && s.type === "branch");
  if (!replyFork) throw new Error("reply_fork branch step not found — flow shape changed?");
  const elseSteps = (replyFork.else ?? []) as AnyStep[];
  const alreadyPatched = elseSteps.some((s) => s.id === "late_fork");
  if (!alreadyPatched) {
    const nudge1 = elseSteps.find((s) => s.id === "nudge1");
    const wait2 = elseSteps.find((s) => s.id === "wait2");
    if (!nudge1 || !wait2) throw new Error("nudge1/wait2 not found in reply_fork else-arm");
    replyFork.else = buildLateReplyElse(nudge1, wait2);
    changed.push("reply_fork else-arm: late replies now classify + route to the team");
  }

  return { next: { ...def, steps: steps as unknown as FlowStep[] }, changed };
}

function validate(name: string, nextDef: unknown): AiFlowDefinition {
  try {
    return parseAiFlowDefinition(nextDef);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`"${name}" failed validation:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`"${name}" failed validation:`, err);
    }
    process.exit(2);
  }
}

const targets: Array<{ row: Row; next: AiFlowDefinition; changed: string[] }> = [];
for (const name of FLOW_NAMES) {
  const row = await loadFlow(name);
  const { next, changed } = patch(row.definition);
  targets.push({ row, next: validate(name, next), changed });
}

for (const { row, next, changed } of targets) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log("  already patched — no changes");
    continue;
  }
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`  after: ${summarizeDefinition(next)}`);
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

const failures: string[] = [];
const patchedIds: string[] = [];
for (const { row, next, changed } of targets) {
  if (changed.length === 0) continue;
  const { error } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (error) {
    console.error(`update "${row.name}" (id=${row.id}) failed: ${error.message}`);
    failures.push(row.name);
    continue;
  }
  patchedIds.push(row.id);
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}
if (patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-truly-late-reply-and-source.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds }
  });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} flow(s) failed: ${failures.join(", ")} — re-run with --apply.`);
  process.exit(1);
}
console.log("\nDone. No runs were enqueued; the next real Privyr lead exercises the new arm.");
