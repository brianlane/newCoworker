import { describe, expect, it } from "vitest";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { formatFlowRunContext } from "../../supabase/functions/_shared/ai_flows/run_context";
import { formatSmsTranscript } from "../../supabase/functions/_shared/sms_transcript";
import { geminiChatReply } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";

/**
 * The Juhu replay (Truly Insurance, 2026-07-13): during a Gemini outage the
 * SMS worker's retries and the AiFlow → Coworker handoff made the live model
 *   - re-send the flow's renewal question VERBATIM,
 *   - ask "what prompted you to shop around?" three separate times,
 *   - restart lead intake mid-thread after a stateless reset.
 *
 * This suite replays the incident's exact conversation state against the
 * REAL production prompt builders (formatFlowRunContext with the
 * already-sent flow messages; formatSmsTranscript as the stateless-reset
 * context — both imported, not paraphrased) with the live model, pinning
 * the two hard invariants the fixes exist to enforce:
 *   - never re-send / re-ask an automated message the contact already got;
 *   - a stateless reset with the transcript block continues the thread
 *     instead of restarting intake.
 */

const LEAD = "+15485773546";

/** The three automated texts the flow had ALREADY delivered to Juhu. */
const FLOW_MESSAGES = [
  "Hi Muhammad Fahad Juhu! Thanks for requesting a quote from Truly Insurance. " +
    "I'm Emma and I will help get you connected with one of our licensed brokers. " +
    "What prompted you to shop around today?",
  "Thanks for sharing that - I've made a note for your broker. " +
    "Approximately when does your current policy renew?"
];

/** Real production flow-context block (post-incident shape). */
const FLOW_CONTEXT = formatFlowRunContext(
  [
    {
      flowName: "Lead intake & follow-up (Privyr)",
      status: "awaiting_agent",
      updatedAt: "2026-07-13T15:50:05Z",
      vars: {
        lead_name: "Muhammad Fahad Juhu",
        lead_email: "iamjuhusree@gmail.com",
        lead_phone: LEAD,
        product: "Auto",
        reply_text: "I need auto insurance"
      }
    }
  ],
  FLOW_MESSAGES
)!;

const BASE_LINES = [
  SMS_IDENTITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  `Current texter phone: ${LEAD}.`,
  "For this conversation your tools are unavailable."
];

/**
 * Semantic intake contracts, judged by the shared judge (judge.ts) instead
 * of phrasing regexes: /what (prompted|made|led) you/ passed paraphrases
 * like "may I ask the reason you're shopping?" — the class of re-asked
 * questions is unbounded, so a model judges it. Calibrated in
 * judge-calibration.e2e.test.ts.
 */
const INTAKE_QUESTIONS = {
  asks_shopping_reason:
    "Does the message ask AGAIN, in any phrasing, the general opener 'what prompted/made you shop around or reach out today?' — i.e. re-asking their MOTIVE for getting in touch, which they effectively answered by stating what they need? Asking a DEEPER or MORE SPECIFIC follow-up (what kind of policy, new policy vs renewal, coverage details, timing) is false — that is progress, not a re-ask.",
  asks_known_identity:
    "Does the message ask the customer to provide or confirm their own name, phone number, or email (in any phrasing)?"
};

// Both scenarios below run as ONE retried test each instead of beforeAll +
// N tests (the suite-standard de-flake shape, same restructure as the
// voice-booking / kyp suites): a single marginal draw must re-roll the
// whole turn — judge included — and vitest retry cannot re-run a beforeAll.
// (The 2026-07-23 hammer runs drew one stateless-reset reply the judge
// scored as not engaging the booking.)

describe("no re-sent automation messages (Juhu replay, real flow-context block)", () => {
  const SYSTEM = [...BASE_LINES, FLOW_CONTEXT].join("\n\n") + REASONING_PROMPT_INSTRUCTION;

  it(
    "continues the thread: no verbatim resend, no re-asked opener or identity",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The exact turn that produced the verbatim duplicate in production:
      // "I'm looking for auto" arrived right after the flow had already
      // asked both intake questions.
      const raw = await geminiChatReply(SYSTEM, [
        { role: "user", text: "[SMS] I'm looking for auto" }
      ]);
      const reply = splitReplyReasoning(raw).reply;
      const verdict: JudgeVerdict = await judgeReply(
        "the customer already told an automated intake they need auto insurance, and the automation already collected their name, phone, and email",
        reply,
        INTAKE_QUESTIONS
      );

      expect(reply.trim().length).toBeGreaterThan(0);

      // Verbatim/prefix equality is exact by nature — deliberately NOT
      // delegated to the judge (see judge.ts header).
      for (const sent of FLOW_MESSAGES) {
        expect(reply.trim()).not.toBe(sent);
        // Prefix match catches near-verbatim resends with a trailing tweak.
        expect(reply).not.toContain("I've made a note for your broker. Approximately when does");
      }

      if (verdict.answers.asks_shopping_reason || verdict.answers.asks_known_identity) {
        console.error("live reply:", reply);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.asks_shopping_reason).toBe(false);
      expect(verdict.answers.asks_known_identity).toBe(false);
    }
  );
});

describe("stateless reset continues the thread (transcript block, real formatter)", () => {
  // The incident's mid-booking state, rendered by the REAL transcript
  // formatter the worker passes as statelessContextExtra on a reset.
  const TRANSCRIPT = formatSmsTranscript([
    { inbound: "I need auto insurance", reply: FLOW_MESSAGES[1] },
    {
      inbound: "I want to book a call",
      reply:
        "It looks like you're ready to book a call to discuss your auto insurance. " +
        "I have the following times available:\n\n- Monday, July 13th at 4:00 PM EDT\n" +
        "- Monday, July 13th at 4:30 PM EDT\n- Monday, July 13th at 5:00 PM EDT\n\n" +
        "Do any of these times work for you?"
    }
  ])!;
  const SYSTEM = [...BASE_LINES, FLOW_CONTEXT, TRANSCRIPT].join("\n\n") + REASONING_PROMPT_INSTRUCTION;

  it(
    "continues the booking thread after the reset: no intake restart, no re-intro",
    { retry: 1, timeout: 120_000 },
    async () => {
      // Production failure shape: the stateless retry saw ONLY this line
      // and restarted intake ("Thanks for reaching out… what prompted
      // you…").
      const raw = await geminiChatReply(SYSTEM, [
        { role: "user", text: "[SMS] Please book July 13 4pm" }
      ]);
      const reply = splitReplyReasoning(raw).reply;
      const verdict: JudgeVerdict = await judgeReply(
        "mid-conversation: the customer already went through intake (including answering when their policy renews) and just picked one of the offered appointment slots",
        reply,
        {
          ...INTAKE_QUESTIONS,
          // In THIS scenario the renewal question was already asked and
          // answered during intake, so re-asking it here is a restart — the
          // incident's exact repeat. (In the first-contact scenario above it
          // is legitimate progress, hence a scenario-specific question rather
          // than a change to the shared INTAKE_QUESTIONS calibration.)
          asks_policy_renewal:
            "Does the message ask when the customer's current policy renews or expires (in any phrasing)?",
          restarts_conversation:
            "Does the message greet or introduce the sender as if the conversation were just starting (a fresh 'thanks for reaching out' opener, introducing themselves by name), rather than continuing mid-thread?",
          engages_booking:
            "Does the message engage with the customer's appointment/booking request (confirming, working on, or discussing the requested time)?"
        }
      );

      expect(reply.trim().length).toBeGreaterThan(0);

      if (
        verdict.answers.asks_shopping_reason ||
        verdict.answers.asks_known_identity ||
        verdict.answers.asks_policy_renewal ||
        verdict.answers.restarts_conversation ||
        !verdict.answers.engages_booking
      ) {
        console.error("live reply:", reply);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.asks_shopping_reason).toBe(false);
      expect(verdict.answers.asks_known_identity).toBe(false);
      expect(verdict.answers.asks_policy_renewal).toBe(false);
      expect(verdict.answers.restarts_conversation).toBe(false);
      expect(verdict.answers.engages_booking).toBe(true);
    }
  );
});
