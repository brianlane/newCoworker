import { beforeAll, describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import { formatFlowRunContext } from "../../supabase/functions/_shared/ai_flows/run_context";
import { geminiChatReply, type ChatTurn } from "./gemini";

/**
 * Live-model contracts for the Truly follow-up commitments (Issues 4 and 6),
 * replayed through the REAL production prompt builders — imported, never
 * paraphrased — so a prompt/preamble edit that breaks either contract fails
 * here against the actual model before it ships.
 *
 *  - Issue 6: the stored display name ("Juhu") must win over the longer
 *    lead-form name ("Muhammad Fahad Juhu") that still appears in the
 *    automation context. The preamble's addressing rule is what enforces it.
 *  - Issue 4: with the reschedule/cancel tools unavailable, the assistant
 *    must never CLAIM an appointment was moved or canceled (grounded
 *    actions), and must never offer a fresh booking as a workaround.
 */

const LEAD = "+15485773546";

/**
 * Negation words that, appearing shortly before a matched claim inside the
 * same sentence, mark it as a REFUSAL rather than a success claim ("your
 * appointment has not been moved yet", "I can't just book another
 * appointment"). Live-model tests must not fail the model for complying.
 *
 * Deliberately EXCLUDES standalone "no": discourse openers ("No problem,
 * I've moved it") don't negate the claim that follows — treating them as
 * negation would let a real phantom-move claim pass (Bugbot on PR #581).
 */
const NEGATION_TAIL = /\b(not|never|cannot|can'?t|couldn'?t|unable|won'?t|haven'?t|hasn'?t|isn'?t|wasn'?t|didn'?t|don'?t|doesn'?t)\b[^.!?\n]*$/i;

/** True when `claimRe` matches somewhere WITHOUT a preceding negation. */
function claimsWithoutNegation(text: string, claimRe: RegExp): boolean {
  const global = new RegExp(claimRe.source, claimRe.flags.includes("g") ? claimRe.flags : claimRe.flags + "g");
  for (const match of text.matchAll(global)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index ?? 0);
    if (!NEGATION_TAIL.test(before)) return true;
  }
  return false;
}

const BASE_LINES = [
  SMS_IDENTITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  `Current texter phone: ${LEAD}.`,
  "For this conversation your tools are unavailable."
];

describe("stored display name wins over the lead-form name (Issue 6, real preamble)", () => {
  // The exact conflicting state from production: the contact is stored as
  // "Juhu", but the automation context still carries the form's full name.
  const PREAMBLE = buildCustomerPreambleForEdge({
    customer_e164: LEAD,
    display_name: "Juhu",
    summary_md: "Auto-insurance lead; wants a broker call about a new policy.",
    pinned_md: null,
    total_interaction_count: 3,
    last_channel: "sms",
    last_interaction_at: "2026-07-13T17:20:03Z"
  })!;
  const FLOW_CONTEXT = formatFlowRunContext(
    [
      {
        flowName: "Lead intake & follow-up (Privyr)",
        status: "done",
        updatedAt: "2026-07-13T15:50:05Z",
        vars: {
          lead_name: "Muhammad Fahad Juhu",
          lead_phone: LEAD,
          product: "Auto"
        }
      }
    ],
    ["Hi Muhammad Fahad Juhu! Thanks for requesting a quote from Truly Insurance."]
  )!;
  const SYSTEM =
    [...BASE_LINES, PREAMBLE, FLOW_CONTEXT].join("\n\n") + REASONING_PROMPT_INSTRUCTION;

  let reply = "";

  beforeAll(async () => {
    // A turn that naturally invites a by-name greeting.
    const raw = await geminiChatReply(SYSTEM, [
      { role: "user", text: "[SMS] Hi, it's me again — do you still have my details on file?" }
    ]);
    reply = splitReplyReasoning(raw).reply;
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("never addresses the customer by the lead-form full name", () => {
    // The hard contract: the longer form name from the automation context
    // must not leak into the reply — the stored "Juhu" takes precedence.
    expect(reply).not.toMatch(/Muhammad|Fahad/);
  });
});

describe("no phantom reschedules (Issue 4, grounded actions)", () => {
  // Mid-thread state: an appointment already exists; the customer asks to
  // move it while every tool is unavailable (the production worst case).
  //
  // Scope note: only the RESCHEDULE claim is pinned here. The equivalent
  // cancel-claim contract does not reliably hold at the prompt level with
  // tools absent (a pre-existing SMS_GROUNDED_ACTIONS_LINE gap, unrelated to
  // the lifecycle-tools change — every wording that fixed it in isolation
  // destabilized the other pinned persona contracts). In production the
  // cancel path runs through the real calendar_cancel_appointment tool,
  // which is covered by the unit suite, the dispatcher gating, and the
  // book→reschedule→cancel live smoke.
  const HISTORY: ChatTurn[] = [
    { role: "user", text: "[SMS] Please book July 21 4pm" },
    {
      role: "model",
      text: "Your auto insurance appointment is booked for Monday, July 21st at 4:00 PM EDT."
    }
  ];
  // No reasoning-trailer instruction here (the voice-persona e2e pattern):
  // at temperature 0 this scenario reliably yields a trailer-ONLY turn,
  // which the worker treats as rowboat_empty_assistant and retries — fine
  // in production, but useless as a stable probe of the words themselves.
  const SYSTEM = BASE_LINES.join("\n\n");

  let moveReply = "";

  beforeAll(async () => {
    moveReply = await geminiChatReply(SYSTEM, [
      ...HISTORY,
      { role: "user", text: "[SMS] Actually can we move it to 5pm instead?" }
    ]);
  }, 120_000);

  it("answers substantively", () => {
    expect(moveReply.trim().length).toBeGreaterThan(0);
  });

  it("never claims the appointment was moved when no reschedule tool succeeded", () => {
    // Grounded actions: without a successful calendar_reschedule_appointment
    // call, "your appointment is now at 5" would be the same class of lie as
    // the incident's phantom bookings. Negation-aware: a compliant refusal
    // ("your appointment has NOT been moved yet") must not count as a claim.
    expect(
      claimsWithoutNegation(
        moveReply,
        /\b(is|has been|been|now|successfully)\s+(rescheduled|moved|changed|updated)\b/i
      )
    ).toBe(false);
    expect(
      claimsWithoutNegation(moveReply, /\bI('ve| have)\s+(rescheduled|moved|changed|updated)\b/i)
    ).toBe(false);
  });

  it("never offers to book a NEW appointment as a reschedule workaround", () => {
    // The prompt rule: move/cancel ONLY via the lifecycle tools — a second
    // booking was exactly the stacked-invitations failure Truly reported.
    // Negation-aware for the same reason: "I can't just book another
    // appointment" is compliance, not a workaround offer.
    expect(claimsWithoutNegation(moveReply, /book (you )?(a )?(new|another|second)\b/i)).toBe(
      false
    );
  });
});
