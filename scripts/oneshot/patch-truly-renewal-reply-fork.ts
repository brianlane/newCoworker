/**
 * patch-truly-renewal-reply-fork.ts — one-shot: classify the RENEWAL reply
 * instead of blindly acking it (live-test feedback, 2026-07-15, NCW Flow
 * Test tenant).
 *
 * The intent_fork else-arm asks "approximately when does your current
 * policy renew?" and then treats WHATEVER the lead texts next as the
 * renewal answer: a lead who replied "Can someone call me right now" got
 * the static ack "Perfect, thank you — I've noted that for your broker…
 * if a specific day or time works best…" — repeating the previous
 * message's "made a note for your broker" phrasing AND deferring an
 * explicit ask-for-NOW into a schedule-later invitation. The first reply
 * gets a classify + branch; this gives the renewal reply the same.
 *
 * New else-arm shape:
 *   continue_convo → tag_engaged → wait_renewal →
 *   classify_renewal (skipped on no_reply) → renewal_fork:
 *     wants_a_call    → immediate-call ack + WANTS-A-CALL-NOW team offer
 *     not_interested  → polite close + Lost tag + owner note
 *     else            → REWORDED renewal ack (no "noted for your broker"
 *                       repetition) + the existing routed offer
 *   The no-reply timeout keeps today's behavior: no classify, no ack,
 *   straight to the routed offer.
 *
 * History: the not_interested arms were initially dropped to fit the old
 * 50-step definition cap; the cap is 150 now (PR #634), so this script
 * builds the full three-arm forks and also UPGRADES a previously applied
 * two-arm fork in place (the test copy got the streamlined version).
 *
 * Targets the NCW Flow Test tenant's copy by default (safe to iterate);
 * --truly patches Truly Insurance's live flows (requires explicit owner
 * permission per account policy). Dry-run by default; validated through
 * parseAiFlowDefinition; idempotent. Records to applied_oneshots when
 * applying to Truly.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-truly-renewal-reply-fork.ts                  # dry-run (test tenant)
 *   npx tsx scripts/oneshot/patch-truly-renewal-reply-fork.ts --apply          # apply to TEST tenant
 *   npx tsx scripts/oneshot/patch-truly-renewal-reply-fork.ts --apply --truly  # ⚠️ apply to Truly
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const TRULY = process.argv.includes("--truly");

const TEST_BUSINESS_ID = "f1047e50-0000-4000-8000-000000000001";
const TRULY_BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410";
const BUSINESS_ID = TRULY ? TRULY_BUSINESS_ID : TEST_BUSINESS_ID;
const FLOW_NAMES = TRULY
  ? ["Lead intake & follow-up (Privyr) (copy)", "Lead intake & follow-up (Privyr)"]
  : ["Lead intake & follow-up (Privyr) (TEST COPY of Truly)"];

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };
type AnyStep = Record<string, unknown>;

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
    description: "answered the question - renewal timing, a date, or other details"
  }
];

/**
 * Quiet-hours blocks are tenant-specific (the test copy runs widened
 * Phoenix windows) — clone whichever block the arm already uses so the
 * patch never reverts the test tenant's deviation.
 */
/**
 * Mirror of the flow's existing intent_fork/late_intent_fork not-interested
 * arms (same wording, Lost tagging, and owner note) so a "stop texting me"
 * at ANY wait gets the same close-out.
 */
function buildNotInterestedArm(
  prefix: string,
  intentVar: string,
  replyVar: string,
  quiet: Record<string, unknown>
): AnyStep {
  return {
    id: `arm_${prefix}_not_interested`,
    label: "Not interested",
    condition: { var: intentVar, equals: "not_interested" },
    steps: [
      {
        id: `${prefix}_polite_close`,
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body:
          "No problem at all, {{vars.lead_name}} - thanks for letting us know. If " +
          "anything changes, we'd be happy to help. Have a great day!",
        ...quiet
      },
      {
        id: `${prefix}_tag_lost`,
        type: "update_contact",
        phoneVar: "lead_phone",
        addTags: ["Lost"],
        removeTags: ["New Lead", "Contacted", "Engaged"]
      },
      {
        id: `${prefix}_lost_note`,
        type: "notify_owner",
        message:
          "{{vars.lead_name}} ({{vars.lead_phone}}) said they're not interested - " +
          `closed out politely and tagged Lost. Their reply: "{{vars.${replyVar}}}"`
      }
    ]
  };
}

function buildRenewalFork(quietHours: unknown, offerWindow: unknown, offerTeam: AnyStep): AnyStep[] {
  const quiet = quietHours ? { quietHours } : {};
  return [
    {
      id: "classify_renewal",
      type: "classify",
      saveAs: "renewal_intent",
      textVar: "renewal_timing",
      when: { var: "renewal_timing", notEquals: "no_reply" },
      question:
        "An insurance lead was just asked approximately when their current policy renews. " +
        "This is their reply.",
      categories: CLASSIFY_CATEGORIES
    },
    {
      id: "renewal_fork",
      type: "branch",
      question: "What does the renewal reply actually ask for?",
      branches: [
        {
          id: "arm_renewal_call",
          label: "Wants a call",
          condition: { var: "renewal_intent", equals: "wants_a_call" },
          steps: [
            {
              id: "renewal_call_ack",
              type: "send_sms",
              to: "{{vars.lead_phone}}",
              body:
                "You got it, {{vars.lead_name}} - I'm getting a licensed broker to call " +
                "you right away.",
              ...quiet
            },
            {
              id: "offer_team_renewal_call",
              type: "route_to_team",
              ...(offerWindow ? { offerWindow } : {}),
              offerTemplate:
                "Hot Truly lead (Privyr) - WANTS A CALL NOW: {{vars.lead_name}} " +
                '({{vars.lead_phone}}) - {{vars.product}}. They replied: "{{vars.renewal_timing}}". ' +
                "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
              responseMinutes: 10,
              preferContactOwner: true,
              claimedNotifyTemplate:
                "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}) - call requested.",
              ownerFallbackTemplate:
                "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - they asked " +
                "for a call NOW. Back to you."
            }
          ]
        },
        buildNotInterestedArm("renewal", "renewal_intent", "renewal_timing", quiet)
      ],
      else: [
        {
          id: "renewal_ack",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          // Reworded: the PREVIOUS message already said "I've made a note
          // for your broker" — never repeat that phrasing back-to-back.
          body:
            "Perfect, thank you {{vars.lead_name}}! A licensed broker will reach out " +
            "shortly to review your options. If a specific day or time works best for a " +
            "call, just tell me here.",
          when: { var: "renewal_timing", notEquals: "no_reply" },
          ...quiet
        },
        offerTeam
      ]
    }
  ];
}

/**
 * The wait3 dead end (live-test feedback, same day): a lead who finally
 * replies AFTER the second nudge gets tagged Engaged and… nothing else —
 * no classify, no ack, no routing. "Can someone call me right now" must
 * work at EVERY wait, so the wait3 tail gets the same fork treatment:
 *   classify_reply3 (skipped on no_reply) → reply3_fork:
 *     wants_a_call   → immediate-call ack + WANTS-A-CALL-NOW team offer
 *     not_interested → polite close + Lost tag + owner note
 *     else           → ack + routed team offer (real replies), or the
 *                      existing final_touch + Inactive close-out (timeout)
 */
function buildReply3Fork(
  quietHours: unknown,
  offerWindow: unknown,
  finalTouch: AnyStep,
  tagInactive: AnyStep
): AnyStep[] {
  const quiet = quietHours ? { quietHours } : {};
  const window = offerWindow ? { offerWindow } : {};
  return [
    {
      id: "classify_reply3",
      type: "classify",
      saveAs: "reply3_intent",
      textVar: "reply3",
      when: { var: "reply3", notEquals: "no_reply" },
      question:
        "An insurance lead went quiet, received a final check-in about reviewing their " +
        "options, and this is their eventual reply.",
      categories: CLASSIFY_CATEGORIES
    },
    {
      id: "reply3_fork",
      type: "branch",
      question: "What does the lead's eventual reply ask for?",
      branches: [
        {
          id: "arm_reply3_call",
          label: "Wants a call",
          condition: { var: "reply3_intent", equals: "wants_a_call" },
          steps: [
            {
              id: "reply3_call_ack",
              type: "send_sms",
              to: "{{vars.lead_phone}}",
              body:
                "You got it, {{vars.lead_name}} - I'm getting a licensed broker to call " +
                "you right away.",
              ...quiet
            },
            {
              id: "offer_team_reply3_call",
              type: "route_to_team",
              ...window,
              offerTemplate:
                "Hot Truly lead (Privyr) - WANTS A CALL NOW: {{vars.lead_name}} " +
                '({{vars.lead_phone}}) - {{vars.product}}. They replied to the final check-in: ' +
                '"{{vars.reply3}}". Reply 1 to claim or 2 to pass by {{offer.deadline}}.',
              responseMinutes: 10,
              preferContactOwner: true,
              claimedNotifyTemplate:
                "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}) - call requested.",
              ownerFallbackTemplate:
                "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - they asked " +
                "for a call NOW. Back to you."
            }
          ]
        },
        buildNotInterestedArm("reply3", "reply3_intent", "reply3", quiet)
      ],
      else: [
        {
          id: "reply3_continue",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Thanks for getting back to us, {{vars.lead_name}} - one of our licensed " +
            "brokers will follow up with you shortly.",
          when: { var: "reply3", notEquals: "no_reply" },
          ...quiet
        },
        {
          id: "offer_team_reply3",
          type: "route_to_team",
          ...window,
          offerTemplate:
            "Revived Truly lead (Privyr): {{vars.lead_name}} ({{vars.lead_phone}}) - " +
            '{{vars.product}}. They replied to the final check-in: "{{vars.reply3}}". ' +
            "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
          when: { var: "reply3", notEquals: "no_reply" },
          responseMinutes: 10,
          preferContactOwner: true,
          claimedNotifyTemplate:
            "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}).",
          ownerFallbackTemplate:
            "No broker claimed revived lead {{vars.lead_name}} ({{vars.lead_phone}}). Back to you."
        },
        finalTouch,
        tagInactive
      ]
    }
  ];
}

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: string[] } {
  const changed: string[] = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  const walk = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.type !== "branch") continue;

      // Upgrade a previously applied two-arm fork (streamlined under the old
      // 50-step cap) to the full shape by inserting the missing arm.
      if (step.id === "renewal_fork" || step.id === "reply3_fork") {
        const arms = step.branches as AnyStep[];
        const prefix = step.id === "renewal_fork" ? "renewal" : "reply3";
        if (!arms.some((a) => String(a.id) === `arm_${prefix}_not_interested`)) {
          const callArm = arms[0] as { steps: AnyStep[] };
          const ackStep = callArm.steps[0] as { quietHours?: unknown };
          const quiet = ackStep.quietHours ? { quietHours: ackStep.quietHours } : {};
          arms.push(
            buildNotInterestedArm(
              prefix,
              `${prefix === "renewal" ? "renewal" : "reply3"}_intent`,
              prefix === "renewal" ? "renewal_timing" : "reply3",
              quiet
            )
          );
          changed.push(`${step.id}: not_interested arm added (post-cap-raise upgrade)`);
        }
      }

      const elseSteps = (step.else ?? []) as AnyStep[];
      const ids = elseSteps.map((s) => String(s.id));

      // Renewal reply fork (intent_fork else-arm).
      if (ids.includes("wait_renewal") && ids.includes("offer_team") && !ids.includes("renewal_fork")) {
        const head = elseSteps.filter(
          (s) => !["renewal_ack", "offer_team"].includes(String(s.id))
        );
        const ackIdx = ids.indexOf("renewal_ack");
        const quietHours = ackIdx !== -1 ? elseSteps[ackIdx].quietHours : undefined;
        const offerTeam = elseSteps[ids.indexOf("offer_team")];
        step.else = [...head, ...buildRenewalFork(quietHours, offerTeam.offerWindow, offerTeam)];
        changed.push(`${step.id} else-arm: renewal reply now classified (renewal_fork)`);
        continue;
      }

      // wait3 reply fork (late_fork else-arm tail).
      if (ids.includes("wait3") && ids.includes("final_touch") && !ids.includes("reply3_fork")) {
        const finalTouch = elseSteps[ids.indexOf("final_touch")];
        const tagInactive = elseSteps[ids.indexOf("tag_inactive")];
        const quietHours = finalTouch.quietHours;
        // Preserve everything up to and including late_engaged_2 (the
        // Engaged tag on a real reply3), then fork.
        const head = elseSteps.filter(
          (s) => !["final_touch", "tag_inactive"].includes(String(s.id))
        );
        // Borrow the offer window from any route step in the definition —
        // every Truly route uses the same one; absent means none.
        const anyWindow = JSON.stringify(def).includes('"offerWindow"')
          ? { timezone: "America/New_York", quietStart: "21:00", quietEnd: "08:30", graceMinutes: 15 }
          : undefined;
        const window =
          typeof quietHours === "object" && quietHours !== null &&
          (quietHours as Record<string, string>).timezone === "America/Phoenix"
            ? { timezone: "America/Phoenix", quietStart: "23:30", quietEnd: "05:00", graceMinutes: 15 }
            : anyWindow;
        step.else = [...head, ...buildReply3Fork(quietHours, window, finalTouch, tagInactive)];
        changed.push(`${step.id} else-arm: wait3 reply now classified (reply3_fork)`);
        continue;
      }

      if (Array.isArray(step.else)) walk(elseSteps);
      for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) {
        walk(arm.steps);
      }
    }
  };
  walk(steps);

  return { next: { ...def, steps: steps as unknown as FlowStep[] }, changed };
}

const { data: rows, error } = await db
  .from("ai_flows")
  .select("id,name,enabled,definition")
  .eq("business_id", BUSINESS_ID)
  .in("name", FLOW_NAMES);
if (error) throw new Error(error.message);

const targets: Array<{ row: Row; next: AiFlowDefinition; changed: string[] }> = [];
for (const row of (rows ?? []) as Row[]) {
  const { next, changed } = patch(row.definition);
  try {
    targets.push({ row, next: parseAiFlowDefinition(next), changed });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`"${row.name}" failed validation:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`"${row.name}" failed validation:`, err);
    }
    process.exit(2);
  }
}

for (const { row, next, changed } of targets) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}, tenant=${TRULY ? "TRULY" : "test"}) ===`);
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

const patchedIds: string[] = [];
for (const { row, next, changed } of targets) {
  if (changed.length === 0) continue;
  const { error: upErr } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (upErr) {
    console.error(`update "${row.name}" failed: ${upErr.message}`);
    process.exit(1);
  }
  patchedIds.push(row.id);
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}
if (TRULY && patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-truly-renewal-reply-fork.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds }
  });
}
console.log("\nDone.");
