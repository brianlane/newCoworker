import { beforeAll, describe, expect, it } from "vitest";
import {
  EMAIL_TOOL_ENABLED_PREAMBLE,
  OWNER_PREAMBLE
} from "@/app/api/dashboard/chat/route";
import { SMS_SURFACE_BLOCK } from "@/app/api/internal/owner-sms-turn/route";
import { extractEmailSendRequests } from "@/lib/dashboard-chat/email-blocks";
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
import { formatBookingLinkPromptLine } from "@/lib/booking-page/prompt-line";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { recordGeminiUsage } from "./usage-log";

/**
 * The Beth delegation replay (New Coworker HQ, 2026-07-24).
 *
 * What happened by hand: Liz asked to be scheduled through her assistant
 * Beth, so the founder emailed Beth three Monday times, Beth replied with
 * "Liz has availability Monday at 12:00 PM EST", and the founder booked it
 * and sent the Zoom invite. Every step was manual, in a personal inbox.
 *
 * This suite replays the OWNER half against the surface that handles it:
 * the owner-over-SMS operator turn (/api/internal/owner-sms-turn), with the
 * REAL production prompt blocks (OWNER_PREAMBLE + SMS_SURFACE_BLOCK +
 * EMAIL_TOOL_ENABLED_PREAMBLE, imported not paraphrased), the REAL action
 * tool declarations, and the REAL email-block parser the route fulfils
 * with. Pinned contracts:
 *
 *   1. With no contact details for Beth, the coworker ASKS. It never
 *      invents an address or a number, and it commits nothing (the Derek
 *      Schultz phantom-action class).
 *   2. Given Beth's address, it EMAILS BETH: exactly one EMAIL_SEND block
 *      to her, never to the owner, never to Liz, grounded in real
 *      availability and never claiming the call is already scheduled.
 *   3. Third-party booking: when the confirmer is arranging FOR someone
 *      else, the booking carries the ATTENDEE's identity (Liz), not the
 *      confirmer's (Beth), so the calendar invite reaches the right person.
 *
 * Temperature 0 for CI stability (production runs 0.3 on this surface);
 * the engine loop is unit-tested, this pins what the MODEL does with the
 * production prompts and tools.
 */

/** The inline engine's production default (DASHBOARD_CHAT_MODEL). */
const OPERATOR_MODEL = "gemini-3.7-flash";

const OWNER_E164 = "+16026886672";
const BETH_EMAIL = "beth@lizdev.example.com";
const LIZ_EMAIL = "liz@lizdev.example.com";
/** The vanity link the coworker is told about, asserted verbatim below. */
const BOOKING_LINK = {
  url: "https://www.newcoworker.com/book/new-coworker",
  title: "NC Discovery Call",
  // 30 minutes matches this scenario's own memory line ("Discovery calls are
  // 30 minutes over Zoom with Brian"), so the prompt cannot state one length
  // while the memory states another.
  meetings: [{ name: "NC Discovery Call", durationMinutes: 30 }],
  kind: "booking_page" as const
};
/** HQ runs on America/Phoenix; Beth and Liz are Eastern. */
const BUSINESS_TZ = "America/Phoenix";

/** Monday's real openings, as the find-slots stub offers them: Jul 27
 * 2026, 9:00 / 10:30 / 12:00 Phoenix (UTC-7) = 12:00 / 13:30 / 15:00 EDT. */
const SLOTS = [
  { startIso: "2026-07-27T16:00:00.000Z", endIso: "2026-07-27T16:30:00.000Z" },
  { startIso: "2026-07-27T17:30:00.000Z", endIso: "2026-07-27T18:00:00.000Z" },
  { startIso: "2026-07-27T19:00:00.000Z", endIso: "2026-07-27T19:30:00.000Z" }
];

const ALL_GATES: ActionToolGates = {
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
const TOOLS = actionToolDeclarations(ALL_GATES);

const HQ_IDENTITY = [
  "Business Name: New Coworker",
  "Owner / Primary Contact: Brian Lane",
  "Business Phone: +16026886672",
  "Timezone: America/Phoenix"
].join("\n");

const HQ_MEMORY = [
  "- New Coworker gives small businesses an AI coworker that answers their calls and texts.",
  "- Discovery calls are 30 minutes over Zoom with Brian, the founder.",
  "- Liz Alvarez is a warm lead in the discovery pipeline; her executive assistant is Beth Ranken.",
  "- Tone: casual, warm, direct, like a real person. Short messages. No em dashes."
].join("\n");

const FIND_SLOTS_OK = {
  ok: true,
  slots: SLOTS,
  timezone: BUSINESS_TZ,
  purpose: "discovery call",
  durationMinutes: 30
};

type ToolRouter = (name: string, args: Record<string, unknown>) => unknown;

let SYSTEM = "";

const MAX_STEP_ATTEMPTS = 5;

/** One retried live model step (mirror of gemini.ts's transient policy). */
async function stepWithRetry(contents: GeminiChatContent[]): Promise<GeminiChatStepResult> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    try {
      const result = await geminiChatStep({
        apiKey,
        model: OPERATOR_MODEL,
        systemInstruction: SYSTEM,
        contents,
        tools: TOOLS,
        temperature: 0,
        // Gemini 3 thinking bills against maxOutputTokens; the operator
        // suite's proven budget (a smaller cap truncated correctly-shaped
        // replies mid-question on PR #766).
        maxOutputTokens: 6000,
        thinkingLevel: "low"
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
 * Run one owner turn through the model-tool loop. Same shape (and same
 * de-flake rationale) as the KYP operator suite: a completely empty turn
 * is re-rolled whole, but an attempt that made tool calls never is.
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

/** Every address the reply would actually mail, via the REAL parser. */
function emailTargets(finalText: string) {
  const { requests } = extractEmailSendRequests(finalText);
  return requests;
}

beforeAll(async () => {
  const [integrationsLine, contextBlock] = await Promise.all([
    buildIntegrationsStatusLine("e2e-biz", {
      resolveCalendar: (async () => ({
        provider: "google",
        providerConfigKey: "google",
        connectionId: "e2e"
      })) as never,
      resolveEmail: (async () => ({
        provider: "google",
        providerConfigKey: "google",
        connectionId: "e2e"
      })) as never
    }),
    buildBusinessContextBlock("e2e-biz", {
      fetchConfig: (async () => ({ identity_md: HQ_IDENTITY, memory_md: HQ_MEMORY })) as never
    })
  ]);
  SYSTEM = [
    OWNER_PREAMBLE,
    SMS_SURFACE_BLOCK,
    `The texter is the business OWNER, Brian Lane, texting from ${OWNER_E164}.`,
    EMAIL_TOOL_ENABLED_PREAMBLE,
    currentDateTimeLine(new Date("2026-07-24T16:00:00.000Z"), BUSINESS_TZ),
    integrationsLine ?? "",
    // The REAL booking-link hint (imported, not paraphrased), the same
    // line production injects when the business has an enabled page.
    formatBookingLinkPromptLine(BOOKING_LINK),
    contextBlock ?? ""
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
});

describe("Beth delegation, no contact details given", () => {
  it(
    "asks for Beth's contact instead of inventing one, and commits nothing",
    { retry: 1, timeout: 240_000 },
    async () => {
      const out = await operatorTurn(
        [],
        "[SMS from owner] Please schedule liz thru her assistant beth for a discovery call",
        (name) => {
          if (name === "calendar_find_slots") return FIND_SLOTS_OK;
          return { ok: false, message: `unexpected tool in this scenario: ${name}` };
        }
      );

      // Nothing may be committed without a way to reach Beth. Availability
      // reads (calendar_find_slots) are fine and in fact desirable.
      const committed = out.calls.filter(
        (c) =>
          c.name === "send_sms" ||
          c.name === "calendar_book_appointment" ||
          c.name === "run_aiflow"
      );
      expect(committed, `calls: ${JSON.stringify(out.calls)}`).toEqual([]);

      // No email may go out either: the coworker has no address for Beth,
      // and inventing one is the exact incident class this pins.
      expect(emailTargets(out.finalText)).toEqual([]);

      // Whether the ask is a literal question is NOT pinned: "if you share
      // her email I can reach out" is the same contract without a question
      // mark, and both drew on the 2026-07-25 hammer run. The semantic
      // version (asks_for_beth_contact) is judged below.
      expect(out.finalText.trim().length).toBeGreaterThan(0);

      const verdict: JudgeVerdict = await judgeReply(
        "an assistant with working email, texting, and calendar tools, replying to the " +
          "business owner who asked it to schedule a discovery call with Liz through Liz's " +
          "assistant Beth; the assistant has NO contact details for Beth",
        out.finalText,
        {
          asks_for_beth_contact:
            "Does the message ask the owner for Beth's contact details (email address or " +
            "phone number), or otherwise ask how to reach Beth? Asking only about timing, " +
            "with no request for contact details, is false.",
          claims_scheduled:
            "Does the message state or imply the call HAS BEEN scheduled, booked, or that " +
            "Beth has already been contacted? Saying it will reach out once it has her " +
            "details is false.",
          claims_unactionable:
            "Does the message claim the assistant cannot send emails or texts, or that " +
            "the owner must do it themselves? Asking for missing details before acting is " +
            "false."
        }
      );
      if (
        !verdict.answers.asks_for_beth_contact ||
        verdict.answers.claims_scheduled ||
        verdict.answers.claims_unactionable
      ) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.asks_for_beth_contact).toBe(true);
      expect(verdict.answers.claims_scheduled).toBe(false);
      expect(verdict.answers.claims_unactionable).toBe(false);
    }
  );
});

describe("Beth delegation, address supplied", () => {
  it(
    "emails Beth exactly once with real availability, never the owner or Liz",
    { retry: 1, timeout: 240_000 },
    async () => {
      const out = await operatorTurn(
        [],
        "[SMS from owner] Please schedule liz thru her assistant beth for a discovery call. " +
          `Beth is ${BETH_EMAIL}, Liz is ${LIZ_EMAIL}. Email beth my Monday availability`,
        (name) => {
          if (name === "calendar_find_slots") return FIND_SLOTS_OK;
          return { ok: false, message: `unexpected tool in this scenario: ${name}` };
        }
      );

      const requests = emailTargets(out.finalText);
      if (requests.length !== 1) {
        console.error("live reply:", out.finalText);
      }
      expect(requests.length, `reply: ${out.finalText}`).toBe(1);
      const mail = requests[0];
      // To BETH: the assistant is the one who holds Liz's calendar.
      expect(mail.to.toLowerCase()).toBe(BETH_EMAIL);
      // Never mailed to the owner themselves (the KYP notify-the-asker class).
      expect([mail.to, ...mail.cc, ...mail.bcc].join(" ")).not.toContain("newcoworker.com");

      // Nothing is booked while Beth has not answered, and no text is sent
      // to a person the owner asked to be EMAILED.
      const committed = out.calls.filter(
        (c) => c.name === "calendar_book_appointment" || c.name === "send_sms"
      );
      expect(committed, `calls: ${JSON.stringify(out.calls)}`).toEqual([]);

      // Availability in the mail must be grounded in the tool, not invented.
      expect(
        out.calls.filter((c) => c.name === "calendar_find_slots").length,
        `calls: ${JSON.stringify(out.calls)}`
      ).toBeGreaterThan(0);

      const verdict: JudgeVerdict = await judgeReply(
        "the body of an email the business's assistant is sending to Beth, the executive " +
          "assistant of a prospect named Liz, proposing times for a 30 minute Zoom " +
          "discovery call on Monday July 27 2026",
        mail.body,
        {
          offers_times:
            "Does the message propose one or more specific times for the call? Asking " +
            "only 'when are you free' with no proposed times is false.",
          bare_time_no_zone:
            "Does the message mention any specific clock time (like 9:00 AM) WITHOUT " +
            "naming a time zone for it? A message with no clock times at all is false.",
          claims_scheduled:
            "Does the message state the call is already scheduled, booked, or confirmed, " +
            "rather than proposing times and asking Beth to confirm?"
        }
      );
      if (
        !verdict.answers.offers_times ||
        verdict.answers.bare_time_no_zone ||
        verdict.answers.claims_scheduled
      ) {
        console.error("email body:", mail.body);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.offers_times).toBe(true);
      expect(verdict.answers.bare_time_no_zone).toBe(false);
      expect(verdict.answers.claims_scheduled).toBe(false);
    }
  );
});

describe("Beth delegation, bare ask: the link is the default", () => {
  it(
    "emails Beth the booking link WITHOUT being told to",
    { retry: 1, timeout: 240_000 },
    async () => {
      // The exact ask from the owner, nothing about links or availability:
      // knowing the business schedules through this link is the coworker's
      // job, not the owner's.
      const out = await operatorTurn(
        [],
        "[SMS from owner] Please schedule liz thru her assistant beth for a discovery call. " +
          `Beth is ${BETH_EMAIL}`,
        (name) => {
          if (name === "calendar_find_slots") return FIND_SLOTS_OK;
          return { ok: false, message: `unexpected tool in this scenario: ${name}` };
        }
      );

      const requests = emailTargets(out.finalText);
      if (requests.length !== 1) {
        console.error("live reply:", out.finalText);
      }
      expect(requests.length, `reply: ${out.finalText}`).toBe(1);
      const mail = requests[0];
      expect(mail.to.toLowerCase()).toBe(BETH_EMAIL);
      expect(mail.body, `email body: ${mail.body}`).toContain(BOOKING_LINK.url);

      // Nothing is booked and nobody is texted while Beth has not answered.
      const committed = out.calls.filter(
        (c) => c.name === "calendar_book_appointment" || c.name === "send_sms"
      );
      expect(committed, `calls: ${JSON.stringify(out.calls)}`).toEqual([]);
    }
  );
});

describe("Beth delegation, booking link requested", () => {
  it(
    "emails Beth the exact vanity link, books nothing, invents no URL",
    { retry: 1, timeout: 240_000 },
    async () => {
      const out = await operatorTurn(
        [],
        "[SMS from owner] Please schedule liz thru her assistant beth for a discovery call. " +
          `Beth is ${BETH_EMAIL}. Just email her our booking link so she can pick a time`,
        (name) => {
          if (name === "calendar_find_slots") return FIND_SLOTS_OK;
          return { ok: false, message: `unexpected tool in this scenario: ${name}` };
        }
      );

      const requests = emailTargets(out.finalText);
      if (requests.length !== 1) {
        console.error("live reply:", out.finalText);
      }
      expect(requests.length, `reply: ${out.finalText}`).toBe(1);
      const mail = requests[0];
      expect(mail.to.toLowerCase()).toBe(BETH_EMAIL);

      // The EXACT link from the system context, character for character: a
      // paraphrased or invented URL is a dead link in a prospect's inbox.
      expect(mail.body, `email body: ${mail.body}`).toContain(BOOKING_LINK.url);

      // Nothing is booked and nobody is texted: Beth picks the time on the
      // page, and the page itself pages the owner when she does.
      const committed = out.calls.filter(
        (c) => c.name === "calendar_book_appointment" || c.name === "send_sms"
      );
      expect(committed, `calls: ${JSON.stringify(out.calls)}`).toEqual([]);

      const verdict: JudgeVerdict = await judgeReply(
        "the body of an email the business's assistant is sending to Beth, the executive " +
          "assistant of a prospect named Liz, whose boss wants a 30 minute discovery call; " +
          "the email should hand Beth a self-serve booking link",
        mail.body,
        {
          sends_booking_link:
            "Does the message present a booking or scheduling link for Beth to pick a " +
            "time herself?",
          claims_scheduled:
            "Does the message state the call is already scheduled, booked, or confirmed?",
          invents_other_url:
            "Does the message contain any OTHER http(s) URL besides " +
            `${BOOKING_LINK.url} (a second, different link)?`
        }
      );
      if (
        !verdict.answers.sends_booking_link ||
        verdict.answers.claims_scheduled ||
        verdict.answers.invents_other_url
      ) {
        console.error("email body:", mail.body);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.sends_booking_link).toBe(true);
      expect(verdict.answers.claims_scheduled).toBe(false);
      expect(verdict.answers.invents_other_url).toBe(false);
    }
  );
});

describe("Third-party booking: the attendee is who the meeting is FOR", () => {
  it(
    "books Liz, not Beth, when Beth confirms on Liz's behalf",
    { retry: 1, timeout: 240_000 },
    async () => {
      // Beth's real answer, relayed by the owner: "Liz has availability
      // Monday afternoon at 12:00 PM EST" = 9:00 AM Phoenix = SLOTS[0].
      const out = await operatorTurn(
        [],
        "[SMS from owner] Beth wrote back: Liz has availability Monday at 12:00 PM EST, " +
          `send the zoom invite. Liz is ${LIZ_EMAIL}, Beth is ${BETH_EMAIL}. Book it`,
        (name, args) => {
          if (name === "calendar_find_slots") return FIND_SLOTS_OK;
          if (name === "calendar_book_appointment") {
            return {
              ok: true,
              eventId: "e2e-evt-liz",
              inviteEmail: args.attendeeEmail ?? null,
              videoJoinUrl: "https://zoom.example.com/j/93412345678",
              videoProvider: "zoom",
              startLocal: "Monday, July 27, 2026 at 9:00 AM MST"
            };
          }
          return { ok: false, message: `unexpected tool: ${name}` };
        }
      );

      const books = out.calls.filter((c) => c.name === "calendar_book_appointment");
      if (books.length !== 1) {
        console.error("live reply:", out.finalText);
      }
      expect(books.length, `calls: ${JSON.stringify(out.calls)}`).toBe(1);
      const book = books[0];

      // 12:00 PM EDT on Mon Jul 27 2026 is 16:00Z: the slot the owner relayed.
      expect(new Date(String(book.args.startIso)).toISOString()).toBe(SLOTS[0].startIso);

      // The attendee is LIZ. Booking Beth would send the invite (and the
      // Zoom link) to the assistant instead of the person attending.
      expect(String(book.args.attendeeEmail).toLowerCase()).toBe(LIZ_EMAIL);
      expect(String(book.args.attendeeName)).toMatch(/liz/i);
      expect(String(book.args.attendeeName)).not.toMatch(/beth/i);
      expect(digits(book.args.attendeePhone)).not.toBe(digits(OWNER_E164));

      expect(out.finalText.trim().length).toBeGreaterThan(0);
    }
  );
});
