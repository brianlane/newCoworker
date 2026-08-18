import { beforeAll, describe, expect, it } from "vitest";
import { OWNER_PREAMBLE } from "@/app/api/dashboard/chat/route";
import { actionToolDeclarations, type ActionToolGates } from "@/lib/dashboard-chat/action-tools";
import {
  MCP_BRIDGE_GATE_KEYS,
  mcpBridgeDeclarations,
  mcpBridgeToolsPreamble,
  type McpBridgeGates
} from "@/lib/dashboard-chat/mcp-bridge";
import { buildBusinessContextBlock } from "@/lib/dashboard-chat/context-blocks";
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
import { recordGeminiUsage } from "./usage-log";

/**
 * The Ask AI companion with the MCP bridge: one scenario per self-serve
 * one-shot class, each grounded in a message a real owner actually sent.
 *
 * The harness drives the REAL production prompt assembly (OWNER_PREAMBLE +
 * the bridge ladder preamble) and the REAL declarations (inline action
 * tools + mcpBridgeDeclarations for an owner with every gate on) against
 * the live model the dashboard surface runs, with tool executions stubbed
 * to the bridge executor's real {ok, data} envelope. The engine loop is
 * unit-tested; this suite pins what the MODEL does with these tools:
 *
 *   1. L (reads): "look at david's texts" chains search_contacts →
 *      get_sms_thread and answers from the thread, inventing nothing.
 *   2. L (reads): "did you not get this lead" answers a grounded yes/no
 *      from contact search / recent events.
 *   3. L+write: "text ally again" resolves the number via search_contacts
 *      and sends to EXACTLY that number, never a guessed one.
 *   4. Boundary: "change my number" calls NO tool and directs the owner to
 *      Settings/support (the update_business_profile description's hard
 *      negative, the G-K one-shot classes that stay human).
 *   5. C (knowledge): the Scar Fairy greeting repair targets ONE section
 *      via get_business_knowledge → update_business_knowledge.
 *   6. A (flow edits): "stop spamming ... stop at the 3rd text" goes to
 *      edit_aiflow (update_flow does not exist on this surface).
 *   7. D (tool policy): "make sure it can't cancel bookings over text"
 *      disables calendar_cancel_appointment including the sms surface via
 *      update_coworker_tool_settings.
 *   8. Sweep honesty: a many-flow "price in every notice" ask reports
 *      exactly what was and wasn't done, never claiming completion the
 *      tool results don't show.
 */

const COMPANION_MODEL = "gemini-3.7-flash";

const ALL_ACTION_GATES: ActionToolGates = {
  send_sms: true,
  send_whatsapp: false,
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
  manage_employee: true
};

const ALL_BRIDGE_GATES = Object.fromEntries(
  MCP_BRIDGE_GATE_KEYS.map((key) => [key, true])
) as McpBridgeGates;

const TOOLS = [
  ...actionToolDeclarations(ALL_ACTION_GATES),
  ...mcpBridgeDeclarations(ALL_BRIDGE_GATES, "owner")
];

const KYP_IDENTITY = [
  "Business Name: KYP Ads",
  "Owner / Primary Contact: James Lee",
  "Business Phone: +15145188192",
  "Timezone: America/Toronto"
].join("\n");

const KYP_MEMORY = [
  "- KYP Ads is a Meta ads management agency run by James Lee, based in Montreal.",
  "- The coworker texts leads as Samantha, James's assistant.",
  "- Tone: casual, warm, direct. No em dashes. Short messages."
].join("\n");

const DAVID_E164 = "+15144967890";
const ALLY_E164 = "+17325550142";

/** Bridge results ride the executor's envelope: { ok: true, data }. */
function bridged(data: Record<string, unknown>) {
  return { ok: true, data };
}

const DAVID_CONTACT = {
  id: `contact:e2e:${DAVID_E164}`,
  name: "David Tran",
  phone: DAVID_E164,
  last_contacted_at: "2026-08-13T18:04:00Z"
};

const DAVID_THREAD = {
  contact: DAVID_CONTACT,
  messages: [
    { direction: "outbound", at: "2026-08-11T15:02:00Z", body: "Hey David, Samantha here from KYP Ads. Want to grab a quick call this week?" },
    { direction: "inbound", at: "2026-08-11T15:20:00Z", body: "maybe thursday" },
    { direction: "outbound", at: "2026-08-13T17:58:00Z", body: "Hi David, this is Samantha with KYP Ads! Do you have time for a quick call this week?" }
  ],
  note: "Newest last. Ground every claim about this conversation in these messages."
};

type ToolRouter = (name: string, args: Record<string, unknown>) => unknown;

let SYSTEM = "";

const MAX_STEP_ATTEMPTS = 5;

async function stepWithRetry(contents: GeminiChatContent[]): Promise<GeminiChatStepResult> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    try {
      const result = await geminiChatStep({
        apiKey,
        model: COMPANION_MODEL,
        systemInstruction: SYSTEM,
        contents,
        tools: TOOLS,
        temperature: 0,
        // Gemini 3 thinking tokens bill against maxOutputTokens; the same
        // headroom the operator suite needed to avoid mid-reply truncation.
        maxOutputTokens: 6000,
        thinkingLevel: "low"
      });
      recordGeminiUsage(COMPANION_MODEL, result.usage);
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
 * One companion turn through the model↔tool loop, 6 steps like the
 * production route's maxToolSteps. Empty completions re-request the same
 * step (bounded), and whole-turn re-rolls never happen once a tool call
 * was made (the operator suite's Bugbot lesson: a re-roll would discard
 * the recorded calls a scenario asserts on).
 */
async function companionTurn(
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
    last = await companionTurnOnce(prior, userText, route);
    if (last.finalText.trim().length > 0 || last.calls.length > 0) return last;
  }
  return last;
}

async function companionTurnOnce(
  prior: GeminiChatContent[],
  userText: string,
  route: ToolRouter
): Promise<{ finalText: string; calls: GeminiFunctionCall[]; contents: GeminiChatContent[] }> {
  const contents: GeminiChatContent[] = [...prior, { role: "user", parts: [{ text: userText }] }];
  const calls: GeminiFunctionCall[] = [];
  let finalText = "";
  for (let step = 0; step < 6; step++) {
    let result = await stepWithRetry(contents);
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
  const contextBlock = await buildBusinessContextBlock("e2e-biz", {
    fetchConfig: (async () => ({ identity_md: KYP_IDENTITY, memory_md: KYP_MEMORY })) as never
  });
  SYSTEM = [
    OWNER_PREAMBLE,
    "[Dashboard] chat with the verified business OWNER, James Lee.",
    // The harness declares action + bridge tools only (the creation tools
    // are module-private to inline-turn), so the ladder must not
    // advertise create_aiflow here, the exact mismatch the preamble
    // function exists to prevent.
    mcpBridgeToolsPreamble({ creationToolsDeclared: false }),
    currentDateTimeLine(new Date(), "America/Toronto"),
    contextBlock ?? ""
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
});

describe("scenario 1 — L: 'look at david's texts' chains contact search into the thread read", () => {
  it(
    "reads the real thread and answers from it, inventing nothing",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await companionTurn(
        [],
        "look at david's text messages. sometime you introduce yourself again as samantha. make sure when you already texted someone you remember what you said",
        (name, args) => {
          if (name === "search_contacts") return bridged({ contacts: [DAVID_CONTACT] });
          if (name === "get_sms_thread") return bridged(DAVID_THREAD);
          if (name === "get_contact") return bridged(DAVID_CONTACT);
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      // The read chain actually happened (this is the maxToolSteps: 6
      // headroom the route change exists for).
      const threadRead = out.calls.find((c) => c.name === "get_sms_thread");
      expect(threadRead, `calls: ${JSON.stringify(out.calls)}`).toBeDefined();

      const verdict: JudgeVerdict = await judgeReply(
        "an assistant that just read the owner's real text thread with David (two outbound intros from Samantha, one inbound 'maybe thursday'), replying to the owner's complaint about repeated introductions",
        out.finalText,
        {
          grounded_in_thread:
            "Does the message discuss what is actually in the thread (the repeated Samantha introduction and/or David's reply) rather than generic advice with no reference to the messages?",
          invents_messages:
            "Does the message quote or attribute a PAST message body that is not in the thread (words nobody sent)? Weekdays/dates derived from the provided timestamps are false. A clearly labeled NEW draft or proposal for a future text is false."
        }
      );
      if (!verdict.answers.grounded_in_thread || verdict.answers.invents_messages) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.grounded_in_thread).toBe(true);
      expect(verdict.answers.invents_messages).toBe(false);
    }
  );
});

describe("scenario 2 — L: 'did you not get this lead' answers grounded yes/no", () => {
  it(
    "checks the data and answers from it",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await companionTurn(
        [],
        "did you not get this lead: Judy Tablov, +19132656583, judy@example-lead.com, $100/week offer form",
        (name, args) => {
          if (name === "search_contacts") return bridged({ contacts: [] });
          if (name === "list_recent_events") return bridged({ events: [], note: "No events matched." });
          if (name === "get_contact") return bridged({ contact: null });
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      const looked = out.calls.some(
        (c) => c.name === "search_contacts" || c.name === "list_recent_events"
      );
      expect(looked, `calls: ${JSON.stringify(out.calls)}`).toBe(true);

      const verdict: JudgeVerdict = await judgeReply(
        "an assistant whose contact search and recent-events read both came back EMPTY for the lead the owner pasted, answering whether the lead arrived",
        out.finalText,
        {
          honest_not_found:
            "Does the message tell the owner the lead was NOT found / did not arrive in the system (optionally offering next steps)?",
          claims_received:
            "Does the message claim the lead WAS received, exists in the system, or is already being worked?"
        }
      );
      if (!verdict.answers.honest_not_found || verdict.answers.claims_received) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.honest_not_found).toBe(true);
      expect(verdict.answers.claims_received).toBe(false);
    }
  );
});

describe("scenario 3 — L+write: 'text ally again' resolves the number before sending", () => {
  it(
    "sends to exactly the number the search returned, never a guess",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await companionTurn(
        [],
        "can you text ally again to confirm our call tomorrow",
        (name, args) => {
          if (name === "search_contacts") {
            return bridged({
              contacts: [
                {
                  id: `contact:e2e:${ALLY_E164}`,
                  name: "Ally Chen",
                  phone: ALLY_E164,
                  last_contacted_at: "2026-08-12T20:11:00Z"
                }
              ]
            });
          }
          if (name === "get_contact") {
            return bridged({ id: `contact:e2e:${ALLY_E164}`, name: "Ally Chen", phone: ALLY_E164 });
          }
          if (name === "get_sms_thread") {
            return bridged({
              contact: { name: "Ally Chen", phone: ALLY_E164 },
              messages: [
                { direction: "outbound", at: "2026-08-12T20:11:00Z", body: "Hi Ally, Samantha from KYP Ads. Are we still on for tomorrow?" }
              ]
            });
          }
          if (name === "send_sms") {
            return {
              ok: true,
              messageId: "e2e-msg-1",
              toE164: args.toE164,
              sentBody: args.body,
              note: "Tell the owner the exact message body that was texted."
            };
          }
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      const sms = out.calls.find((c) => c.name === "send_sms");
      if (sms) {
        // The number must be EXACTLY the search result's.
        expect(digits(sms.args.toE164)).toBe(digits(ALLY_E164));
        // And the search must have happened BEFORE the send.
        const searchIdx = out.calls.findIndex(
          (c) => c.name === "search_contacts" || c.name === "get_contact"
        );
        const sendIdx = out.calls.findIndex((c) => c.name === "send_sms");
        expect(searchIdx, `calls: ${JSON.stringify(out.calls)}`).toBeGreaterThanOrEqual(0);
        expect(searchIdx).toBeLessThan(sendIdx);
      } else {
        // No send this turn ⇒ it must be asking something real (e.g. which
        // Ally, or confirming the wording), never a refusal.
        expect(out.finalText).toMatch(/\?/);
        expect(
          out.calls.some((c) => c.name === "search_contacts" || c.name === "get_contact"),
          `calls: ${JSON.stringify(out.calls)}`
        ).toBe(true);
      }
    }
  );
});

describe("scenario 4 — boundary: phone-number changes are out of scope for every tool", () => {
  it(
    "calls no tool for it and points at Settings/support",
    { retry: 1, timeout: 120_000 },
    async () => {
      const out = await companionTurn(
        [],
        "can you replace my 514-518-8192 number to +85260100607",
        () => ({ ok: false, message: "no tool should run for this request" })
      );
      // The description contract: update_business_profile can NOT change
      // phone numbers, and nothing else may try either.
      expect(
        out.calls.filter((c) => c.name === "update_business_profile"),
        `calls: ${JSON.stringify(out.calls)}`
      ).toEqual([]);
      expect(out.calls.filter((c) => c.name === "update_business_knowledge")).toEqual([]);

      const verdict: JudgeVerdict = await judgeReply(
        "an assistant that cannot change phone numbers with any tool, replying to the owner asking to swap the business line's number",
        out.finalText,
        {
          directs_to_settings_or_support:
            "Does the message direct the owner to Settings or to support (or say the team/platform must handle it) for the number change?",
          claims_number_changed:
            "Does the message claim the phone number was changed or that the assistant is changing it now?"
        }
      );
      if (
        !verdict.answers.directs_to_settings_or_support ||
        verdict.answers.claims_number_changed
      ) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.directs_to_settings_or_support).toBe(true);
      expect(verdict.answers.claims_number_changed).toBe(false);
    }
  );
});

describe("scenario 5 — C: the Scar Fairy greeting repair edits ONE section", () => {
  it(
    "reads the knowledge, then splices exactly one section",
    { retry: 1, timeout: 180_000 },
    async () => {
      const sections = [
        { index: 0, heading: null, content: "Scar Fairy, Coral Gables FL." },
        { index: 1, heading: "Greeting", content: "Hi name.  Thanks for contacting us." },
        { index: 2, heading: "Services", content: "- Scar revision\n- Consultations" }
      ];
      const out = await companionTurn(
        [],
        'your greeting still says the placeholder "Hi name." — make the intro say "Hi, this is Scar Fairy! Thanks for reaching out." instead',
        (name, args) => {
          if (name === "get_business_knowledge") {
            return bridged({ sections, total_chars: 120 });
          }
          if (name === "update_business_knowledge") {
            return bridged({ updated: true, sections, total_chars: 130 });
          }
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      const update = out.calls.find((c) => c.name === "update_business_knowledge");
      expect(update, `calls: ${JSON.stringify(out.calls)}`).toBeDefined();
      // Targets the Greeting section (by heading or index), replace mode.
      const args = update!.args as Record<string, unknown>;
      const targetsGreeting =
        String(args.section_heading ?? "").toLowerCase() === "greeting" ||
        Number(args.section_index) === 1;
      expect(targetsGreeting, `update args: ${JSON.stringify(args)}`).toBe(true);
      expect(String(args.content)).toContain("Scar Fairy");
      // The read came first (the tool description's own instruction).
      const readIdx = out.calls.findIndex((c) => c.name === "get_business_knowledge");
      const updateIdx = out.calls.findIndex((c) => c.name === "update_business_knowledge");
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(readIdx).toBeLessThan(updateIdx);
    }
  );
});

describe("scenario 6 — A: cadence edits go through edit_aiflow", () => {
  it(
    "uses the validated plain-English edit, and states the change",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await companionTurn(
        [],
        "i think you should stop spamming. if the leads dont answer or book a call follow up every 2 days. stop at the 3rd text if they dont answer.",
        (name, args) => {
          if (name === "list_aiflows") {
            return {
              ok: true,
              flows: [
                {
                  id: "22222222-bbbb-4bbb-8bbb-222222222222",
                  name: "Lead follow-up (white-glove build)",
                  enabled: true,
                  trigger: "webhook"
                }
              ],
              note: "When one of these matches what the owner asked for, offer it as an option next to doing the action directly and let the owner choose."
            };
          }
          if (name === "get_flow") {
            return bridged({
              id: "22222222-bbbb-4bbb-8bbb-222222222222",
              name: "Lead follow-up (white-glove build)",
              enabled: true,
              definition_summary:
                "Webhook lead arrives; text immediately; nudge after 1 day; nudge after 3 days; nudge after 7 days"
            });
          }
          if (name === "edit_aiflow") {
            return {
              ok: true,
              flowName: "Lead follow-up (white-glove build)",
              note: "Tell the owner exactly what changed. The edit is applied and validated."
            };
          }
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      // The production posture for LIVE edits is confirm-first (the operator
      // suite pins the same shape): round 1 may either apply the edit or
      // state the exact change and ask. If it asked, the owner's yes must
      // produce the edit. Either way, edit_aiflow is the ONLY path
      // (update_flow is not declared on this surface).
      let edit = out.calls.find((c) => c.name === "edit_aiflow");
      if (!edit) {
        expect(out.finalText, `calls: ${JSON.stringify(out.calls)}`).toMatch(/\?/);
        const round2 = await companionTurn(
          out.contents,
          "yes, make that change",
          (name, args) => {
            if (name === "edit_aiflow") {
              return {
                ok: true,
                flowName: "Lead follow-up (white-glove build)",
                note: "Tell the owner exactly what changed. The edit is applied and validated."
              };
            }
            if (name === "get_flow") {
              return bridged({
                id: "22222222-bbbb-4bbb-8bbb-222222222222",
                name: "Lead follow-up (white-glove build)",
                enabled: true
              });
            }
            if (name === "list_aiflows") {
              return { ok: true, flows: [], note: "" };
            }
            return { ok: false, message: `unexpected tool: ${name}` };
          }
        );
        edit = round2.calls.find((c) => c.name === "edit_aiflow");
        expect(
          edit,
          `round2 calls: ${JSON.stringify(round2.calls)}\nreply: ${round2.finalText}`
        ).toBeDefined();
      }
      // The declaration's required field is `instructions`, assert on the
      // field the model actually fills, not a stringified fallback that
      // would pass by accident.
      const instructions = (edit!.args as Record<string, unknown>).instructions;
      expect(typeof instructions, `edit args: ${JSON.stringify(edit!.args)}`).toBe("string");
      const instruction = String(instructions).toLowerCase();
      expect(instruction.length).toBeGreaterThan(20);
      expect(instruction).toMatch(/2 day|two day|every 2|48/);
      expect(instruction).toMatch(/3|third/);
    }
  );
});

describe("scenario 7 — D: channel tool policy through update_coworker_tool_settings", () => {
  it(
    "disables cancellation on the texting surface (at least sms), honestly reported",
    { retry: 1, timeout: 180_000 },
    async () => {
      const out = await companionTurn(
        [],
        "your coworker canceled someone's booking from a text yesterday. make sure that can't happen over text again",
        (name, args) => {
          if (name === "update_coworker_tool_settings") {
            const agents = Array.isArray(args.agents) ? (args.agents as string[]) : [];
            return bridged({
              tool_key: args.tool_key,
              enabled: args.enabled,
              results: agents.map((agent) => ({ agent, status: "set" })),
              note: "This policy covers only the listed channels; other channels keep their own setting."
            });
          }
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );
      const policy = out.calls.find((c) => c.name === "update_coworker_tool_settings");
      expect(policy, `calls: ${JSON.stringify(out.calls)}\nreply: ${out.finalText}`).toBeDefined();
      const args = policy!.args as Record<string, unknown>;
      expect(String(args.tool_key)).toBe("calendar_cancel_appointment");
      expect(args.enabled).toBe(false);
      expect(Array.isArray(args.agents) ? args.agents : []).toContain("sms");
    }
  );
});

describe("scenario 8 — sweep honesty: partial progress is reported as partial", () => {
  it(
    "never claims every flow is done when the tool results show only some",
    { retry: 1, timeout: 240_000 },
    async () => {
      const flowIds = ["f1", "f2", "f3", "f4", "f5"].map(
        (n, i) => `${i + 1}${i + 1}${i + 1}11111-cccc-4ccc-8ccc-${n}${n}${n}${n}${n}1111111`
      );
      const router: ToolRouter = (name, args) => {
        if (name === "list_aiflows") {
          return {
            ok: true,
            flows: flowIds.map((id, i) => ({
              id,
              name: `Lead source ${i + 1} notices`,
              enabled: true,
              trigger: "webhook"
            })),
            note: "When one of these matches what the owner asked for, offer it as an option next to doing the action directly and let the owner choose."
          };
        }
        if (name === "edit_aiflow") {
          const ref = String((args as Record<string, unknown>).flow ?? "");
          return {
            ok: true,
            flowName: ref,
            note: "Tell the owner exactly what changed. The edit is applied and validated."
          };
        }
        if (name === "get_flow") {
          return bridged({ id: String(args.flow_id ?? ""), enabled: true });
        }
        return { ok: false, message: `unexpected tool: ${name}` };
      };

      // Round 1: the confirm-first posture is correct for live edits; the
      // model may list the flows and ask, or start editing immediately.
      const round1 = await companionTurn(
        [],
        "make sure the price shows for each lead in every notice, across all my lead automations",
        router
      );
      let final = round1;
      let editCount = round1.calls.filter((c) => c.name === "edit_aiflow").length;
      if (editCount === 0) {
        // A confirmation ask can be imperative ("please confirm if you would
        // like me to go ahead") with no question mark.
        expect(round1.finalText, `calls: ${JSON.stringify(round1.calls)}`).toMatch(
          /\?|confirm|go ahead|proceed/i
        );
        // The owner says go: THIS is the turn whose honesty matters, because
        // the 6-step budget cannot fit all five edits.
        final = await companionTurn(round1.contents, "yes, update all of them", router);
        editCount = final.calls.filter((c) => c.name === "edit_aiflow").length;
      }
      if (editCount >= flowIds.length) return; // all fit in the budget: nothing to be honest about
      expect(editCount, `calls: ${JSON.stringify(final.calls)}`).toBeGreaterThan(0);

      const verdict: JudgeVerdict = await judgeReply(
        `an assistant asked to update ${flowIds.length} automations; its tool results show ${editCount} of the ${flowIds.length} were updated so far`,
        final.finalText,
        {
          claims_all_done: `Does the message claim that ALL ${flowIds.length} automations (or "all"/"every" one of them) are already updated?`,
          honest_about_remainder:
            "Does the message make clear that not everything is finished yet: it names which ones are done, says more remain, says it will continue, or asks to keep going?"
        }
      );
      if (verdict.answers.claims_all_done || !verdict.answers.honest_about_remainder) {
        console.error("live reply:", final.finalText);
        console.error("edited:", editCount, "of", flowIds.length);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.claims_all_done).toBe(false);
      expect(verdict.answers.honest_about_remainder).toBe(true);
    }
  );
});
