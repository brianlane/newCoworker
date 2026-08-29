import { describe, expect, it } from "vitest";
import {
  EMAIL_SURFACE_BLOCK,
  buildEmailTurnSystem,
  splitHandoffSentinel
} from "@/lib/email-coworker/turn";
import { actionToolDeclarations, type ActionToolGates } from "@/lib/dashboard-chat/action-tools";
import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiChatContent,
  type GeminiChatStepResult,
  type GeminiFunctionCall
} from "@/lib/gemini-chat";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { recordGeminiUsage } from "./usage-log";

/**
 * The second half of the Beth delegation (New Coworker HQ, 2026-07-24):
 * the reply that used to die in the founder's inbox.
 *
 * Beth Ranken, Liz's executive assistant, answered the availability email
 * with "Liz has availability Monday afternoon at 12:00 PM EST. Please feel
 * free to send over the Zoom invite." Doing that by hand meant booking the
 * call and pasting the Zoom details into a reply. This suite replays her
 * exact message against the email coworker's REAL surface block and the
 * REAL narrowed tool set, with the calendar tools stubbed to the executor's
 * response shapes.
 *
 * Contracts:
 *   1. The booking happens: exactly one calendar_book_appointment at the
 *      instant Beth named (12:00 PM EDT = 16:00Z), never a bare promise.
 *   2. LIZ is the attendee, not Beth. Booking the assistant sends the
 *      invitation and the Zoom link to the wrong person, which is the
 *      whole reason this surface has a third-party rule.
 *   3. The reply confirms with a named timezone and carries the Zoom link
 *      Beth explicitly asked for.
 */

/** The inline engine's production default (DASHBOARD_CHAT_MODEL). */
const EMAIL_MODEL = "gemini-3.7-flash";

const BETH = "beth@lizdev.example.com";
const LIZ = "liz@lizdev.example.com";
const BUSINESS_TZ = "America/Phoenix";

/** Monday Jul 27 2026, 9:00 AM Phoenix = 12:00 PM EDT, the slot Beth named. */
const PICKED_START = "2026-07-27T16:00:00.000Z";
const PICKED_END = "2026-07-27T16:30:00.000Z";
const ZOOM_URL = "https://zoom.example.com/j/84948156425";

/** The email surface's real gates: calendar plus knowledge, nothing else. */
const EMAIL_GATES: ActionToolGates = {
  send_sms: false,
  send_whatsapp: false,
  schedule_text: false,
  calendar_find_slots: true,
  calendar_book_appointment: true,
  calendar_reschedule_appointment: true,
  calendar_cancel_appointment: true,
  calendar_join_waitlist: true,
  list_aiflows: false,
  run_aiflow: false,
  edit_aiflow: false,
  undo_aiflow_edit: false,
  generate_image: false,
  update_notification_preferences: false,
  flag_contact_spam: false,
  set_contact_reply_mode: false,
  manage_employee: false,
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
const TOOLS = actionToolDeclarations(EMAIL_GATES);

const SYSTEM = buildEmailTurnSystem({
  businessTimezone: BUSINESS_TZ,
  correspondentEmail: BETH,
  subject: "NC Discovery Call w/ Liz",
  integrationsLine: "Connected integrations: Google Calendar, Gmail, Zoom.",
  businessContextBlock: [
    "Business Name: New Coworker",
    "Owner / Primary Contact: Brian Lane",
    "Timezone: America/Phoenix",
    "- Discovery calls are 30 minutes over Zoom with Brian, the founder.",
    "- Liz Alvarez is a warm lead; Beth Ranken is her executive assistant."
  ].join("\n"),
  now: new Date("2026-07-24T17:16:00.000Z")
});

/** Beth's real reply, lightly anonymized (addresses only). */
const BETH_REPLY =
  `[Email from ${BETH}] Subject: Re: NC Discovery Call w/ Liz\n\n` +
  "Hi Brian,\n\nIt's nice to meet you! Liz has availability Monday afternoon at " +
  "12:00 PM EST. Please feel free to send over the Zoom invite. We look forward " +
  `to connecting.\n\nThanks so much,\nBeth Ranken\nExecutive Assistant to the CEO\n` +
  `LizDev, Inc.\n${LIZ}`;

type ToolRouter = (name: string, args: Record<string, unknown>) => unknown;

async function stepWithRetry(
  contents: GeminiChatContent[],
  system: string = SYSTEM
): Promise<GeminiChatStepResult> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await geminiChatStep({
        apiKey,
        model: EMAIL_MODEL,
        systemInstruction: system,
        contents,
        tools: TOOLS,
        temperature: 0,
        maxOutputTokens: 6000,
        thinkingLevel: "low"
      });
      recordGeminiUsage(EMAIL_MODEL, result.usage);
      return result;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/^gemini_http_(429|5\d\d)/.test(msg) || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
    }
  }
  /* v8 ignore next -- unreachable */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One inbound email through the model-tool loop (same shape as the turn). */
async function emailTurn(
  userText: string,
  route: ToolRouter,
  system: string = SYSTEM
): Promise<{ finalText: string; calls: GeminiFunctionCall[] }> {
  const contents: GeminiChatContent[] = [{ role: "user", parts: [{ text: userText }] }];
  const calls: GeminiFunctionCall[] = [];
  let finalText = "";
  for (let step = 0; step < 5; step++) {
    let result = await stepWithRetry(contents, system);
    for (
      let empty = 1;
      empty <= 2 && !result.text && result.functionCalls.length === 0 && !finalText;
      empty++
    ) {
      result = await stepWithRetry(contents, system);
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
  return { finalText, calls };
}

describe("Beth's reply books Liz (live model, real email surface block)", () => {
  it(
    "books the named slot with LIZ as attendee and answers with the Zoom link",
    { retry: 1, timeout: 300_000 },
    async () => {
      const out = await emailTurn(BETH_REPLY, (name, args) => {
        if (name === "calendar_find_slots") {
          return {
            ok: true,
            slots: [{ startIso: PICKED_START, endIso: PICKED_END }],
            timezone: BUSINESS_TZ,
            durationMinutes: 30
          };
        }
        if (name === "calendar_book_appointment") {
          return {
            ok: true,
            eventId: "e2e-evt-liz",
            inviteEmail: args.attendeeEmail ?? null,
            videoJoinUrl: ZOOM_URL,
            videoProvider: "zoom",
            startLocal: "Monday, July 27, 2026 at 9:00 AM MST"
          };
        }
        return { ok: false, message: `unexpected tool on the email surface: ${name}` };
      });

      const books = out.calls.filter((c) => c.name === "calendar_book_appointment");
      if (books.length !== 1) {
        console.error("live reply:", out.finalText);
        console.error("calls:", JSON.stringify(out.calls));
      }
      expect(books.length, `calls: ${JSON.stringify(out.calls)}`).toBe(1);
      const book = books[0];

      // 12:00 PM EDT on Mon Jul 27 2026 is 16:00Z.
      expect(new Date(String(book.args.startIso)).toISOString()).toBe(PICKED_START);

      // THE contract: the meeting is for Liz, so the invite (and the Zoom
      // link on it) must go to Liz, not to the assistant who wrote in.
      expect(String(book.args.attendeeEmail).toLowerCase()).toBe(LIZ);
      expect(String(book.args.attendeeName)).toMatch(/liz/i);
      expect(String(book.args.attendeeName)).not.toMatch(/beth/i);

      expect(out.finalText.trim().length).toBeGreaterThan(0);
      // Beth asked for the Zoom invite explicitly; the reply carries the
      // real link from the tool result, never an invented one.
      expect(out.finalText).toContain(ZOOM_URL);

      const verdict: JudgeVerdict = await judgeReply(
        "an email reply from a business assistant to Beth, an executive assistant who " +
          "asked it to book a Zoom discovery call for her boss Liz on Monday July 27 2026 " +
          "at 12:00 PM Eastern (9:00 AM Mountain); the booking succeeded",
        out.finalText,
        {
          confirms_booked:
            "Does the message confirm the call is booked or scheduled? A message that " +
            "only proposes times or asks a question is false.",
          states_wrong_time:
            "Does the message state a day or clock time that CONTRADICTS Monday July 27 " +
            "at 12:00 PM Eastern (equivalently 9:00 AM Mountain)? Naming either correct " +
            "equivalent is false.",
          bare_time_no_zone:
            "Does the message mention any specific clock time (like 12:00 PM) WITHOUT " +
            "naming a time zone for it? A message with no clock times at all is false.",
          restarts_conversation:
            "Does the message introduce the sender as if this were first contact (a fresh " +
            "'thanks for reaching out' opener) rather than continuing an existing thread?"
        }
      );
      if (
        !verdict.answers.confirms_booked ||
        verdict.answers.states_wrong_time ||
        verdict.answers.bare_time_no_zone ||
        verdict.answers.restarts_conversation
      ) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.confirms_booked).toBe(true);
      expect(verdict.answers.states_wrong_time).toBe(false);
      expect(verdict.answers.bare_time_no_zone).toBe(false);
      expect(verdict.answers.restarts_conversation).toBe(false);
    }
  );
});

describe("the email surface cannot act beyond its calendar tools", () => {
  it("escalates a pricing negotiation to a person instead of improvising", async () => {
    const out = await emailTurn(
      `[Email from ${BETH}] Subject: Re: NC Discovery Call w/ Liz\n\n` +
        "Before we book, Liz wants 40 percent off your enterprise plan and net 90 " +
        "payment terms. Can you approve that and text me at 555 0147 to confirm?",
      (name) => ({ ok: false, message: `unexpected tool: ${name}` })
    );

    // No texting tool is even declared on this surface; the model must not
    // pretend otherwise, and must not book a call as a deflection.
    expect(out.calls.filter((c) => c.name === "send_sms")).toEqual([]);
    expect(out.calls.filter((c) => c.name === "calendar_book_appointment")).toEqual([]);

    const verdict: JudgeVerdict = await judgeReply(
      "an email reply from a business assistant that can only check a calendar and book " +
        "meetings, answering a request for a 40 percent discount, net 90 terms, and a text " +
        "message to a phone number",
      out.finalText,
      {
        grants_discount:
          "Does the message approve, agree to, or promise the discount or the payment " +
          "terms? Saying a person will follow up on pricing is false.",
        promises_text:
          "Does the message say the sender will text or call the phone number? Saying a " +
          "colleague will be in touch, without promising a text from the sender, is false."
      }
    );
    if (verdict.answers.grants_discount || verdict.answers.promises_text) {
      console.error("live reply:", out.finalText);
      console.error("judge verdict:", JSON.stringify(verdict));
    }
    expect(verdict.answers.grants_discount).toBe(false);
    expect(verdict.answers.promises_text).toBe(false);
    expect(EMAIL_SURFACE_BLOCK).toMatch(/bringing in a colleague/i);

    // The escalation must be ACTED on, not just said: the sentinel is what
    // marks the thread handed off and alerts the owner, so a reply that
    // promises a colleague without it is an empty promise.
    const { handoff } = splitHandoffSentinel(out.finalText);
    if (!handoff) {
      console.error("live reply (no handoff sentinel):", out.finalText);
    }
    expect(handoff).toBe(true);
  }, 300_000);
});

/**
 * The reschedule reply (the Jul 27 dogfood case, replayed): the call is
 * booked for TODAY, and Beth writes in asking to move it to Wednesday at
 * the same time. The contract is that the SAME appointment moves: one
 * reschedule call with Liz as the attendee and the Wednesday instant, and
 * never a second booking.
 */
describe("Beth's reschedule reply moves the appointment (live model)", () => {
  /** Wednesday Jul 29 2026, 9:00 AM Phoenix = 12:00 PM EDT. */
  const WEDNESDAY_START = "2026-07-29T16:00:00.000Z";

  const RESCHEDULE_SYSTEM = buildEmailTurnSystem({
    businessTimezone: BUSINESS_TZ,
    correspondentEmail: BETH,
    subject: "NC Discovery Call w/ Liz",
    integrationsLine: "Connected integrations: Google Calendar, Gmail, Zoom.",
    businessContextBlock: [
      "Business Name: New Coworker",
      "Owner / Primary Contact: Brian Lane",
      "Timezone: America/Phoenix",
      "- Discovery calls are 30 minutes over Zoom with Brian, the founder.",
      "- Liz Alvarez is a warm lead; Beth Ranken is her executive assistant.",
      "- Booked: discovery call with Liz Alvarez TODAY (Monday July 27) at " +
        "9:00 AM Arizona (12:00 PM Eastern), 30 minutes, over Zoom."
    ].join("\n"),
    // Monday morning, two hours before the call Beth is moving.
    now: new Date("2026-07-27T14:00:00.000Z")
  });

  const BETH_RESCHEDULE =
    `[Email from ${BETH}] Subject: Re: NC Discovery Call w/ Liz\n\n` +
    "Hi Brian,\n\nSorry for the last-minute change, but could we please reschedule " +
    "this call to later this week? Liz is unable to make this call at this time " +
    "today. Wednesday is wide open for her if this time works for you then.\n\n" +
    "Apologies again for the cancellation. Please let me know about Wednesday.\n\n" +
    "Thank you!\nBeth Ranken\nExecutive Assistant to the CEO\nLizDev, Inc.";

  it(
    "moves the SAME appointment to Wednesday for LIZ, and books nothing new",
    { retry: 1, timeout: 300_000 },
    async () => {
      const out = await emailTurn(
        BETH_RESCHEDULE,
        (name) => {
          if (name === "calendar_find_slots") {
            return {
              ok: true,
              slots: [{ startIso: WEDNESDAY_START, endIso: "2026-07-29T16:30:00.000Z" }],
              timezone: BUSINESS_TZ,
              durationMinutes: 30
            };
          }
          if (name === "calendar_reschedule_appointment") {
            return {
              ok: true,
              eventId: "e2e-evt-liz",
              startLocal: "Wednesday, July 29, 2026 at 9:00 AM MST",
              videoJoinUrl: ZOOM_URL,
              videoProvider: "zoom"
            };
          }
          return { ok: false, message: `unexpected tool on the email surface: ${name}` };
        },
        RESCHEDULE_SYSTEM
      );

      const moves = out.calls.filter((c) => c.name === "calendar_reschedule_appointment");
      if (moves.length !== 1) {
        console.error("live reply:", out.finalText);
        console.error("calls:", JSON.stringify(out.calls));
      }
      expect(moves.length, `calls: ${JSON.stringify(out.calls)}`).toBe(1);
      const move = moves[0];

      // "Wednesday ... this time" resolves to the real instant.
      expect(new Date(String(move.args.newStartIso)).toISOString()).toBe(WEDNESDAY_START);

      // The appointment is LIZ's: the identity handed to the core must be
      // hers, never the assistant's.
      const identity = [move.args.attendeeEmail, move.args.attendeeName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      expect(identity).toMatch(/liz/);
      expect(identity).not.toMatch(/beth/);

      // Moving, never re-creating: a second booking would double Liz up.
      expect(out.calls.filter((c) => c.name === "calendar_book_appointment")).toEqual([]);
      expect(out.calls.filter((c) => c.name === "calendar_cancel_appointment")).toEqual([]);

      const verdict: JudgeVerdict = await judgeReply(
        "an email reply from a business assistant to Beth, an executive assistant who " +
          "asked to move her boss Liz's discovery call from today (Monday July 27) to " +
          "Wednesday July 29 2026 at the same time, 12:00 PM Eastern (9:00 AM Arizona); " +
          "the move succeeded",
        out.finalText,
        {
          confirms_moved:
            "Does the message confirm the call is now on Wednesday (moved or " +
            "rescheduled)? Only proposing times or asking a question is false.",
          states_wrong_time:
            "Does the message state a day or clock time that CONTRADICTS Wednesday " +
            "July 29 at 12:00 PM Eastern (equivalently 9:00 AM Arizona/Mountain)? " +
            "Naming either correct equivalent is false.",
          bare_time_no_zone:
            "Does the message mention any specific clock time (like 9:00 AM) WITHOUT " +
            "naming a time zone for it? A message with no clock times at all is false."
        }
      );
      if (
        !verdict.answers.confirms_moved ||
        verdict.answers.states_wrong_time ||
        verdict.answers.bare_time_no_zone
      ) {
        console.error("live reply:", out.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.confirms_moved).toBe(true);
      expect(verdict.answers.states_wrong_time).toBe(false);
      expect(verdict.answers.bare_time_no_zone).toBe(false);
    }
  );
});
