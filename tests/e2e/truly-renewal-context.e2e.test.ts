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
import {
  formatFlowAnswerNote,
  formatFlowRunContext
} from "../../supabase/functions/_shared/ai_flows/run_context";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import { geminiChatReply, geminiJson } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { stepOf } from "./flow-walker";
import { walkFlowTimed, type TimedWalkResult } from "./flow-run-replay";
import { TRIGGER, trulyFlowSteps } from "./truly-privyr-flow.fixture";

/**
 * The Alex replay (Truly Insurance, 2026-07-14, run 5820f7f0): the full
 * "Lead intake & follow-up (Privyr) (copy)" flow — the tenant's EXACT
 * enabled production definition, verbatim below — executed end to end with
 * live Gemini decisions and the production timeline:
 *
 *   17:08  Privyr "New Lead: Alex 😁" email triggers the flow
 *   17:09  flow texts the intro; Alex replies "I am looking for auto
 *          insurance" 18 seconds later (wait_intro consumes it)
 *   17:10  classify → gave_info → else arm texts "Approximately when does
 *          your current policy renew?" and IMMEDIATELY parks on the
 *          route_to_team agent offer (10-minute window)
 *   17:10  Alex answers "July 23, 2026" 16 seconds after the question —
 *          the run is parked awaiting_agent, NO wait is listening
 *          (wait_renewal sits AFTER route_to_team), so the deadline answer
 *          falls through to the generic AI reply path, which answered
 *          "I'm sorry, I need a bit more context…". The renewal date was
 *          never captured for the broker.
 *
 * Two contracts, both violated in production and pinned here:
 *
 *  1. FLOW OWNERSHIP: the intake flow must own the renewal answer — a
 *     policy DEADLINE — in vars for the broker handoff, and no lead text
 *     may fall through to the generic path mid-intake.
 *  2. FALLBACK CONTEXT: even when a lead text does land on the generic
 *     path, the assistant (with the exact production preamble) must read a
 *     bare date as the answer to the renewal question it can see was just
 *     asked — never ask the lead what the date means.
 */

const LEAD = "+15199560528";
const RENEWAL_ANSWER = "July 23, 2026";

/** What the tenant's SMS Coworker agent runs (deploy-client.sh
 * SMS_CHAT_MODEL default; upgraded off 2.5-flash-lite after this incident —
 * the old model ignored the system preamble on the incident turn — then to
 * 3.5-flash-lite with the PR #809 fleet migration, 3.x being viable on the
 * Rowboat path since the llm-router thought_signature shim, PR #683). */
const TRULY_SMS_CHAT_MODEL = "gemini-3.5-flash-lite";


/**
 * Alex's production timeline in minutes since the run's first step:
 * the intro answer landed ~18s after the ack, the renewal answer ~16s
 * after the question — i.e. both within a minute or two, while the run
 * had already parked on the 10-minute route_to_team offer.
 */
const ALEX_INBOUND = [
  { text: "I am looking for auto insurance", atMinutes: 0.3 },
  { text: RENEWAL_ANSWER, atMinutes: 1.4 }
];

let walk: TimedWalkResult;

beforeAll(async () => {
  walk = await walkFlowTimed(trulyFlowSteps(), {
    trigger: TRIGGER,
    inbound: ALEX_INBOUND,
    ai: { json: geminiJson }
  });
}, 120_000);

describe("Truly Privyr flow replay — Alex 2026-07-14 (full flow, live decisions)", () => {
  it("replays production's intake decisions (fidelity check)", () => {
    // Live extraction pulled Alex out of the noisy Privyr alert.
    expect(String(walk.vars.lead_name)).toMatch(/alex/i);
    expect(String(walk.vars.lead_phone)).toContain("5199560528");
    expect(String(walk.vars.product)).toMatch(/auto/i);
    // Live classify read "I am looking for auto insurance" as gave_info,
    // so the else arm asked the renewal question — same as production.
    expect(walk.vars.intent).toBe("gave_info");
    expect(
      walk.sends.some((s) => s.body.includes("when does your current policy renew"))
    ).toBe(true);
    expect(stepOf(walk, "offer_team").status).toBe("done");
  });

  it("the flow OWNS the renewal deadline: wait_renewal captures Alex's answer", () => {
    // Production violation: the run was parked awaiting_agent when the
    // answer arrived, wait_renewal never saw it, and renewal_timing timed
    // out to "no_reply" — the broker never got the July 23 deadline.
    expect(walk.vars.renewal_timing).toBe(RENEWAL_ANSWER);
  });

  it("acknowledges the captured deadline to the lead (renewal_ack fires)", () => {
    expect(stepOf(walk, "renewal_ack").status).toBe("done");
    expect(walk.sends.some((s) => s.body.startsWith("Perfect, thank you Alex"))).toBe(true);
  });

  it("the broker offer carries the renewal answer", () => {
    const offer = String(stepOf(walk, "offer_team").result.offer ?? "");
    expect(offer).toContain('Renewal: "{{vars.renewal_timing}}"');
  });

  it("no lead text falls through to the generic AI path mid-intake", () => {
    // Each entry here is a customer message the flow asked for but never
    // received — in production it landed on a context-poor generic reply
    // ("I'm sorry, I need a bit more context…").
    expect(walk.fellThroughToGenericPath).toEqual([]);
  });
});

describe("generic-path fallback turn — the incident turn's exact prompt", () => {
  // The EXACT production preamble of the incident turn (verified against
  // the stored Rowboat conversation 6a566d80a138dbaf59c8db5f), rebuilt from
  // the same production builders the SMS worker uses, with the flow state
  // taken from the walk above. With the fixed flow this exact message no
  // longer falls through — but ANY lead text arriving during a
  // route_to_team park still does, so the fallback path must read a bare
  // answer in context. Mirrors the worker's post-incident shape: the
  // fresh-thread flow-answer note rides inside the user turn
  // (formatFlowAnswerNote → sms_rowboat userTurnNote).
  let reply = "";
  let reasoningPresent = false;
  let verdict: JudgeVerdict;

  beforeAll(async () => {
    const dateLine = currentDateTimeLine(
      new Date("2026-07-14T17:10:24.259Z"),
      "America/New_York"
    );
    const phoneLine =
      `Current texter phone: ${LEAD}. When calling customer tools ` +
      `(customer_lookup_by_phone, customer_set_display_name, ` +
      `customer_append_pinned_note), pass this exact value as the phone ` +
      `argument unless the texter explicitly refers to a different number.`;
    const memoryPreamble = buildCustomerPreambleForEdge({
      customer_e164: LEAD,
      display_name: "Alex",
      summary_md: null,
      pinned_md: null,
      total_interaction_count: 4,
      last_channel: "sms",
      last_interaction_at: "2026-07-14T17:10:05.883783+00:00"
    });
    // The conversation state AT THE INCIDENT MOMENT: the flow has texted the
    // intro and the renewal question (nothing after), and the run is parked.
    // Rendered by the walk so the bodies are the real templated sends —
    // the same bodies loadFlowRunContext quotes from the outbound log.
    const allFlowSends = walk.sends.filter((s) => s.to === LEAD).map((s) => s.body);
    const renewalQuestionIdx = allFlowSends.findIndex((b) =>
      b.includes("when does your current policy renew")
    );
    const flowMessages = allFlowSends.slice(0, renewalQuestionIdx + 1);
    const flowContext = formatFlowRunContext(
      [
        {
          flowName: "Lead intake & follow-up (Privyr) (copy)",
          status: "awaiting_agent",
          updatedAt: "2026-07-14T17:10:06.54938+00:00",
          vars: {
            intent: String(walk.vars.intent ?? "gave_info"),
            product: String(walk.vars.product ?? "Auto"),
            lead_name: "Alex",
            lead_phone: LEAD,
            reply_text: "I am looking for auto insurance",
            claimed_agent: "none"
          }
        }
      ],
      flowMessages
    )!;
    const system =
      [
        `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${dateLine}\n\n${phoneLine}`,
        memoryPreamble,
        flowContext
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") + REASONING_PROMPT_INSTRUCTION;

    // The worker's fresh-thread anchor: the last automated message rides
    // inside the user turn (see sms-inbound-worker's flowAnswerNote +
    // sms_rowboat's userTurnNote), because the incident model ignored the
    // same fact when it lived only in the system preamble.
    const note = formatFlowAnswerNote(flowMessages[flowMessages.length - 1] ?? "");
    const userTurn = note ? `${note}\n\n[SMS] ${RENEWAL_ANSWER}` : `[SMS] ${RENEWAL_ANSWER}`;
    // Whole-turn retry, mirroring production: a trailer-only draw (reply
    // empty after the reasoning strip) makes the worker THROW
    // (rowboat_empty_assistant_after_reasoning_strip) and the job retries
    // the model call — a customer never receives that draw, so asserting on
    // it would fail the suite on a shape production explicitly re-rolls. A
    // parsed-but-trailerless draw is also re-rolled here, the suite's
    // standard { retry: 1 }-style flake treatment (the trailer contract
    // itself is asserted below on the final draw).
    let split: ReturnType<typeof splitReplyReasoning> = { reply: "", reasoning: null };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await geminiChatReply(
        system,
        [{ role: "user", text: userTurn }],
        TRULY_SMS_CHAT_MODEL
      );
      split = splitReplyReasoning(raw);
      if (split.reply.trim() !== "" && split.reasoning !== null) break;
    }
    reply = split.reply;
    reasoningPresent = split.reasoning !== null;
    verdict = await judgeReply(
      "an automated intake just asked the insurance lead 'approximately when does " +
        "your current policy renew?', and the lead answered with only a date",
      reply,
      {
        asks_what_date_means:
          "Does the message ask the customer to clarify, provide more context, or " +
          "explain what the date refers to or what they need — i.e. does it fail to " +
          "recognize the date as an answer to a question? A reply that acknowledges " +
          "the date and moves forward is false.",
        acknowledges_answer:
          "Does the message accept the customer's date as an answer it received — " +
          "acknowledging, confirming, noting it (any phrasing: thanks them for it, " +
          "says it was noted/recorded/added to notes, or names it as their renewal " +
          "timing) — and continue the conversation forward (a next step, offer, or " +
          "confirmation)?",
        restarts_conversation:
          "Does the message greet or introduce the sender as if the conversation were " +
          "just starting (a fresh 'thanks for reaching out' opener, introducing " +
          "themselves by name), rather than continuing mid-thread?"
      }
    );
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("reads the bare date as the renewal answer it can see was just asked", () => {
    // Surface the live reply + verdict in the vitest output on failure —
    // a semantic-judge miss is undebuggable from a bare boolean diff.
    if (!verdict.answers.acknowledges_answer || verdict.answers.asks_what_date_means) {
      console.error("live reply:", reply);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    // Production violation: "I'm sorry, I need a bit more context to
    // understand what you're referring to…" — the deadline was in plain
    // sight in the automation-context block.
    expect(verdict.answers.asks_what_date_means).toBe(false);
    expect(verdict.answers.acknowledges_answer).toBe(true);
  });

  it("does not restart the conversation", () => {
    expect(verdict.answers.restarts_conversation).toBe(false);
  });

  it("emits the reasoning trailer (production's incident turn skipped it)", () => {
    expect(reasoningPresent).toBe(true);
  });
});
