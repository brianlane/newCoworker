import { describe, expect, it } from "vitest";
import {
  NO_EM_DASH_PROMPT_LINE,
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE,
  SMS_TIMEZONE_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import {
  formatContactTimeline,
  type ContactTimelineEvent
} from "../../supabase/functions/_shared/contact_context";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import { renderWorkflowSeed } from "../../debug/_workflow-seed";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { recordRawUsage, type RawUsageMetadata } from "./usage-log";

/**
 * The Liz replay (HQ discovery funnel, 2026-07-25): a warm lead answered a
 * same-day discovery-call bump with "How is next week? I am super booked
 * today but would love to hop on Monday", and the whole negotiation
 * (day pivot, timezone, email for the Zoom invite, the booking itself)
 * happened by hand over the founder's personal iMessage, off-platform.
 *
 * This suite pins that the texting coworker handles the SAME exchange when
 * it arrives on the business line: the sms-inbound-worker's REAL prompt
 * lines (imported from _shared/sms_prompt_lines.ts), the REAL fresh-thread
 * preamble builders, and the REAL Rowboat seed tool declarations (rendered
 * from vps/scripts/deploy-client.sh via debug/_workflow-seed.ts, the exact
 * JSON a fresh tenant provision declares), with tool executions stubbed to
 * the /api/rowboat/tool-call envelope shapes.
 *
 * Contracts:
 *   1. The Monday pivot is accepted mid-thread, no steering back to
 *      "today", no restarting the conversation, and NOTHING is booked or
 *      claimed booked while the lead is still choosing.
 *   2. Any specific time offered is grounded in a calendar_find_slots call
 *      and carries a named timezone (SMS_TIMEZONE_LINE, the KYP incident).
 *   3. When the lead picks a slot and gives an email, the booking tool is
 *      called EXACTLY once with that slot's ISO start and that email, so
 *      the calendar invite (with the Zoom link) is real.
 */

/** Fleet SMS chat model (deploy-client.sh SMS_CHAT_MODEL default since the
 * PR #809 migration, same pin as the KYP and Truly replays). */
const SMS_TOOLS_MODEL = "gemini-3.5-flash-lite";

const LEAD = "+14805550177";
/** The moment Liz's reply arrived: Sat Jul 25 2026, 8:57 AM Phoenix. */
const TURN_AT = new Date("2026-07-25T15:57:00.000Z");
/** HQ runs on America/Phoenix (no DST; formats as MST year-round). */
const BUSINESS_TZ = "America/Phoenix";

/** Next Monday's openings, the find-slots stub's offer: Jul 27 2026,
 * 9:00 AM / 11:00 AM / 1:00 PM Phoenix (UTC-7), 30 minutes each. */
const SLOTS = [
  { startIso: "2026-07-27T16:00:00.000Z", endIso: "2026-07-27T16:30:00.000Z" },
  { startIso: "2026-07-27T18:00:00.000Z", endIso: "2026-07-27T18:30:00.000Z" },
  { startIso: "2026-07-27T20:00:00.000Z", endIso: "2026-07-27T20:30:00.000Z" }
];

/** The booking core's startLocal stamp for the picked slot (the same
 * Intl options as formatBookingStartLocal in calendar-tools/handlers.ts,
 * inlined so the e2e file doesn't import the server dependency chain). */
const PICKED_START_LOCAL = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
}).format(new Date(SLOTS[0].startIso));

/**
 * The texting coworker's REAL tool declarations: the seed's `Coworker`
 * agent tool list, resolved against the seed's workflow tool objects.
 * Rendering the seed also re-proves the jq program parses (same guarantee
 * as tests/agent-tool-seed-parity.test.ts).
 */
const seed = renderWorkflowSeed();
const coworker = seed.agents.find((a) => a.name === "Coworker");
if (!coworker) throw new Error("seed has no Coworker agent");
const DECLARATIONS = seed.tools
  .filter((t) => coworker.tools.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

/** Representative per-tenant persona (the seed's $instructions arg is
 * tenant-built; the production-invariant strings under test are the
 * _shared prompt lines and the seed declarations). */
const PERSONA =
  "You are the assistant for New Coworker, which gives small businesses an " +
  "AI coworker that answers their calls and texts. You are texting with " +
  "leads who asked to learn more. Your goal is a booked 30-minute discovery " +
  "call with the founder, Brian. Discovery calls happen over Zoom.";

/** The worker's fresh-thread customer preamble, piece for piece
 * (sms-inbound-worker/index.ts, non-staff path, same assembly as the KYP
 * timezone replay, plus the persona that rides as agent instructions). */
function buildSystem(): string {
  const dateLine = currentDateTimeLine(TURN_AT, BUSINESS_TZ);
  const phoneLine =
    `Current texter phone: ${LEAD}. When calling customer tools ` +
    `(customer_lookup_by_phone, customer_set_display_name, ` +
    `customer_append_pinned_note), pass this exact value as the phone ` +
    `argument unless the texter explicitly refers to a different number.`;
  const memoryPreamble = buildCustomerPreambleForEdge({
    customer_e164: LEAD,
    display_name: "Liz Alvarez",
    summary_md: null,
    pinned_md: null,
    total_interaction_count: 3,
    last_channel: "sms",
    last_interaction_at: "2026-07-25T15:57:00.000Z"
  });
  const timeline: ContactTimelineEvent[] = [
    {
      at: "2026-07-23T17:02:00.000Z",
      channel: "sms_out",
      text:
        "Hi Liz, thanks for your interest in New Coworker! I'd love to show " +
        "you how an AI coworker could handle your calls and texts. Do you " +
        "have 30 minutes this week for a quick discovery call?"
    },
    {
      at: "2026-07-25T15:57:00.000Z",
      channel: "sms_out",
      text:
        "Hey Liz, just wanted to bump this. Hope you had a good week! I'm " +
        "free all day today, would you be against hopping on a discovery " +
        "sometime today?"
    }
  ];
  return (
    [
      PERSONA,
      `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${SMS_TIMEZONE_LINE}\n\n${NO_EM_DASH_PROMPT_LINE}\n\n${dateLine}\n\n${phoneLine}`,
      memoryPreamble,
      formatContactTimeline(timeline)
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n") +
    // Customer turns always carry the reasoning-trailer ask
    // (sms-inbound-worker line "customerPreamble += REASONING_..."); the
    // harness strips it with splitReplyReasoning like the worker does.
    REASONING_PROMPT_INSTRUCTION
  );
}

const SYSTEM = buildSystem();

type ToolResult = { ok: boolean; detail?: string; data?: unknown; message?: string };
type RecordedCall = { name: string; args: Record<string, unknown> };
type ToolRouter = (name: string, args: Record<string, unknown>) => ToolResult;
type Content = { role: "user" | "model"; parts: Array<Record<string, unknown>> };

/**
 * One generateContent step with the seed declarations attached, the REST
 * shape of the Rowboat turn's tool config, with the suite's transient-retry
 * policy (same harness shape as voice-tools.e2e.test.ts).
 */
async function smsStep(contents: Content[]): Promise<{
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  modelContent: Content | null;
}> {
  const key = requireGeminiKey();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${SMS_TOOLS_MODEL}` +
    `:generateContent?key=${encodeURIComponent(key)}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: DECLARATIONS }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1500,
            // Same posture as the voice-tools harness: "low" keeps some
            // reasoning for tool choice without letting hidden thinking
            // truncate the visible reply. Gated on the family: Gemini 2.5
            // rejects thinkingLevel.
            ...(/^gemini-3/i.test(SMS_TOOLS_MODEL)
              ? { thinkingConfig: { thinkingLevel: "low" } }
              : {})
          }
        })
      });
      const transient = res.status === 429 || res.status >= 500;
      if (!res.ok && transient && attempt < 5) {
        await res.text().catch(() => {});
        await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
        continue;
      }
      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
        usageMetadata?: RawUsageMetadata;
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(`gemini ${res.status}: ${body.error?.message ?? "unknown error"}`);
      }
      recordRawUsage(SMS_TOOLS_MODEL, body.usageMetadata);
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim();
      const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      for (const part of parts) {
        const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
        if (fc && typeof fc.name === "string") {
          functionCalls.push({
            name: fc.name,
            args:
              fc.args && typeof fc.args === "object" && !Array.isArray(fc.args)
                ? (fc.args as Record<string, unknown>)
                : {}
          });
        }
      }
      return {
        text,
        functionCalls,
        modelContent: parts.length > 0 ? { role: "model", parts } : null
      };
    } catch (e) {
      lastErr = e;
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
    }
  }
  /* v8 ignore next -- unreachable */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run one texter turn through the model↔tool loop, routing executions to
 * the scenario's stubs. */
async function smsTurn(
  prior: Content[],
  texterText: string,
  route: ToolRouter
): Promise<{ finalText: string; calls: RecordedCall[]; contents: Content[] }> {
  const contents: Content[] = [...prior, { role: "user", parts: [{ text: texterText }] }];
  const calls: RecordedCall[] = [];
  let finalText = "";
  for (let step = 0; step < 6; step++) {
    const result = await smsStep(contents);
    if (result.text) finalText = result.text;
    if (result.functionCalls.length === 0 || !result.modelContent) break;
    contents.push(result.modelContent);
    const responses = result.functionCalls.map((call) => {
      calls.push(call);
      return {
        functionResponse: { name: call.name, response: { result: route(call.name, call.args) } }
      };
    });
    contents.push({ role: "user", parts: responses });
  }
  // The worker strips the reasoning trailer before caching/sending
  // (splitReplyReasoning), so assertions and the judge see exactly what
  // the texter would. Trailer PRESENCE is pinned by the KYP replay; this
  // suite stays focused on the booking contracts.
  return { finalText: splitReplyReasoning(finalText).reply, calls, contents };
}

/** Stub results shaped like the /api/rowboat/tool-call envelopes. */
const FIND_SLOTS_OK: ToolResult = {
  ok: true,
  data: { slots: SLOTS, timezone: BUSINESS_TZ, purpose: "discovery call", durationMinutes: 30 }
};

function baseRouter(
  overrides: Record<string, (args: Record<string, unknown>) => ToolResult>
): ToolRouter {
  return (name, args) => {
    if (overrides[name]) return overrides[name](args);
    if (name === "customer_lookup_by_phone") {
      // Production lookupCustomerByPhone nests the profile under
      // data.customer (customer-tools/handlers.ts), keep the envelope
      // byte-shaped so tool-loop behavior matches live SMS.
      return {
        ok: true,
        data: {
          found: true,
          customer: {
            displayName: "Liz Alvarez",
            customerE164: LEAD,
            summary: null,
            lastChannel: "sms",
            lastInteractionAt: "2026-07-25T15:57:00.000Z",
            totalInteractionCount: 3
          }
        }
      };
    }
    if (name === "customer_set_display_name") return { ok: true, data: { saved: true } };
    if (name === "customer_append_pinned_note") return { ok: true, data: { saved: true } };
    if (name === "calendar_find_slots") return FIND_SLOTS_OK;
    if (name === "notify_team") return { ok: true, data: { notified: true } };
    return { ok: false, detail: "unknown_tool" };
  };
}

/** Liz's real reply, verbatim (two rapid messages, one worker turn). */
const MONDAY_PIVOT =
  "[SMS] Hi Brian! How is next week? I am super booked today but would " +
  "love to hop on Monday\n\nTY for texting again";

describe("Liz Monday pivot (live model, real seed declarations)", () => {
  // One retried test (the suite-standard de-flake shape): a marginal draw
  // anywhere in the turn re-rolls the whole exchange.
  it(
    "accepts the pivot, books nothing, grounds any offered time in find_slots with a named zone",
    { retry: 1, timeout: 480_000 },
    async () => {
      const pivot = await smsTurn(
        [],
        MONDAY_PIVOT,
        baseRouter({
          // A premature booking would "succeed", the assertion below is
          // that the model never calls it while the lead is still choosing.
          calendar_book_appointment: () => ({
            ok: true,
            data: { eventId: "e2e-evt-premature", inviteEmail: null }
          })
        })
      );

      expect(pivot.finalText.trim().length).toBeGreaterThan(0);
      expect(
        pivot.calls.filter((c) => c.name === "calendar_book_appointment"),
        `pivot-turn calls: ${JSON.stringify(pivot.calls)}`
      ).toEqual([]);

      const verdict: JudgeVerdict = await judgeReply(
        "a texting assistant whose business asked a lead about a discovery call " +
          "today; the lead just said today is fully booked but Monday works; the " +
          "assistant can check real calendar availability with a tool",
        pivot.finalText,
        {
          claims_booked:
            "Does the message state or imply an appointment HAS BEEN booked, " +
            "scheduled, or confirmed as an accomplished fact? Offering times, " +
            "asking which time works, or asking a clarifying question is false.",
          rejects_monday:
            "Does the message refuse Monday, steer the lead back to meeting " +
            "today, or ignore that the lead asked for Monday? Accepting Monday " +
            "and moving the scheduling forward is false.",
          bare_time_no_zone:
            "Does the message mention any specific clock time (like 9:00 AM) " +
            "WITHOUT naming a time zone for it? A message with no clock times " +
            "at all is false, and day names alone (Monday) are not clock times.",
          restarts_conversation:
            "Does the message greet or introduce the sender as if the " +
            "conversation were just starting (a fresh 'thanks for reaching out' " +
            "opener, introducing themselves by name), rather than continuing " +
            "mid-thread?"
        }
      );
      if (
        verdict.answers.claims_booked ||
        verdict.answers.rejects_monday ||
        verdict.answers.bare_time_no_zone ||
        verdict.answers.restarts_conversation
      ) {
        console.error("pivot reply:", pivot.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.claims_booked).toBe(false);
      expect(verdict.answers.rejects_monday).toBe(false);
      expect(verdict.answers.bare_time_no_zone).toBe(false);
      expect(verdict.answers.restarts_conversation).toBe(false);

      // Specific offered times must be grounded: a reply that quotes clock
      // times without having called find_slots is an invented-availability
      // reply (the class SMS_GROUNDED_ACTIONS_LINE exists for). Judged
      // lexically-free: the judge already decided whether clock times were
      // offered via bare_time_no_zone being applicable... so re-ask sharply.
      const offered = await judgeReply(
        "a texting assistant scheduling a discovery call",
        pivot.finalText,
        {
          offers_specific_times:
            "Does the message offer or propose one or more specific clock " +
            "times (like 9:00 AM or 2 PM) for the appointment? Asking what " +
            "time works, or day names alone, is false."
        }
      );
      if (offered.answers.offers_specific_times) {
        expect(
          pivot.calls.filter((c) => c.name === "calendar_find_slots").length,
          `reply offered times without a find_slots call: ${pivot.finalText}`
        ).toBeGreaterThan(0);
      }
    }
  );
});

describe("Liz pick + email turn (live model, real seed declarations)", () => {
  // Scripted offer turn pins which times were presented (same pattern as
  // the voice booking-failure suite), so this test is independent of the
  // pivot turn's draw.
  const PRIOR: Content[] = [
    { role: "user", parts: [{ text: MONDAY_PIVOT }] },
    {
      role: "model",
      parts: [
        {
          text:
            "Monday works great! For the 30-minute Zoom discovery call with " +
            "Brian I have 9:00 AM, 11:00 AM, or 1:00 PM Mountain Standard Time " +
            "open on Monday. Which works best for you?"
        }
      ]
    }
  ];

  it(
    "books exactly the picked slot with the given email, confirms with a timezone",
    { retry: 1, timeout: 480_000 },
    async () => {
      const pick = await smsTurn(
        PRIOR,
        "[SMS] Let's do Monday at 9am! My email is liz.alvarez@example.com " +
          "so you can send the Zoom invite",
        baseRouter({
          calendar_book_appointment: (args) => ({
            ok: true,
            data: {
              eventId: "e2e-evt-liz",
              htmlLink: "https://calendar.example.com/event?eid=e2e-evt-liz",
              provider: "google",
              calendar: "shared",
              inviteEmail:
                typeof args.attendeeEmail === "string" ? args.attendeeEmail : null,
              zoomMeetingId: "93412345678",
              videoJoinUrl: "https://zoom.example.com/j/93412345678",
              videoProvider: "zoom",
              startLocal: PICKED_START_LOCAL
            }
          })
        })
      );

      const books = pick.calls.filter((c) => c.name === "calendar_book_appointment");
      if (books.length !== 1) {
        console.error("pick-turn reply:", pick.finalText);
      }
      expect(books.length, `pick-turn calls: ${JSON.stringify(pick.calls)}`).toBe(1);
      expect(new Date(String(books[0].args.startIso)).toISOString()).toBe(SLOTS[0].startIso);
      expect(String(books[0].args.attendeeEmail)).toBe("liz.alvarez@example.com");
      expect(String(books[0].args.attendeeName)).toMatch(/liz/i);
      expect(pick.finalText.trim().length).toBeGreaterThan(0);

      const verdict: JudgeVerdict = await judgeReply(
        "a texting assistant that just successfully booked a Zoom discovery " +
          `call for Monday, July 27 at 9:00 AM Mountain time (MST); the booking ` +
          "included the customer's email, so a calendar invite with the Zoom " +
          "link IS going out",
        pick.finalText,
        {
          confirms_booked:
            "Does the message confirm the appointment is booked or scheduled? " +
            "A message that only asks another question or says someone will " +
            "follow up is false.",
          states_wrong_time:
            "Does the message state a day or clock time that CONTRADICTS " +
            "Monday, July 27 at 9:00 AM Mountain time (MST) (for example a " +
            "different day, a different hour, or calling it Eastern or " +
            "Pacific)? Naming the correct time, with or without extra detail, " +
            "is false.",
          bare_time_no_zone:
            "Does the message mention any specific clock time (like 9:00 AM) " +
            "WITHOUT naming a time zone for it? A message with no clock times " +
            "at all is false."
        }
      );
      if (
        !verdict.answers.confirms_booked ||
        verdict.answers.states_wrong_time ||
        verdict.answers.bare_time_no_zone
      ) {
        console.error("pick reply:", pick.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.confirms_booked).toBe(true);
      expect(verdict.answers.states_wrong_time).toBe(false);
      expect(verdict.answers.bare_time_no_zone).toBe(false);
    }
  );
});
