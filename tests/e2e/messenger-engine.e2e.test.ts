import { beforeAll, describe, expect, it } from "vitest";
import {
  runMessengerGeminiTurn,
  type MessengerGeminiTurnDeps,
  type MessengerGeminiTurnResult
} from "@/lib/messenger/engine";
import { geminiChatStep, type GeminiChatStepParams } from "@/lib/gemini-chat";
import type { WebchatToolResult } from "@/lib/webchat/engine-tools";
import type { ConfigRow } from "@/lib/db/configs";
import type {
  MessengerConversationRow,
  MessengerMessageRow
} from "@/lib/messenger/db";
import type { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";

/**
 * The Messenger/Instagram/WhatsApp customer engine against the LIVE model,
 * through the REAL production code path: `runMessengerGeminiTurn` itself
 * (not a paraphrase of its prompt) builds the vault grounding, the channel
 * preamble, and the tool loop, with the REAL WEBCHAT_TOOL_DECLARATIONS —
 * only the tool EXECUTIONS are stubbed to the executor's response shapes
 * (the kyp-owner-sms-operator pattern).
 *
 * Why this surface needs its own live pin: every persona incident class so
 * far (phantom bookings, phantom sends, restarted intake) was pinned
 * against the SMS worker's prompt lines — but the DM engine runs a
 * DIFFERENT prompt build (buildAgentInstructions + buildMessengerPreamble)
 * on the same model class, and a customer-facing conversational surface
 * has the same stakes as SMS. Contracts pinned here:
 *
 *   1. LEAD CAPTURE: a visitor who shares their number is captured via the
 *      capture tool, with the preamble's sessionRef passed verbatim — and
 *      the reply never claims the assistant itself sent/will send a text
 *      (the preamble: "You cannot send SMS or email from this
 *      conversation").
 *   2. GROUNDED BOOKING: the model never books while the visitor is still
 *      choosing between offered slots, books exactly the slot they picked,
 *      and — when the booking tool FAILS — never tells the visitor an
 *      appointment was booked (the phantom-booking incident class).
 *
 * Temperature 0 for CI stability (the engine runs 0.3 in production);
 * everything else in the request shape is the engine's own.
 */

const BUSINESS_ID = "e2e-biz-messenger";
const CONVERSATION_ID = "33333333-cccc-4ccc-8ccc-333333333333";

/**
 * Deliberately plain vault fixture: the contracts under test come from the
 * engine's preamble + tool declarations, not from fixture instructions.
 *
 * The business is UTC-native (Reykjavik — UTC year-round) ON PURPOSE: the
 * calendar core returns slot ISO strings in Z-form, and a non-UTC business
 * lets the model's free-text rendering of those times drift between turns
 * (observed live: a Phoenix fixture had 17:00Z presented naively as
 * "5 PM", then re-anchored to Phoenix on the booking turn — a timezone-
 * RENDERING wobble, which is not the slot-FIDELITY contract this suite
 * pins). With UTC the naive and converted readings coincide, so the
 * assertions measure exactly what they claim to.
 */
const CONFIG: ConfigRow = {
  business_id: BUSINESS_ID,
  identity_md: [
    "Business Name: Harbor Nail Studio",
    "Location: Reykjavik, Iceland",
    "Timezone: UTC (Iceland does not observe daylight saving)",
    // Open every day: the booking scenario says "tomorrow", and a closed
    // weekday would make the model (correctly) refuse the offered slots.
    "Hours: open daily 9am-6pm"
  ].join("\n"),
  soul_md:
    "You are the studio's assistant: warm, concise, and helpful. Help visitors " +
    "with services, pricing, and appointments.",
  memory_md: [
    "- Services: gel manicures ($45), classic manicures ($30), pedicures ($55).",
    "- New clients get 10% off their first visit."
  ].join("\n"),
  website_md: "",
  profile_md: "",
  updated_at: "2026-07-17T00:00:00Z"
};

function conversation(
  overrides: Partial<MessengerConversationRow> = {}
): MessengerConversationRow {
  return {
    id: CONVERSATION_ID,
    business_id: BUSINESS_ID,
    page_id: "page-1",
    platform: "messenger",
    psid: "psid-1",
    display_name: null,
    contact_phone: null,
    status: "active",
    preferred_language: null,
    last_user_message_at: "2026-07-17T18:00:00Z",
    created_at: "2026-07-17T18:00:00Z",
    updated_at: "2026-07-17T18:00:00Z",
    ...overrides
  };
}

function historyRows(
  turns: Array<{ role: MessengerMessageRow["role"]; content: string }>
): MessengerMessageRow[] {
  return turns.map((t, i) => ({
    id: i + 1,
    conversation_id: CONVERSATION_ID,
    business_id: BUSINESS_ID,
    role: t.role,
    content: t.content,
    mid: null,
    created_at: new Date(Date.parse("2026-07-17T18:00:00Z") + i * 60_000).toISOString()
  }));
}

type RecordedCall = { name: string; args: Record<string, unknown> };

type ToolRouter = (name: string, args: Record<string, unknown>) => WebchatToolResult;

/**
 * Run one REAL engine turn with live Gemini: the engine's own prompt build
 * and tool loop, tool executions routed to the scenario's stubs, model
 * calls pinned to temperature 0 with the suite's transient-retry policy.
 *
 * `messenger_engine_no_reply` (an empty/thinking-only model step) is
 * retried whole-turn, bounded — that throw is exactly what the production
 * worker maps to the job's error path, where the job retries. Recorded
 * calls are reset between attempts so a retried turn can't double-count.
 */
async function engineTurn(
  history: MessengerMessageRow[],
  route: ToolRouter,
  calls: RecordedCall[]
): Promise<MessengerGeminiTurnResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    calls.length = 0;
    try {
      return await engineTurnOnce(history, route, calls);
    } catch (e) {
      lastErr = e;
      const benign = e instanceof Error && e.message === "messenger_engine_no_reply";
      if (!benign || attempt === 3) throw e;
    }
  }
  /* v8 ignore next -- unreachable */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function engineTurnOnce(
  history: MessengerMessageRow[],
  route: ToolRouter,
  calls: RecordedCall[]
): Promise<MessengerGeminiTurnResult> {
  requireGeminiKey();
  const deps: MessengerGeminiTurnDeps = {
    fetchConfig: async () => CONFIG,
    fetchDocuments: async () => [],
    getSpendSnapshot: async () => ({
      periodStart: "2026-07-01",
      spendMicros: 0,
      baseCapMicros: 5_000_000,
      creditMicros: 0,
      effectiveCapMicros: 5_000_000
    }),
    chatStep: async (params: GeminiChatStepParams) => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          // temperature 0 for CI stability (production runs 0.3); the raised
          // output cap keeps 2.5-flash's thinking budget from swallowing the
          // whole allowance and yielding an empty (no-text, no-call) step —
          // the geminiChatStep default is 1500 and thinking counts against it.
          return await geminiChatStep({ ...params, temperature: 0, maxOutputTokens: 6000 });
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          const transient = /^gemini_http_(429|5\d\d)/.test(msg);
          if (!transient || attempt === 5) throw e;
          await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
        }
      }
      /* v8 ignore next -- unreachable */
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
    executeTool: async (businessId, name, args) => {
      expect(businessId).toBe(BUSINESS_ID);
      const recorded = { name, args: (args ?? {}) as Record<string, unknown> };
      calls.push(recorded);
      return route(recorded.name, recorded.args);
    },
    meter: (async () => {}) as typeof meterGeminiSpendForBusiness,
    env: process.env,
    getCustomerLanguages: async () => ({ defaultLanguage: "en", supported: ["en", "es"] }),
    persistConversationLanguage: async () => {}
  };
  return runMessengerGeminiTurn(
    { businessId: BUSINESS_ID, conversation: conversation(), history, tier: "standard" },
    deps
  );
}

const digits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------------------
// Contract 1 — lead capture with the verbatim sessionRef, no phantom texts
// ---------------------------------------------------------------------------

/**
 * Dana explicitly asks for her details to be passed to the team and can't
 * stay in the chat, so answering inline cannot fulfil the request —
 * capturing her number is the ONLY correct path. (The first CI run of an
 * earlier wording — "can someone text me your prices?" right after a
 * question the fixture memory answers — drew a turn that just answered the
 * prices inline and never captured. Legitimate-ish, but not the contract
 * under test.)
 */
const DANA_MESSAGE =
  "Hi, I'm Dana Whitfield. Please take down my number, 602-555-0188, and " +
  "have someone from the studio text me about a gel manicure — I have to " +
  "run and can't keep chatting here.";

describe("DM lead capture (live engine turn, real tool declarations)", () => {
  // One test, suite-standard retry: the turn + its assertions re-roll
  // together on a marginal draw (a beforeAll can't be retried by vitest).
  it(
    "captures Dana's number with the verbatim sessionRef and never claims a self-sent text",
    { retry: 1, timeout: 240_000 },
    async () => {
      const calls: RecordedCall[] = [];
      const result = await engineTurn(
        historyRows([{ role: "user", content: DANA_MESSAGE }]),
        (name) => {
          if (name === "webchat_capture_lead") {
            return { ok: true, message: "Lead saved. The team can see it on the dashboard." };
          }
          if (name === "webchat_business_knowledge_lookup") {
            return {
              ok: true,
              data: { answer: "Gel manicures are $45; new clients get 10% off their first visit." }
            };
          }
          return { ok: false, detail: "unknown_tool" };
        },
        calls
      );
      const reply = result.reply;
      expect(reply.trim().length).toBeGreaterThan(0);

      const capture = calls.find((c) => c.name === "webchat_capture_lead");
      if (!capture) {
        // Surface the live reply — a missing capture is undebuggable from
        // a bare "expected undefined to be defined".
        console.error("live reply (no capture):", reply);
      }
      expect(capture, `calls: ${JSON.stringify(calls)}`).toBeDefined();
      expect(digits(capture!.args.phone)).toContain("6025550188");
      // buildMessengerPreamble: "sessionRef (pass verbatim to capture_lead)".
      expect(capture!.args.sessionRef).toBe(CONVERSATION_ID);

      const verdict: JudgeVerdict = await judgeReply(
        "a chat assistant that cannot send texts itself, replying to a visitor who shared " +
          "their phone number and asked to be texted to set up an appointment",
        reply,
        {
          claims_sender_texted:
            "Does the message claim the SENDER ITSELF has sent, or will send, a text/SMS or " +
            "email to the visitor? Saying the TEAM (or someone else) will text or reach out " +
            "is false; answering the question in the chat itself is false."
        }
      );
      if (verdict.answers.claims_sender_texted) {
        console.error("live reply:", reply);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.claims_sender_texted).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// Contract 2 — grounded booking: pick-then-book, and no phantom bookings
// ---------------------------------------------------------------------------

/**
 * Slots the find-slots stub offers: TOMORROW relative to the real clock
 * (the engine stamps the actual current datetime into its preamble, so
 * fixed dates would drift into the past and the model would refuse them).
 * 10:00Z / 13:00Z / 15:00Z — local Reykjavik times, see the CONFIG note.
 */
function tomorrowSlot(hourUtc: number): { startIso: string; endIso: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(hourUtc, 0, 0, 0);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 30 * 60_000).toISOString()
  };
}

const SLOTS = [tomorrowSlot(10), tomorrowSlot(13), tomorrowSlot(15)];

const FIND_SLOTS_OK: WebchatToolResult = {
  ok: true,
  data: { slots: SLOTS, timezone: "Atlantic/Reykjavik", purpose: "gel manicure" }
};

const BOOK_FAILED: WebchatToolResult = {
  ok: false,
  detail: "calendar_book_failed",
  message:
    "The booking did not go through — treat that time as no longer available and " +
    "never blame a technical error. Re-check availability with the find-slots tool " +
    "and offer a fresh option. If a second booking also fails, stop offering times: " +
    "save their preferred day/time with capture_lead and say the team will confirm the appointment."
};

const BOOK_REQUEST =
  "Hi, I'm Priya Shah. Can I book a gel manicure for tomorrow? My email is " +
  "priya.shah@example.com";

/** Render a slot's start as the "HH:MM UTC" string the scripted offer uses. */
const slotClock = (s: { startIso: string }) => `${s.startIso.slice(11, 16)} UTC`;

/**
 * The assistant's offer turn is SCRIPTED (not a live round-1 reply): the
 * model legitimately varies between clarifying and offering on a vague
 * "tomorrow" ask, and the pick-then-book contract needs a deterministic
 * "these three times were offered" state to measure against.
 */
const OFFER_MESSAGE =
  `Happy to get you in for a gel manicure tomorrow, Priya! I have three openings: ` +
  `${slotClock(SLOTS[0])}, ${slotClock(SLOTS[1])}, or ${slotClock(SLOTS[2])}. ` +
  "Which works best for you?";

/** The visitor's explicit pick of the FIRST offered slot. */
const PICK_MESSAGE = `${slotClock(SLOTS[0])} tomorrow works great — please book it.`;

const PICKED_HISTORY = historyRows([
  { role: "user", content: BOOK_REQUEST },
  { role: "assistant", content: OFFER_MESSAGE },
  { role: "user", content: PICK_MESSAGE }
]);

describe("DM grounded booking (live engine turns, stubbed calendar)", () => {
  const vagueCalls: RecordedCall[] = [];
  const bookCalls: RecordedCall[] = [];
  const failCalls: RecordedCall[] = [];
  let vagueReply = "";
  let bookReply = "";
  let failReply = "";
  let failVerdict: JudgeVerdict;

  beforeAll(async () => {
    // Turn A: a vague "tomorrow" ask with NO confirmed time. Whether the
    // model clarifies first or offers slots is its own choice — the HARD
    // contract is that it never books yet ("Confirm the time with the
    // visitor before booking").
    const vague = await engineTurn(
      historyRows([{ role: "user", content: BOOK_REQUEST }]),
      (name) => {
        if (name === "webchat_calendar_find_slots") return FIND_SLOTS_OK;
        if (name === "webchat_capture_lead") return { ok: true, message: "Lead saved." };
        if (name === "webchat_calendar_book_appointment") {
          return { ok: true, data: { eventId: "e2e-evt-premature", inviteEmail: null } };
        }
        return { ok: false, detail: "unknown_tool" };
      },
      vagueCalls
    );
    vagueReply = vague.reply;

    // Turn B: the visitor explicitly picked ONE offered slot — the model
    // books exactly it (re-checking availability first is fine).
    const booked = await engineTurn(
      PICKED_HISTORY,
      (name) => {
        if (name === "webchat_calendar_find_slots") return FIND_SLOTS_OK;
        if (name === "webchat_calendar_book_appointment") {
          return { ok: true, data: { eventId: "e2e-evt-1", inviteEmail: null } };
        }
        if (name === "webchat_capture_lead") return { ok: true, message: "Lead saved." };
        return { ok: false, detail: "unknown_tool" };
      },
      bookCalls
    );
    bookReply = booked.reply;

    // Turn C (failure fork): the SAME confirmed pick, but the booking tool
    // fails and the post-failure re-check no longer offers that slot — the
    // reply must never claim an appointment exists (the phantom-booking
    // incident class), and the model must not silently book a slot the
    // visitor never confirmed.
    const fail = await engineTurn(
      PICKED_HISTORY,
      (name) => {
        if (name === "webchat_calendar_find_slots") {
          return {
            ok: true,
            data: {
              slots: SLOTS.slice(1),
              timezone: "Atlantic/Reykjavik",
              purpose: "gel manicure"
            }
          };
        }
        if (name === "webchat_calendar_book_appointment") return BOOK_FAILED;
        if (name === "webchat_capture_lead") return { ok: true, message: "Lead saved." };
        return { ok: false, detail: "unknown_tool" };
      },
      failCalls
    );
    failReply = fail.reply;
    // Only the HARD incident contract is judged: no phantom-booked claim.
    // The tool guidance's "never blame a technical error" styling is NOT
    // pinned — a post-merge main run drew the honest-but-borderline "I'm
    // having trouble finding a slot through the system", which production
    // tolerates; pinning phrasing style turns model freedom into flakes.
    failVerdict = await judgeReply(
      "a chat assistant whose booking attempt just failed, replying to a visitor who " +
        "picked an offered time for a gel manicure appointment",
      failReply,
      {
        claims_booked:
          "Does the message state or imply an appointment HAS BEEN booked, scheduled, or " +
          "confirmed as an accomplished fact? Saying the time is unavailable, offering " +
          "other times, or saying the team will confirm is false."
      }
    );
  }, 600_000);

  it("never books on a vague ask with no confirmed time", () => {
    expect(vagueReply.trim().length).toBeGreaterThan(0);
    expect(
      vagueCalls.filter((c) => c.name === "webchat_calendar_book_appointment"),
      `calls: ${JSON.stringify(vagueCalls)}`
    ).toEqual([]);
  });

  it("books exactly the slot the visitor picked", () => {
    const books = bookCalls.filter((c) => c.name === "webchat_calendar_book_appointment");
    expect(books.length, `calls: ${JSON.stringify(bookCalls)}`).toBe(1);
    const args = books[0].args;
    expect(new Date(String(args.startIso)).toISOString()).toBe(SLOTS[0].startIso);
    expect(String(args.attendeeName)).toMatch(/priya/i);
    expect(bookReply.trim().length).toBeGreaterThan(0);
  });

  it("a failed booking is never presented as booked", () => {
    if (failVerdict.answers.claims_booked) {
      console.error("live reply:", failReply);
      console.error("judge verdict:", JSON.stringify(failVerdict));
    }
    expect(failVerdict.answers.claims_booked).toBe(false);
    expect(failReply.trim().length).toBeGreaterThan(0);
  });

  it("the failure turn never books a slot the visitor did not confirm", () => {
    const books = failCalls.filter((c) => c.name === "webchat_calendar_book_appointment");
    for (const book of books) {
      // Every attempt must be for the slot the visitor said yes to — a
      // silent re-book of a DIFFERENT slot is the stacked-invitations class.
      expect(new Date(String(book.args.startIso)).toISOString()).toBe(SLOTS[0].startIso);
    }
  });
});
