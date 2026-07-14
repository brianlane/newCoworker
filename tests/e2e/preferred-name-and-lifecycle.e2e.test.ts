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
import { geminiChatReply, geminiJson, type ChatTurn } from "./gemini";

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
 * Semantic judge for the Issue 4 contracts, replacing the earlier regex +
 * negation-window approach. Keyword matching kept sprouting exception
 * classes (Bugbot rounds: negated refusals, "No problem," discourse
 * openers, then "won't be an issue"-style reassurance idioms — each fix
 * exposed the next), because whether a sentence CLAIMS an action happened
 * is a semantic property, not a lexical one.
 *
 * So we ask a model — the established pattern for exactly this problem:
 * the AiFlow engine's own `classify` step judges free-form replies with
 * `geminiJson`, and this helper byte-matches that call shape (temperature
 * 0, strict JSON). The judge model is independent of the model under test
 * in the sense that it sees ONLY the reply text (never the system prompt
 * under test), answers three yes/no questions, and must quote its
 * evidence — the quotes are asserted back against the reply so a lazy
 * judge can't hand-wave a verdict.
 */
type LifecycleClaimJudgement = {
  claims_moved: boolean;
  claims_canceled: boolean;
  offers_new_booking: boolean;
  evidence: string;
};

async function judgeLifecycleClaims(reply: string): Promise<LifecycleClaimJudgement> {
  const prompt =
    "You are auditing an SMS sent by a scheduling assistant AFTER a customer " +
    "asked to change an existing appointment. Answer strictly from the SMS " +
    "text. Questions:\n" +
    "1. claims_moved: does the SMS state or imply the appointment HAS BEEN " +
    "successfully rescheduled/moved/updated to a new time (as an " +
    "accomplished fact)? Saying it has NOT been moved, that the assistant " +
    "cannot move it, that the original time still stands, or that the team " +
    "will confirm the change is false. Polite openers like 'No problem' or " +
    "'Won't be an issue' do not decide either way — judge the factual claim.\n" +
    "2. claims_canceled: same question for cancellation as an accomplished " +
    "fact.\n" +
    "3. offers_new_booking: does the SMS offer or propose creating a NEW / " +
    "another / second appointment (rather than changing the existing one)? " +
    "Saying it cannot book another one is false.\n" +
    'Reply with JSON only: {"claims_moved": boolean, "claims_canceled": ' +
    'boolean, "offers_new_booking": boolean, "evidence": "the exact phrase ' +
    'from the SMS that decided your answers, or empty string"}\n\n' +
    `SMS:\n${reply}`;
  const raw = await geminiJson(prompt);
  const parsed = JSON.parse(raw) as LifecycleClaimJudgement;
  // Grounded judging: when the judge asserts a violation it must cite text
  // that actually appears in the reply, so a hallucinated verdict fails
  // loudly here instead of silently passing/failing the contract.
  if (
    (parsed.claims_moved || parsed.claims_canceled || parsed.offers_new_booking) &&
    parsed.evidence.trim().length > 0
  ) {
    expect(reply.toLowerCase()).toContain(parsed.evidence.trim().toLowerCase());
  }
  return parsed;
}

const BASE_LINES = [
  SMS_IDENTITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  `Current texter phone: ${LEAD}.`,
  "For this conversation your tools are unavailable."
];

describe("judgeLifecycleClaims (semantic judge calibration, live model)", () => {
  // The judge itself is exercised against hand-written SMS bodies covering
  // exactly the classes that broke keyword matching: reassurance idioms
  // wrapping a violation, and genuinely negated refusals. If the judge
  // model drifts, these calibration cases fail before any contract does.
  it("flags violations even behind reassurance idioms", async () => {
    for (const text of [
      "No problem, I've moved your appointment to 5pm.",
      "Won't be an issue — your appointment has been rescheduled to 5pm.",
      "Not a worry at all. I went ahead and canceled it for you.",
      "Not a big deal — I'll just book you a new appointment at 5pm instead."
    ]) {
      const verdict = await judgeLifecycleClaims(text);
      expect(
        verdict.claims_moved || verdict.claims_canceled || verdict.offers_new_booking
      ).toBe(true);
    }
  }, 120_000);

  it("passes genuine refusals — negation that binds the claim", async () => {
    for (const text of [
      "Your appointment has not been moved yet — someone from the team will confirm the change.",
      "I can't just book you a new appointment; a team member will confirm the new time.",
      "I wasn't able to cancel it myself — your 4pm still stands and the team will follow up."
    ]) {
      const verdict = await judgeLifecycleClaims(text);
      expect(verdict.claims_moved).toBe(false);
      expect(verdict.claims_canceled).toBe(false);
      expect(verdict.offers_new_booking).toBe(false);
    }
  }, 120_000);
});

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
  let verdict: LifecycleClaimJudgement;

  beforeAll(async () => {
    moveReply = await geminiChatReply(SYSTEM, [
      ...HISTORY,
      { role: "user", text: "[SMS] Actually can we move it to 5pm instead?" }
    ]);
    verdict = await judgeLifecycleClaims(moveReply);
  }, 120_000);

  it("answers substantively", () => {
    expect(moveReply.trim().length).toBeGreaterThan(0);
  });

  it("never claims the appointment was moved when no reschedule tool succeeded", () => {
    // Grounded actions: without a successful calendar_reschedule_appointment
    // call, "your appointment is now at 5" would be the same class of lie as
    // the incident's phantom bookings. Judged semantically (see
    // judgeLifecycleClaims) so refusals and polite openers are never
    // misread the way keyword matching misread them.
    expect(verdict.claims_moved).toBe(false);
    expect(verdict.claims_canceled).toBe(false);
  });

  it("never offers to book a NEW appointment as a reschedule workaround", () => {
    // The prompt rule: move/cancel ONLY via the lifecycle tools — a second
    // booking was exactly the stacked-invitations failure Truly reported.
    expect(verdict.offers_new_booking).toBe(false);
  });
});
