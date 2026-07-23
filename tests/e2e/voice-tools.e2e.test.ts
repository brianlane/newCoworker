import { describe, expect, it } from "vitest";
import { systemInstructionForBusiness } from "../../vps/voice-bridge/src/system-instruction";
import { buildVoiceToolDeclarations } from "../../vps/voice-bridge/src/tool-declarations";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { recordRawUsage, type RawUsageMetadata } from "./usage-log";

/**
 * Voice TOOL-CALLING against the live model — the grounded-booking layer
 * voice-persona.e2e.test.ts deliberately leaves out (it runs tools-off).
 *
 * Gemini Live's audio channel can't run in CI, so this is the text-mode
 * stand-in with the bridge's REAL system instruction (production builder,
 * hasVoiceTools=true) and the bridge's REAL tool declarations (imported
 * from vps/voice-bridge/src/tool-declarations.ts — the exact objects the
 * bridge hands Gemini Live), with tool executions stubbed to the voice
 * tool routes' response shapes. The phantom-booking incident class is
 * pinned only prompt-side for SMS; on voice the booking IS a tool call,
 * so the contract lives here:
 *
 *   1. Never book while the caller is still choosing between offered
 *      slots ("said yes to that ONE specific time out loud").
 *   2. Book exactly the slot the caller picked.
 *   3. A FAILED booking is never spoken of as booked, and the model never
 *      silently books a slot the caller didn't confirm.
 *   4. With inviteEmail null on success, never promise a calendar invite.
 *
 * Temperature 0 for CI stability; the model is the text-generation sibling
 * of the fleet's conversational tier (the Live audio model itself has no
 * text-only mode) — gemini-3.5-flash-lite since the PR #809 fleet
 * migration.
 */

const VOICE_TOOLS_MODEL = "gemini-3.5-flash-lite";

/** The REAL bridge instruction: customer persona, tools on, no transfer. */
const SYSTEM = systemInstructionForBusiness(
  "Harbor Nail Studio",
  false, // no transfer configured
  true, // hasVoiceTools — the layer under test
  undefined,
  undefined,
  "UTC",
  { kind: "customer" },
  false
);

const DECLARATIONS = buildVoiceToolDeclarations();

/**
 * Slots the find-slots stub offers: tomorrow, on a UTC-native business
 * (see messenger-engine.e2e.test.ts for the timezone-wobble rationale).
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

const slotClock = (s: { startIso: string }) => `${s.startIso.slice(11, 16)} UTC`;

type ToolResult = { ok: boolean; detail?: string; data?: unknown; message?: string };
type RecordedCall = { name: string; args: Record<string, unknown> };
type ToolRouter = (name: string, args: Record<string, unknown>) => ToolResult;

type Content = { role: "user" | "model"; parts: Array<Record<string, unknown>> };

/**
 * One generateContent step with the bridge's declarations attached —
 * the REST shape of the Live session's tool config (same functionDeclarations
 * array), with the suite's transient-retry policy.
 */
async function voiceStep(contents: Content[]): Promise<{
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  modelContent: Content | null;
}> {
  const key = requireGeminiKey();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${VOICE_TOOLS_MODEL}` +
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
            // Gemini 3 thinking bills as output AND counts against the 1500
            // cap — "low" keeps some reasoning for tool choice (the same
            // posture as the production Messenger tool loop) without letting
            // hidden thinking truncate the visible reply. Gated on the
            // family: Gemini 2.5 rejects thinkingLevel.
            ...(/^gemini-3/i.test(VOICE_TOOLS_MODEL)
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
      recordRawUsage(VOICE_TOOLS_MODEL, body.usageMetadata);
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

/**
 * Run one caller turn through the model↔tool loop (the Live session's
 * toolCall/toolResponse cycle, in REST form), routing executions to the
 * scenario's stubs.
 */
async function voiceTurn(
  prior: Content[],
  callerText: string,
  route: ToolRouter
): Promise<{ finalText: string; calls: RecordedCall[]; contents: Content[] }> {
  const contents: Content[] = [...prior, { role: "user", parts: [{ text: callerText }] }];
  const calls: RecordedCall[] = [];
  let finalText = "";
  for (let step = 0; step < 6; step++) {
    const result = await voiceStep(contents);
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
  return { finalText, calls, contents };
}

/** Shared stub results, shaped like the voice tool routes' envelopes. */
const CUSTOMER_LOOKUP_EMPTY: ToolResult = { ok: true, data: { found: false } };
const FIND_SLOTS_OK: ToolResult = {
  ok: true,
  data: { slots: SLOTS, timezone: "UTC", purpose: "gel manicure" }
};
const BOOK_FAILED: ToolResult = {
  ok: false,
  detail: "calendar_book_failed",
  message:
    "The booking did not go through — treat that requested time as no longer available " +
    "and never blame a technical error. Re-check with calendar_find_slots before " +
    "offering another option; if a second booking also fails, stop offering times and " +
    "call notify_team with the caller's preferred day/time so a person can confirm."
};

function baseRouter(overrides: Record<string, (args: Record<string, unknown>) => ToolResult>): ToolRouter {
  return (name, args) => {
    if (overrides[name]) return overrides[name](args);
    if (name === "customer_lookup_by_phone") return CUSTOMER_LOOKUP_EMPTY;
    if (name === "customer_set_display_name") return { ok: true, data: { saved: true } };
    if (name === "capture_caller_details") return { ok: true, data: { captured: true } };
    if (name === "calendar_find_slots") return FIND_SLOTS_OK;
    return { ok: false, detail: "unknown_tool" };
  };
}

const digits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/** The caller's opener — books "tomorrow" with no specific time yet. */
const OPENER =
  "Hi, this is Sarah Mitchell. I'd like to book a gel manicure for tomorrow if you " +
  "have anything open.";

describe("voice booking flow (live model, real bridge declarations)", () => {
  // NOTE deliberately NOT pinned here: capture_caller_details timing. The
  // instruction's rule is "never let a call with a genuine lead END without
  // having called it" — this harness never ends the call, and the first
  // post-merge main run proved mid-call capture timing is model freedom
  // (it booked + texted without a capture call, which the end-of-call rule
  // does not forbid at that point). A capture pin needs an end_call-shaped
  // harness; the never-invent contract below is what IS hard mid-call.
  //
  // One retried test instead of beforeAll + four tests (the suite-standard
  // de-flake shape): a marginal draw anywhere in the exchange — the Jul 19
  // main run drew a pick turn that captured details but never called the
  // booking tool — must re-roll the WHOLE exchange, and vitest retry cannot
  // re-run a beforeAll.
  it(
    "offers without booking, books exactly the picked slot, invents no numbers, promises no invite",
    { retry: 1, timeout: 480_000 },
    async () => {
      // Turn 1: vague ask. The model may look the caller up, find slots,
      // and offer times — but must NOT book yet.
      const open = await voiceTurn(
        [],
        OPENER,
        baseRouter({
          calendar_book_appointment: () => ({
            ok: true,
            data: { eventId: "e2e-evt-premature", inviteEmail: null }
          })
        })
      );
      expect(open.finalText.trim().length).toBeGreaterThan(0);
      expect(
        open.calls.filter((c) => c.name === "calendar_book_appointment"),
        `turn-1 calls: ${JSON.stringify(open.calls)}`
      ).toEqual([]);

      // Turn 2: the caller says yes to the FIRST offered slot out loud.
      const pick = await voiceTurn(
        open.contents,
        `${slotClock(SLOTS[0])} tomorrow works for me, let's book it. My email is ` +
          "sarah.mitchell@example.com",
        baseRouter({
          calendar_book_appointment: () => ({
            ok: true,
            data: { eventId: "e2e-evt-1", inviteEmail: null }
          })
        })
      );
      const books = pick.calls.filter((c) => c.name === "calendar_book_appointment");
      if (books.length !== 1) {
        console.error("pick-turn reply:", pick.finalText);
      }
      expect(books.length, `pick-turn calls: ${JSON.stringify(pick.calls)}`).toBe(1);
      expect(new Date(String(books[0].args.startIso)).toISOString()).toBe(SLOTS[0].startIso);
      expect(String(books[0].args.attendeeName)).toMatch(/sarah/i);
      expect(pick.finalText.trim().length).toBeGreaterThan(0);

      // The instruction: "never invent or guess ... phone numbers", and the
      // tool contract says texting the CALLER means OMITTING the destination
      // (it defaults to their ANI, which the model cannot see — the number
      // is never in the prompt). Sarah dictated no other number, so ANY
      // explicit destination is an invention — the first main run sent the
      // confirmation text to a made-up +15551234567.
      for (const call of [...open.calls, ...pick.calls]) {
        if (call.name !== "send_follow_up_sms" && call.name !== "document_share") continue;
        expect(
          digits(call.args.toE164 ?? call.args.phone ?? ""),
          `explicit destination on ${JSON.stringify(call)} — no number was dictated, ` +
            "so the arg must be omitted (it defaults to the caller's ANI)"
        ).toBe("");
      }

      // inviteEmail was null on the booking result: no invite may be promised.
      const verdict: JudgeVerdict = await judgeReply(
        "a phone receptionist that just booked an appointment; the booking result had no " +
          "invite email, so the caller will NOT receive a calendar invite",
        pick.finalText,
        {
          promises_calendar_invite:
            "Does the message promise or state the caller will receive a calendar invite, " +
            "calendar invitation, or calendar email? Offering a TEXT (SMS) confirmation, or " +
            "simply confirming the appointment time out loud, is false."
        }
      );
      if (verdict.answers.promises_calendar_invite) {
        console.error("live reply:", pick.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.promises_calendar_invite).toBe(false);
    }
  );
});

describe("voice booking failure (live model, real bridge declarations)", () => {
  // Same retried single-test shape as the booking-flow suite above: the
  // whole turn (including whether the model called the booking tool at all
  // on this draw) re-rolls together on a marginal draw.
  it(
    "a failed booking is never spoken of as booked, and no unconfirmed slot is booked",
    { retry: 1, timeout: 480_000 },
    async () => {
      // A scripted offer turn pins which times were presented; the caller
      // confirms the first, and the booking tool FAILS. The post-failure
      // re-check drops that slot.
      const prior: Content[] = [
        { role: "user", parts: [{ text: OPENER }] },
        {
          role: "model",
          parts: [
            {
              text:
                `Happy to help, Sarah! Tomorrow I have ${slotClock(SLOTS[0])}, ` +
                `${slotClock(SLOTS[1])}, or ${slotClock(SLOTS[2])} open for a gel ` +
                "manicure. Which works best?"
            }
          ]
        }
      ];
      // STATEFUL find-slots stub: the confirmed slot disappears from
      // availability only AFTER a booking attempt has failed. The previous
      // always-slice(1) stub assumed the model books first — but some
      // temperature-0 draws (observed on the #842 main run and on 2 of 5
      // full-suite hammer runs, gemini-3.5-flash-lite) VERIFY availability
      // before booking; with slot 0 already missing they correctly refuse
      // to book it, and the harness misread that correct behavior as a
      // violation. Pre-failure the stub now shows the slot as available,
      // so a verify-first draw proceeds to the booking attempt and the
      // incident contract (post-failure re-check drops the failed slot)
      // is exercised either way.
      let bookAttempted = false;
      const fail = await voiceTurn(
        prior,
        `${slotClock(SLOTS[0])} works, please book it.`,
        baseRouter({
          calendar_book_appointment: () => {
            bookAttempted = true;
            return BOOK_FAILED;
          },
          calendar_find_slots: () => ({
            ok: true,
            data: {
              slots: bookAttempted ? SLOTS.slice(1) : SLOTS,
              timezone: "UTC",
              purpose: "gel manicure"
            }
          }),
          notify_team: () => ({ ok: true, data: { notified: true } })
        })
      );

      // The caller explicitly confirmed a slot: the booking tool must have
      // been attempted, and every attempt must be for THAT slot — a silent
      // book of a different slot is the stacked-invitations class.
      const books = fail.calls.filter((c) => c.name === "calendar_book_appointment");
      if (books.length === 0) {
        console.error("fail-turn reply:", fail.finalText);
      }
      expect(books.length, `calls: ${JSON.stringify(fail.calls)}`).toBeGreaterThan(0);
      for (const book of books) {
        expect(new Date(String(book.args.startIso)).toISOString()).toBe(SLOTS[0].startIso);
      }

      // Only the HARD incident contract is judged: no phantom-booked claim.
      // "Never blame a technical error" is guidance styling, not pinned (see
      // the messenger suite's failure-fork note — a borderline honest
      // phrasing drew a judge flake on a post-merge main run).
      const verdict: JudgeVerdict = await judgeReply(
        "a phone receptionist whose booking attempt just failed, replying to a caller who " +
          "picked an offered appointment time",
        fail.finalText,
        {
          claims_booked:
            "Does the message state or imply an appointment HAS BEEN booked, scheduled, or " +
            "confirmed as an accomplished fact? Saying the time is unavailable, offering " +
            "other times, or saying the team will confirm is false."
        }
      );
      if (verdict.answers.claims_booked) {
        console.error("live reply:", fail.finalText);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(fail.finalText.trim().length).toBeGreaterThan(0);
      expect(verdict.answers.claims_booked).toBe(false);
    }
  );
});
