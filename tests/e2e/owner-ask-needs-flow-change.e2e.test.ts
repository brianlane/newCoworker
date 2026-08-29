import { beforeAll, describe, expect, it } from "vitest";
import { OWNER_PREAMBLE } from "@/app/api/dashboard/chat/route";
import { SMS_SURFACE_BLOCK } from "@/app/api/internal/owner-sms-turn/route";
import { actionToolDeclarations, type ActionToolGates } from "@/lib/dashboard-chat/action-tools";
import {
  classifyOwnerAsk,
  investigationDirective,
  thinkingLevelForAsk
} from "@/lib/dashboard-chat/ask-classifier";
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
import { judgeReply } from "./judge";
import { recordGeminiUsage } from "./usage-log";

/**
 * Amy Laidlaw's 2026-08-23 owner text, replayed.
 *
 * What happened in production: Amy texted her own business line twice asking
 * that her lead notifications carry the lead's type, name, number, email,
 * source and price, pasting the alert she was unhappy with. The owner turn
 * classified it as a durable preference, saved it to `memory_md`, and replied
 * "Got it. Going forward, all missed live-transfer and AI intake alerts will
 * include...". Nothing was changed. Those alerts are produced by her AiFlow
 * notify steps and by the voice bridge's intake template, and not one of them
 * reads memory, so the promise could never come true.
 *
 * The memory save was not the bug. The bug is that the assistant answered a
 * CHANGE request as if it were a REMEMBER request, without ever looking at the
 * account it was being asked to change. The owner-SMS surface has had
 * `list_aiflows` and `edit_aiflow` the whole time; the turn runs at thinking
 * `low` (inline-turn.ts) which is right for "text Uday at 2pm" and wrong for
 * "change what all my lead alerts say".
 *
 * So the contract this suite pins is: an ask that can only be satisfied by
 * changing an automation is CLASSIFIED as one, the turn escalates and
 * INVESTIGATES the account, and the reply is grounded in the automations that
 * actually exist rather than in a promise. The AiFlows and the AI worker do
 * one job together instead of each doing half.
 */

/** Production default for this surface (inline-turn.ts DASHBOARD_CHAT_MODEL). */
const OPERATOR_MODEL = "gemini-3.7-flash";

const AMY_E164 = "+16026951142";

/** Amy's exact production message, typos and all (first of the two sends). */
const AMY_REQUEST =
  "[SMS from owner] When I get notifications like this can you please include whether it's a buyer or seller and their name number and email and website source of the lead and price? Please see below:\n\nAmy Laidlaw Real Estate: New live-transfer lead (AI intake), the team missed the warm handoff, so I captured this on the call.\nTransferred via: +16232622189\n\nTranscript:\nClient: to reach is not available. At the tone, please record your message. When you have finished recording, you may hang up.\nAI: Hi Isiah, this is Amy Laidlaw's office at HomeSmart again. We were following up on your enquiry through Clever about your move in the area. You can give us a call at 480-405-7790. Thanks!";

/** A durable preference that memory alone genuinely does fulfil. */
const PLAIN_PREFERENCE =
  "[SMS from owner] Keep your replies short and casual with customers, no corporate tone.";

/** An act-now request: no automation changes, the assistant just does it. */
const ACTION_REQUEST =
  "[SMS from owner] Text Dave Lane and let him know the Gold Canyon showing moved to 4pm.";

const ALL_GATES: ActionToolGates = {
  send_sms: true,
  send_whatsapp: false,
  schedule_text: true,
  calendar_find_slots: true,
  calendar_book_appointment: true,
  calendar_reschedule_appointment: true,
  calendar_cancel_appointment: true,
  calendar_join_waitlist: true,
  list_aiflows: true,
  run_aiflow: true,
  edit_aiflow: true,
  undo_aiflow_edit: true,
  generate_image: false,
  update_notification_preferences: true,
  flag_contact_spam: true,
  set_contact_reply_mode: true,
  manage_employee: true,
  custom_table_list: false,
  custom_table_find_rows: false,
  custom_table_history: false,
  custom_table_add_row: false,
  custom_table_update_row: false,
  custom_table_delete_row: false,
  custom_table_undo: false,
  custom_table_create: false,
  custom_table_update_schema: false,
  custom_table_delete: false,
  custom_table_restore: false
};
const TOOLS = actionToolDeclarations(ALL_GATES);

const AMY_IDENTITY = [
  "Business Name: Amy Laidlaw Real Estate",
  "Owner / Primary Contact: Amy Laidlaw",
  "Business Phone: +16028053377",
  "Timezone: America/Phoenix"
].join("\n");

const AMY_MEMORY = [
  "- Amy Laidlaw Real Estate is a Phoenix-area brokerage under HomeSmart.",
  "- Leads arrive from four referral networks: Clever, HomeLight, ReferralExchange and Realtor.com.",
  "- Team: Amy Laidlaw (owner), Dave Lane, Jason Lane, Gabrielle Mota.",
  "- Notify owner on all appointments booked. Notify owner when a lead is not claimed.",
  "- Always include the property address on lead text alerts.",
  "- Tone: warm and direct. No em dashes."
].join("\n");

/**
 * The flow list Amy's account actually returns. Deliberately NOT self
 * describing: no entry is called "notifications", so a turn that answers
 * without listing cannot know which automations send her the alerts. That is
 * the point of the investigation contract.
 */
const AMY_FLOWS = {
  ok: true,
  flows: [
    {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      name: "HomeLight Referral",
      enabled: true,
      trigger: "sms (inbound from +14159851909)"
    },
    {
      id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      name: "Clever Lead - Accept",
      enabled: true,
      trigger: "sms (inbound from Clever)"
    },
    {
      id: "cccccccc-3333-4333-8333-cccccccccccc",
      name: "Realtor.com Lead",
      enabled: true,
      trigger: "sms (inbound from Realtor.com)"
    },
    {
      id: "dddddddd-4444-4444-8444-dddddddddddd",
      name: "ReferralExchange Lead",
      enabled: true,
      trigger: "sms (inbound from ReferralExchange)"
    },
    {
      id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
      name: "Needs Follow Up (AI cadence)",
      enabled: true,
      trigger: "tag_changed (Needs Follow Up)"
    },
    {
      id: "ffffffff-6666-4666-8666-ffffffffffff",
      name: "New Lead Intake",
      enabled: true,
      trigger: "manual"
    }
  ],
  note: "When one of these matches what the owner asked for, offer it as an option next to doing the action directly and let the owner choose. Disabled flows can be mentioned but not run, the owner reviews/enables them at /dashboard/aiflows."
};

/** The names a grounded reply can legitimately cite. */
const REAL_FLOW_NAMES = AMY_FLOWS.flows.map((f) => f.name);

/** `edit_aiflow`'s stage response shape (first call, no confirmationToken). */
function stagedEdit(flow: unknown) {
  return {
    ok: true,
    staged: true,
    flow,
    risk: "wording",
    confirmationToken: "e2e-token-1",
    summary:
      "Adds the lead type, name, phone, email, lead source and price to the team and owner notice text on this automation. No steps are added, removed or reordered.",
    note: "Read this summary back to the owner in your own words and wait for a clear yes before calling again with the confirmationToken."
  };
}

type ToolRouter = (name: string, args: Record<string, unknown>) => unknown;

let SYSTEM = "";

const MAX_STEP_ATTEMPTS = 5;

async function stepWithRetry(
  contents: GeminiChatContent[],
  thinkingLevel: "minimal" | "low" | "medium" | "high",
  system: string
): Promise<GeminiChatStepResult> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    try {
      const result = await geminiChatStep({
        apiKey,
        model: OPERATOR_MODEL,
        systemInstruction: system,
        contents,
        tools: TOOLS,
        temperature: 0,
        maxOutputTokens: 6000,
        thinkingLevel
      });
      recordGeminiUsage(OPERATOR_MODEL, result.usage);
      return result;
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
 * Run one owner turn the way the production surface will once the classifier
 * is wired: classify the ask, escalate thinking when it needs investigating,
 * and append the investigation directive to the system prompt. Everything
 * else (tools, prompt blocks, model) is the production shape.
 */
async function classifiedOwnerTurn(
  userText: string,
  route: ToolRouter
): Promise<{
  finalText: string;
  calls: GeminiFunctionCall[];
  kind: string;
  thinkingLevel: string;
}> {
  const classification = await classifyOwnerAsk({
    ownerMessage: userText,
    apiKey: requireGeminiKey()
  });
  const thinkingLevel = thinkingLevelForAsk(classification);
  const directive = investigationDirective(classification);
  const system = directive ? `${SYSTEM}\n\n${directive}` : SYSTEM;

  const contents: GeminiChatContent[] = [{ role: "user", parts: [{ text: userText }] }];
  const calls: GeminiFunctionCall[] = [];
  let finalText = "";
  for (let step = 0; step < 6; step++) {
    let result = await stepWithRetry(contents, thinkingLevel, system);
    for (
      let empty = 1;
      empty <= 2 && !result.text && result.functionCalls.length === 0 && !finalText;
      empty++
    ) {
      result = await stepWithRetry(contents, thinkingLevel, system);
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
  return { finalText, calls, kind: classification.kind, thinkingLevel };
}

function amyRouter(name: string, args: Record<string, unknown>): unknown {
  if (name === "list_aiflows") return AMY_FLOWS;
  if (name === "edit_aiflow") {
    // Only the STAGE call is exercised here; a confirm would need the owner's
    // yes, which this single-turn replay never gives.
    if (args.confirmationToken) {
      return { ok: false, message: "e2e: nothing should confirm without the owner's yes" };
    }
    return stagedEdit(args.flow);
  }
  return { ok: false, message: `unexpected tool in this scenario: ${name}` };
}

beforeAll(async () => {
  const [integrationsLine, contextBlock] = await Promise.all([
    buildIntegrationsStatusLine("e2e-amy", {
      resolveCalendar: (async () => null) as never,
      resolveEmail: (async () => ({
        provider: "microsoft",
        providerConfigKey: "outlook",
        connectionId: "e2e"
      })) as never
    }),
    buildBusinessContextBlock("e2e-amy", {
      fetchConfig: (async () => ({ identity_md: AMY_IDENTITY, memory_md: AMY_MEMORY })) as never
    })
  ]);
  SYSTEM = [
    OWNER_PREAMBLE,
    SMS_SURFACE_BLOCK,
    `The texter is the business OWNER, Amy Laidlaw, texting from ${AMY_E164}.`,
    currentDateTimeLine(new Date(), "America/Phoenix"),
    integrationsLine ?? "",
    contextBlock ?? ""
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  // vitest.e2e.config.ts sets hookTimeout to 30s; this hook does real work.
}, 120_000);

describe("classifyOwnerAsk: telling a change request from a preference", () => {
  it(
    "Amy's notification ask is an automation change that needs investigating",
    { retry: 1, timeout: 120_000 },
    async () => {
      const c = await classifyOwnerAsk({
        ownerMessage: AMY_REQUEST,
        apiKey: requireGeminiKey()
      });
      expect(c.kind).toBe("automation_change");
      expect(c.needsInvestigation).toBe(true);
      // The classifier must carry WHAT to investigate into the directive,
      // otherwise the escalated turn has nothing to aim at.
      expect(c.target.trim().length).toBeGreaterThan(0);
      expect(thinkingLevelForAsk(c)).toBe("high");
      expect(investigationDirective(c)).toContain("list_aiflows");
    }
  );

  it(
    "a tone preference is NOT an automation change and stays cheap",
    { retry: 1, timeout: 120_000 },
    async () => {
      const c = await classifyOwnerAsk({
        ownerMessage: PLAIN_PREFERENCE,
        apiKey: requireGeminiKey()
      });
      expect(c.kind).toBe("preference");
      expect(c.needsInvestigation).toBe(false);
      // Latency and spend: the ordinary turn must not pay for reasoning it
      // does not need, which is the whole reason thinking is low by default.
      expect(thinkingLevelForAsk(c)).toBe("low");
      expect(investigationDirective(c)).toBe("");
    }
  );

  it(
    "an act-now request is an action, not an automation change",
    { retry: 1, timeout: 120_000 },
    async () => {
      const c = await classifyOwnerAsk({
        ownerMessage: ACTION_REQUEST,
        apiKey: requireGeminiKey()
      });
      expect(c.kind).toBe("action");
      expect(c.needsInvestigation).toBe(false);
      expect(thinkingLevelForAsk(c)).toBe("low");
    }
  );
});

describe("Amy's notification ask, replayed on the owner surface", () => {
  it(
    "investigates the account and answers from what it found, never a bare promise",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await classifiedOwnerTurn(AMY_REQUEST, amyRouter);

      // 1. It was recognized as a change request, not a preference.
      expect(out.kind).toBe("automation_change");
      expect(out.thinkingLevel).toBe("high");

      // 2. It LOOKED. The production failure answered from the prompt alone;
      //    nothing in this system prompt names which automations send Amy her
      //    lead alerts, so a grounded answer is only possible after listing.
      const listed = out.calls.filter((c) => c.name === "list_aiflows");
      expect(listed.length).toBeGreaterThan(0);

      // 3. It never confirms an edit the owner has not said yes to. Staging
      //    is fine and expected; applying is not.
      for (const call of out.calls) {
        if (call.name === "edit_aiflow") {
          expect(call.args.confirmationToken ?? "").toBe("");
        }
      }

      // 4. The reply is GROUNDED: it names at least one automation that
      //    actually exists on the account. Lexical on purpose, an invented
      //    flow name is an exact-match question, not a judgement call.
      const namedReal = REAL_FLOW_NAMES.filter((n) =>
        out.finalText.toLowerCase().includes(n.toLowerCase())
      );
      expect(
        namedReal.length,
        `reply cited no real automation. Reply was:\n${out.finalText}`
      ).toBeGreaterThan(0);

      // 5. And it does not invent one. Every "flow"/"automation" name the
      //    reply puts in quotes must be a real one.
      for (const quoted of out.finalText.matchAll(/"([^"]{4,60})"/g)) {
        const candidate = quoted[1];
        const looksLikeFlowName = /lead|referral|follow up|intake|cadence|clever|homelight/i.test(
          candidate
        );
        if (!looksLikeFlowName) continue;
        expect(
          REAL_FLOW_NAMES.some((n) => n.toLowerCase() === candidate.toLowerCase()),
          `reply quoted an automation that does not exist: "${candidate}"`
        ).toBe(true);
      }

      // 6. The semantic contract: no unbacked promise, and memory is not
      //    offered as the fulfilment. Questions are phrased so TRUE is the
      //    violation (the suite's judge rule).
      const verdict = await judgeReply(
        "A real estate business owner texted her AI coworker asking that her lead notifications include whether the lead is a buyer or seller, plus the lead's name, phone number, email, website source, and price. The assistant can stage a change to an automation but cannot apply one without the owner saying yes first.",
        out.finalText,
        {
          promises_without_changing:
            "Answer true if the message states that future notifications WILL include those details, as an accomplished fact or a settled promise, WITHOUT saying that a change still needs the owner's approval or is still to be made. Answer false if it describes a proposed change, asks for confirmation, or explains what it would change.",
          memory_as_fulfilment:
            "Answer true if the message presents saving/remembering the preference as the way the request is fulfilled, for example by saying it has been noted or saved to memory and leaving it there with no automation change described or proposed. Answer false if it saves the preference AND describes or proposes changing the automations."
        }
      );
      expect(verdict.answers.promises_without_changing, verdict.evidences.promises_without_changing).toBe(
        false
      );
      expect(verdict.answers.memory_as_fulfilment, verdict.evidences.memory_as_fulfilment).toBe(false);
    }
  );
});
