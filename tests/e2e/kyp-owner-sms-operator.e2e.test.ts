import { beforeAll, describe, expect, it } from "vitest";
import { OWNER_PREAMBLE } from "@/app/api/dashboard/chat/route";
import { SMS_SURFACE_BLOCK } from "@/app/api/internal/owner-sms-turn/route";
import { actionToolDeclarations, type ActionToolGates } from "@/lib/dashboard-chat/action-tools";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiChatContent,
  type GeminiChatStepResult,
  type GeminiFunctionCall
} from "@/lib/gemini-chat";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";

/**
 * The James Lee (KYP Ads) owner-SMS replay, 2026-07-16.
 *
 * What actually happened in production that morning: James texted his own
 * business line asking the assistant to text his invitee Uday Nandam a 2pm
 * call confirmation. The turn ran on the Rowboat staff persona (no send_sms
 * tool), so the assistant could only `notify_team` — an "Urgent" alert
 * delivered straight back to James — and no text ever reached Uday. Earlier
 * the same evening, the dashboard model had re-sent its own previous chat
 * reply ("The text has been sent.") as an SMS BODY when James said a test
 * text hadn't arrived.
 *
 * This suite replays those exact messages against the owner-operator
 * surface that now handles them (/api/internal/owner-sms-turn): the REAL
 * production prompt blocks (OWNER_PREAMBLE + SMS_SURFACE_BLOCK, imported —
 * not paraphrased), the REAL tool declarations, and the live model the
 * surface runs, with tool executions stubbed to the executor's real
 * response shapes. Pinned contracts:
 *
 *   1. James's request is ACTIONABLE: the assistant either texts Uday's
 *      number (never James's own) or asks a real question — and never
 *      claims it "notified the team" as the fulfilment.
 *   2. With a matching ENABLED automation, it PRESENTS the options (direct
 *      text vs. run the flow) and commits NOTHING until James chooses —
 *      then executes exactly the chosen option.
 *   3. A "didn't receive anything" retry re-sends the INTENDED body, never
 *      the assistant's own previous chat reply.
 *
 * Temperature 0 for CI stability (production runs 0.3 on this surface);
 * the engine loop itself is unit-tested — this suite pins what the MODEL
 * does with the production prompts and tools.
 */

/** The inline engine's production default (DASHBOARD_CHAT_MODEL). */
const OPERATOR_MODEL = "gemini-3.5-flash";

const JAMES_E164 = "+15145188192";
const UDAY_E164 = "+17326190286";

/** James's exact production message (typos included). */
const JAMES_REQUEST =
  "[SMS from owner] can you text Invitees\n\nUday Nandam\n\nuday@grove.tax\n\n\n+1 732-619-0286\n\nAmerica/New_York\n\n\nfor his 2pm call confirm to learb more about the 100/week offer";

const ALL_GATES: ActionToolGates = {
  send_sms: true,
  send_whatsapp: false,
  calendar_find_slots: true,
  calendar_book_appointment: true,
  calendar_reschedule_appointment: true,
  calendar_cancel_appointment: true,
  list_aiflows: true,
  run_aiflow: true,
  // Owner-over-SMS surface: the dashboard image tool has nowhere to render
  // (same reason the production route pins it false).
  generate_image: false,
  // The owner-over-SMS route declares this with full control (verified
  // owner identity), same as production.
  update_notification_preferences: true
};
const TOOLS = actionToolDeclarations(ALL_GATES);

/** KYP Ads context fixture — the curated memory the tenant actually runs. */
const KYP_IDENTITY = [
  "Business Name: KYP Ads",
  "Owner / Primary Contact: James Lee",
  "Business Phone: +15145188192",
  "Timezone: America/Toronto"
].join("\n");

const KYP_MEMORY = [
  "- KYP Ads is a Meta ads management agency run by James Lee, based in Montreal.",
  "- Offer: $200/week ($800/month) management. Some earlier clients grandfathered at $100/week ($400/month).",
  "- Booking link for new leads and inbound from Meta ads ($200/week): https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2",
  "- Booking link for warm pipeline and grandfathered ($100/week): https://calendly.com/james-kyp-ads/my-free-scale-plan",
  "- Default to the $200/week booking link. Only use the $100/week link when James explicitly says someone is warm pipeline.",
  "- Tone: casual, warm, direct, like a real person texting. Not corporate, not salesy. No em dashes. Short messages.",
  '- Requested automation (pending James\'s wording approval before anything goes live): when someone books through Calendly, send an SMS 2-3 hours before the call confirming attendance, timed to the INVITEE\'s timezone. Draft template: "Hey [name], James here from KYP Ads. Just confirming our call at [time] today. See you then?" Calls are 30 minutes over Zoom.'
].join("\n");

/** Flow fixtures — response shapes byte-matched to the executor's. */
const CONFIRMATION_FLOW_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const LIST_NOTE =
  "When one of these matches what the owner asked for, offer it as an option next to doing the action directly and let the owner choose. Disabled flows can be mentioned but not run — the owner reviews/enables them at /dashboard/aiflows.";

function flowsFixture(confirmationEnabled: boolean) {
  return {
    ok: true,
    flows: [
      {
        id: CONFIRMATION_FLOW_ID,
        name: confirmationEnabled
          ? "Booking confirmation text (Calendly)"
          : "Booking confirmation text (Calendly) — awaiting James's approval",
        enabled: confirmationEnabled,
        trigger: "calendar (event_start)"
      },
      {
        id: "22222222-bbbb-4bbb-8bbb-222222222222",
        name: "Lead follow-up (white-glove build)",
        enabled: true,
        trigger: "webhook"
      }
    ],
    note: LIST_NOTE
  };
}

function sendSmsSuccess(args: Record<string, unknown>) {
  return {
    ok: true,
    messageId: "e2e-msg-1",
    toE164: args.toE164,
    sentBody: args.body,
    note: "Tell the owner the exact message body that was texted."
  };
}

function runAiflowSuccess(flowName: string) {
  return {
    ok: true,
    runId: "e2e-run-1",
    flowName,
    note: `Run enqueued — it starts within about a minute. Tell the owner "${flowName}" is running and they can watch it at /dashboard/aiflows.`
  };
}

type ToolRouter = (name: string, args: Record<string, unknown>) => unknown;

let SYSTEM = "";

/** One retried live model step (mirror of gemini.ts's transient policy). */
const MAX_STEP_ATTEMPTS = 5;

async function stepWithRetry(
  contents: GeminiChatContent[]
): Promise<GeminiChatStepResult> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    try {
      return await geminiChatStep({
        apiKey,
        model: OPERATOR_MODEL,
        systemInstruction: SYSTEM,
        contents,
        tools: TOOLS,
        temperature: 0,
        // 3.5-flash's thinking tokens count against maxOutputTokens: the old
        // 1500 cap truncated a correctly-shaped reply mid-question ("…send
        // this text to +1732…, or") on PR #766's CI run, failing the /\?/
        // assertion. Same fix as the messenger-engine e2e harness.
        maxOutputTokens: 6000
      });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /^gemini_http_(429|5\d\d)/.test(msg);
      if (!transient || attempt === MAX_STEP_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
    }
  }
  /* v8 ignore next -- unreachable */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Run one owner turn through the model↔tool loop (the engine loop itself is
 * unit-tested; this drives the same call shape with stubbed executions).
 *
 * A COMPLETELY empty turn (no text and no tool calls — a thinking-only
 * draw) is retried whole-turn, bounded: the production inline engine treats
 * that shape as an error and the job retries, so the harness mirrors it
 * rather than asserting on "". Attempts that made tool calls are NEVER
 * re-rolled (Bugbot on PR #768: a re-roll would discard the recorded
 * send_sms/run_aiflow a scenario asserts on); the calls-then-empty-text
 * draw is instead recovered by operatorTurnOnce's per-step empty retry,
 * which re-requests the same step with the turn's context intact.
 */
async function operatorTurn(
  prior: GeminiChatContent[],
  userText: string,
  route: ToolRouter
): Promise<{ finalText: string; calls: GeminiFunctionCall[]; contents: GeminiChatContent[] }> {
  let last: { finalText: string; calls: GeminiFunctionCall[]; contents: GeminiChatContent[] } = {
    finalText: "",
    calls: [],
    contents: []
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await operatorTurnOnce(prior, userText, route);
    if (last.finalText.trim().length > 0 || last.calls.length > 0) return last;
  }
  return last;
}

async function operatorTurnOnce(
  prior: GeminiChatContent[],
  userText: string,
  route: ToolRouter
): Promise<{ finalText: string; calls: GeminiFunctionCall[]; contents: GeminiChatContent[] }> {
  const contents: GeminiChatContent[] = [...prior, { role: "user", parts: [{ text: userText }] }];
  const calls: GeminiFunctionCall[] = [];
  let finalText = "";
  for (let step = 0; step < 5; step++) {
    let result = await stepWithRetry(contents);
    // Empty completion (no text, no calls): re-request the SAME step,
    // bounded — the per-completion mirror of the llm-router's empty-
    // completion retry (#766). Only applies when the turn has produced no
    // usable text yet; a benign trailing empty after text already landed
    // just ends the loop.
    for (
      let empty = 1;
      empty <= 2 && !result.text && result.functionCalls.length === 0 && !finalText;
      empty++
    ) {
      result = await stepWithRetry(contents);
    }
    if (result.text) finalText = result.text;
    if (result.functionCalls.length === 0 || !result.modelContent) break;
    contents.push(result.modelContent);
    const responses = result.functionCalls.map((call) => {
      calls.push(call);
      return { name: call.name, response: route(call.name, call.args) };
    });
    contents.push(buildFunctionResponseContent(responses));
  }
  return { finalText, calls, contents };
}

const digits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

beforeAll(async () => {
  const [integrationsLine, contextBlock] = await Promise.all([
    buildIntegrationsStatusLine("e2e-biz", {
      resolveCalendar: (async () => ({
        provider: "calendly",
        providerConfigKey: "calendly-direct",
        connectionId: "e2e"
      })) as never,
      resolveEmail: (async () => ({
        provider: "microsoft",
        providerConfigKey: "outlook",
        connectionId: "e2e"
      })) as never
    }),
    buildBusinessContextBlock("e2e-biz", {
      fetchConfig: (async () => ({ identity_md: KYP_IDENTITY, memory_md: KYP_MEMORY })) as never
    })
  ]);
  SYSTEM = [
    OWNER_PREAMBLE,
    SMS_SURFACE_BLOCK,
    `The texter is the business OWNER, James Lee, texting from ${JAMES_E164}.`,
    currentDateTimeLine(new Date(), "America/Toronto"),
    integrationsLine ?? "",
    contextBlock ?? ""
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
});

describe("scenario 1 — James's exact request, confirmation flow still disabled (production state)", () => {
  // One retried test instead of beforeAll + two tests (the suite-standard
  // de-flake shape): a marginal draw must re-roll the WHOLE turn, and
  // vitest retry cannot re-run a beforeAll.
  it(
    "acts on the request (texts Uday or asks), never texts the owner, never runs a disabled flow",
    { retry: 1, timeout: 120_000 },
    async () => {
      const out = await operatorTurn([], JAMES_REQUEST, (name, args) => {
        if (name === "list_aiflows") return flowsFixture(false);
        if (name === "send_sms") return sendSmsSuccess(args);
        return { ok: false, message: `unexpected tool in this scenario: ${name}` };
      });
      const finalText = out.finalText;
      const calls = out.calls;

      // Never texts the owner's own number; never runs a disabled flow.
      for (const call of calls) {
        if (call.name === "send_sms") {
          expect(digits(call.args.toE164)).not.toBe(digits(JAMES_E164));
        }
        expect(call.name).not.toBe("run_aiflow");
      }

      // Acts on the request: texts Uday, or asks a real question — never
      // "I've notified the team" as the fulfilment.
      const sms = calls.find((c) => c.name === "send_sms");
      if (sms) {
        // Delivered to Uday with a body that reads like his 2pm confirmation.
        expect(digits(sms.args.toE164)).toBe(digits(UDAY_E164));
        expect(String(sms.args.body)).toMatch(/2\s*(pm|p\.m\.|:00)/i);
        expect(String(sms.args.body).toLowerCase()).toContain("confirm");
      } else {
        // No send this turn ⇒ the reply must be a genuine question/options
        // ask, not a claimed action or a refusal.
        if (!/\?/.test(finalText)) {
          console.error("live reply (no send, no question):", finalText);
        }
        expect(finalText.trim().length).toBeGreaterThan(0);
        expect(finalText).toMatch(/\?/);
      }

      const verdict: JudgeVerdict = await judgeReply(
        "an assistant with a working send-text tool, replying to the business owner who asked it to text an invitee a call confirmation",
        finalText,
        {
          claims_team_notified:
            "Does the message claim the assistant notified, alerted, or escalated to 'the team' (or a person) as its way of handling the request? Sending the requested text itself, or asking the owner a question, is false.",
          claims_unactionable:
            "Does the message claim the assistant cannot send texts, lacks the ability to act, or that someone else must do it? Asking the owner to confirm details before acting is false."
        }
      );
      if (verdict.answers.claims_team_notified || verdict.answers.claims_unactionable) {
        console.error("live reply:", finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.claims_team_notified).toBe(false);
      expect(verdict.answers.claims_unactionable).toBe(false);
    }
  );
});

describe("scenario 2 — flow ENABLED: presents both options, then executes the owner's choice", () => {
  // One retried test instead of beforeAll + three tests: a marginal round-1
  // draw (the model committing an action before asking — seen once on PR
  // #729's CI run) must re-roll the WHOLE exchange, and vitest retry cannot
  // re-run a beforeAll.
  it(
    "commits nothing before the owner chooses, presents both options, then runs the chosen flow",
    { retry: 1, timeout: 240_000 },
    async () => {
      const round1 = await operatorTurn([], JAMES_REQUEST, (name, args) => {
        if (name === "list_aiflows") return flowsFixture(true);
        if (name === "send_sms") return sendSmsSuccess(args);
        if (name === "run_aiflow") return runAiflowSuccess("Booking confirmation text (Calendly)");
        return { ok: false, message: `unexpected tool: ${name}` };
      });

      // Commits NOTHING before the owner chooses (reads like list_aiflows
      // are fine).
      const committed = round1.calls.filter(
        (c) => c.name === "send_sms" || c.name === "run_aiflow"
      );
      expect(committed, `round1 text: ${round1.finalText}`).toEqual([]);

      // Presents the direct-vs-automation choice and asks the owner.
      const optionsVerdict: JudgeVerdict = await judgeReply(
        "an assistant that can either send a text directly or run the owner's existing booking-confirmation automation, replying to the owner's request to text an invitee a call confirmation",
        round1.finalText,
        {
          presents_both_options:
            "Does the message offer the owner a choice between at least two ways of fulfilling the request (for example sending the text directly versus running an existing automation/flow)? A single yes/no confirmation question about one action is false.",
          asks_owner_to_choose:
            "Does the message ask the owner which option they want (or otherwise wait for their decision) instead of stating an action was already taken?"
        }
      );
      if (!optionsVerdict.answers.presents_both_options || !optionsVerdict.answers.asks_owner_to_choose) {
        console.error("round1 reply:", round1.finalText);
        console.error("judge verdict:", JSON.stringify(optionsVerdict));
      }
      expect(optionsVerdict.answers.presents_both_options).toBe(true);
      expect(optionsVerdict.answers.asks_owner_to_choose).toBe(true);

      // The owner picks the automation; the model must run exactly that.
      const round2 = await operatorTurn(
        round1.contents,
        "[SMS from owner] run the automation",
        (name, args) => {
          if (name === "list_aiflows") return flowsFixture(true);
          if (name === "run_aiflow") return runAiflowSuccess("Booking confirmation text (Calendly)");
          if (name === "send_sms") return sendSmsSuccess(args);
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      const run = round2.calls.find((c) => c.name === "run_aiflow");
      expect(run, `round2 calls: ${JSON.stringify(round2.calls)}`).toBeDefined();
      expect(String(run!.args.flow)).toMatch(/booking confirmation|11111111-aaaa/i);
      expect(round2.calls.find((c) => c.name === "send_sms")).toBeUndefined();
      expect(round2.finalText.toLowerCase()).toMatch(/running|started|enqueued|on it/);
    }
  );
});

describe("scenario 3 — 'didnt receie anything' re-sends the INTENDED body, never the chat reply", () => {
  // Same retried single-test shape as scenarios 1 and 2: the whole turn
  // re-rolls together on a marginal draw.
  it(
    "re-sends the SAME intended message to James — not its own previous reply",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The prior exchange, as the transcript would replay it: James asked
      // for a test text to himself; the assistant sent it and SAID SO with
      // the body.
      const prior: GeminiChatContent[] = [
        { role: "user", parts: [{ text: "[SMS from owner] can us end me a text to test thus" }] },
        {
          role: "model",
          parts: [
            {
              text: `Done — I texted you at ${JAMES_E164}: "This is a test message." Let me know when it lands.`
            }
          ]
        }
      ];
      const out = await operatorTurn(
        prior,
        "[SMS from owner] didnt receie anything",
        (name, args) => {
          if (name === "send_sms") return sendSmsSuccess(args);
          if (name === "list_aiflows") return flowsFixture(false);
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );

      // The production bug: the resend body was "The text has been sent."
      const sms = out.calls.find((c) => c.name === "send_sms");
      if (!sms) {
        console.error("live reply (no resend):", out.finalText);
      }
      expect(sms, `calls: ${JSON.stringify(out.calls)}`).toBeDefined();
      expect(digits(sms!.args.toE164)).toBe(digits(JAMES_E164));
      const body = String(sms!.args.body);
      expect(body.toLowerCase()).toContain("test message");
      expect(body.toLowerCase()).not.toContain("has been sent");
      expect(body.toLowerCase()).not.toContain("i texted you");
    }
  );
});
