/**
 * Pure helpers for the voice warm-handoff chain (HomeLight live transfer).
 *
 * The state machine itself lives in telnyx-voice-inbound (it needs Telnyx +
 * Supabase), but the branch-free decisions, how to encode/parse the transfer
 * client_state and which step to try next, are isolated here so they can be
 * unit-tested without a live call. Imported by both the Deno edge function and
 * the Vitest suite, so this file must stay dependency-free (btoa/atob only).
 */

export type HandoffStep = { to_e164: string; ring_secs: number };

/**
 * One DTMF press in an AI-first accept sequence (see planAiFirstAccept).
 * `after_seconds` ABSENT means "use the default wait"; an explicit 0 means
 * "press immediately". The distinction matters: an author who never chose a
 * wait should still get the announcement pause, while one who typed 0 meant it.
 */
export type AcceptDigit = { digit: string; after_seconds?: number };

export type HandoffAiTakeover = {
  notify_e164: string;
  persona?: string;
  capture_fields?: string[];
  /** Second recipient of the same post-call summary (owner copy). */
  also_notify_e164?: string;
  /**
   * AI-first: the AI answers the call itself and the ring steps are only the
   * fallback for when it cannot (no budget, unhealthy bridge, refused DTMF).
   */
  answer_first?: boolean;
  /** IVR digits pressed after answering, in order. */
  accept_digits?: AcceptDigit[];
  /** Pause between the last digit and attaching the AI media. */
  media_start_seconds?: number;
  /**
   * IVR GATE. Press the accept digit when the partner's recording ASKS for it
   * rather than on a guessed timer: the answer path attaches media immediately
   * and presses nothing, and the bridge holds its greeting, listens, and sends
   * the digit through its press_digits tool (blind-pressing at `fallback_ms` if
   * it never recognizes the cue). Mutually exclusive with accept_digits.
   */
  ivr_gate?: { digit: string; fallback_ms?: number };
  /**
   * What the AI already KNOWS about the person, injected into its system
   * prompt with a never-re-ask rule. Stamped at answer time from the partner's
   * inbound alert text, and REPLACED mid-call by a voice_brief step once the
   * flow has read the portal (the bridge polls this field).
   */
  context_note?: string;
  /**
   * Text identifying the partner's alert SMS (e.g. "HomeLight Referral"). At
   * answer time the newest inbound text containing it becomes the pre-call
   * brief. Needed because the alert arrives from a different number than the
   * call, seconds earlier, before any flow step has run.
   */
  brief_sms_contains?: string;
  /**
   * Stamped once the AI-first path has sent the accept digits, so the takeover
   * in telnyx-voice-call-end does NOT press again if the call later falls back
   * to ringing humans: the partner already accepted and connected the customer,
   * and a second press can mis-route a live call.
   */
  accept_sent?: boolean;
};

/**
 * How far back the pre-call brief looks for the partner's alert text.
 *
 * Widened from 15 on 2026-08-28 after Rhonda J.'s HomeLight transfer missed
 * its own alert by 13 seconds: HomeLight texted at 15:40:02Z and transferred
 * at 15:55:16Z, so the AI opened with a generic line at a seller whose name,
 * zip and price we were holding. Measured over every live transfer on record
 * (8 calls, the only tenant using a brief needle): the text-to-transfer delay
 * ran 0.8, 0.8, 0.9, 2.9, 12.2, 15.2 and 19.2 minutes, plus one transfer with
 * no matching alert at all. 15 minutes briefed 5 of 8; 30 briefs 7 of 8 and
 * leaves the alert-less one correctly unbriefed.
 *
 * Widening cannot turn a RIGHT brief into a WRONG one: the reader takes the
 * NEWEST match in the window, so extra reach only supplies a candidate where
 * there were none. It can only mis-fire when a transfer's own alert is older
 * than the window AND a different lead's alert sits inside it. The closest
 * two different-lead alerts have ever landed is 19.1 minutes apart (28 alerts
 * since June), and replaying all 8 calls at 15, 20, 30 and 60 minutes picked
 * the same lead every time, so the headroom is bought cheaply. Raising this
 * further should be re-measured, not assumed: a wrong brief tells the AI a
 * stranger's details are "already known, so never ask for it".
 */
export const AI_FIRST_BRIEF_LOOKBACK_MINUTES = 30;

/** Cap on the alert text carried into the AI's prompt as the brief. */
export const AI_FIRST_BRIEF_MAX_CHARS = 600;

/**
 * Wrap a partner's alert text as a context note. Quoted and labelled verbatim
 * rather than summarized: the bridge injects it under "What you ALREADY KNOW
 * about this person", and a paraphrase risks inventing a detail the AI would
 * then assert to a live customer.
 */
export function buildPreCallBrief(alertText: string): string {
  const text = alertText.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const clipped =
    text.length > AI_FIRST_BRIEF_MAX_CHARS ? text.slice(0, AI_FIRST_BRIEF_MAX_CHARS) : text;
  return `The referral alert we received moments ago reads, verbatim: "${clipped}". Everything in it is already known, so never ask for it.`;
}

/**
 * Ceiling on the wait between answering and the AI speaking. The whole accept
 * sequence runs inside ONE Telnyx webhook, so a longer wait risks the webhook
 * timing out and Telnyx retrying a call the AI has already answered. Raising
 * this means driving the continuation off a later Telnyx event instead.
 */
export const AI_FIRST_MAX_DELAY_SECONDS = 5;

/** Wait before a press whose delay was never authored (announcement pause). */
export const DEFAULT_ACCEPT_WAIT_SECONDS = 3;

/** Press "1" three seconds in: long enough for a short IVR announcement. */
export const AI_FIRST_DEFAULT_ACCEPT: readonly AcceptDigit[] = [
  { digit: "1", after_seconds: DEFAULT_ACCEPT_WAIT_SECONDS }
];

/** Default pause after accepting, for the partner to connect the customer. */
export const AI_FIRST_DEFAULT_MEDIA_SECONDS = 2;

/**
 * Total seconds an AI-first answer waits before the AI speaks. Shape-agnostic
 * (takes the delays, not the objects) so the camelCase authoring schema and the
 * snake_case runtime context can share one budget rule.
 *
 * Applies the SAME defaults planAiFirstAccept does, because the budget the
 * author is checked against has to be the budget the webhook actually spends: an
 * unauthored wait costs the announcement default, not nothing, and an unauthored
 * media pause costs its default too. Counting them as zero would let a flow save
 * cleanly and then have its configured mediaStartSeconds silently clamped away.
 */
export function aiFirstDelaySeconds(
  digitDelays: readonly (number | undefined)[] | undefined,
  mediaStartSeconds: number | undefined
): number {
  const digits = (digitDelays ?? []).reduce<number>(
    (sum, d) => sum + (d === undefined ? DEFAULT_ACCEPT_WAIT_SECONDS : coerceDelaySeconds(d)),
    0
  );
  const media =
    mediaStartSeconds === undefined
      ? AI_FIRST_DEFAULT_MEDIA_SECONDS
      : coerceDelaySeconds(mediaStartSeconds);
  return digits + media;
}

/**
 * Normalize an AI-first takeover's accept sequence for execution: authored
 * digits (or the default single "1"), each delay coerced to a sane integer,
 * and the whole thing clamped to {@link AI_FIRST_MAX_DELAY_SECONDS} by
 * dropping trailing waits rather than pressing early: a digit sent before the
 * announcement ends is not accepted at all, whereas a shorter final pause only
 * risks the AI greeting a beat early.
 */
export function planAiFirstAccept(ai: HandoffAiTakeover | null): {
  /** Every wait resolved to a concrete number, so the caller just sleeps it. */
  digits: Array<{ digit: string; after_seconds: number }>;
  mediaStartSeconds: number;
} {
  const authored = Array.isArray(ai?.accept_digits) ? ai!.accept_digits : null;
  const source: readonly AcceptDigit[] =
    authored && authored.length > 0 ? authored : AI_FIRST_DEFAULT_ACCEPT;
  const digits: Array<{ digit: string; after_seconds: number }> = [];
  let spent = 0;
  for (const raw of source) {
    const digit = typeof raw?.digit === "string" ? raw.digit.trim() : "";
    if (!/^[0-9*#]$/.test(digit)) continue;
    // No authored wait means the author never chose one, so use the announcement
    // default rather than pressing into an announcement that is still playing.
    // An explicit 0 is honored as "press immediately".
    const wanted =
      raw?.after_seconds === undefined
        ? DEFAULT_ACCEPT_WAIT_SECONDS
        : coerceDelaySeconds(raw.after_seconds);
    const room = Math.max(0, AI_FIRST_MAX_DELAY_SECONDS - spent);
    const after = Math.min(wanted, room);
    spent += after;
    digits.push({ digit, after_seconds: after });
  }
  // Every authored digit was malformed: fall back to the default press rather
  // than answering and then never accepting.
  if (digits.length === 0) {
    const after = Math.min(DEFAULT_ACCEPT_WAIT_SECONDS, AI_FIRST_MAX_DELAY_SECONDS);
    digits.push({ digit: AI_FIRST_DEFAULT_ACCEPT[0]!.digit, after_seconds: after });
    spent = after;
  }
  const wantedMedia =
    ai?.media_start_seconds === undefined
      ? AI_FIRST_DEFAULT_MEDIA_SECONDS
      : coerceDelaySeconds(ai.media_start_seconds);
  return {
    digits,
    mediaStartSeconds: Math.min(wantedMedia, Math.max(0, AI_FIRST_MAX_DELAY_SECONDS - spent))
  };
}

/** JSONB delays can arrive as numbers or numeric strings; bound them to 0..8. */
function coerceDelaySeconds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(8, Math.floor(n));
}

/** Resolved chain snapshot stored on the session row's `context`. */
export type HandoffContext = {
  to_e164: string;
  steps: HandoffStep[];
  ai_takeover: HandoffAiTakeover | null;
  /**
   * Steps whose transfer leg AMD proved was answered by a MACHINE, keyed by
   * step number (JSON object keys are strings). Stamped by the AMD handler
   * BEFORE it hangs the leg up, because an API hangup on an answered leg
   * arrives as `normal_clearing`, the exact cause the hangup path reads as
   * "a human answered and the call completed". The marker diverts that
   * branch to advance the chain instead, keeping the hangup path the single
   * writer of advancement.
   */
  amd_machine_steps?: Record<string, boolean>;
  /**
   * The flow's `options.starAlerts`: frame every alert text this chain sends
   * in a row of asterisks so a live transfer stands out. Snapshotted here at
   * chain start, so the call-end webhook and the on-box voice bridge both read
   * it off the session row instead of re-reading the flow. Absent (legacy
   * `voice_handoff_chains` rows, flows that never opted in) = plain text.
   */
  star_alerts?: boolean;
};

export const HANDOFF_CS_PREFIX = "hl";

/** Plain-text client_state we attach to each transfer leg: `hl:<aLegCallId>:<step>`. */
export function encodeHandoffClientState(aLegCallId: string, step: number): string {
  return `${HANDOFF_CS_PREFIX}:${aLegCallId}:${step}`;
}

/**
 * Parse the client_state echoed on a transfer leg's webhook. Telnyx returns
 * client_state base64-encoded, so we decode first when it isn't already the
 * plain `hl:...` form (covers both real webhooks and direct unit tests).
 */
export function parseHandoffClientState(
  raw: string | null | undefined
): { aLegCallId: string; step: number } | null {
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith(`${HANDOFF_CS_PREFIX}:`)) {
    try {
      text = atob(raw);
    } catch {
      return null;
    }
  }
  // aLegCallId can itself contain ':'; anchor on the trailing `:<digits>` and
  // treat everything between the prefix and that as the call id. The `\d+`
  // group guarantees a non-negative integer step.
  const m = /^hl:(.+):(\d+)$/.exec(text);
  if (!m) return null;
  return { aLegCallId: m[1]!, step: Number(m[2]) };
}

export type HandoffAdvance =
  | { kind: "transfer"; step: number; toE164: string; ringSecs: number }
  | { kind: "ai_takeover" }
  | { kind: "hangup" };

/**
 * Decide what to do after `failedStep` rang out with no answer:
 *   - ring the next human step if there is one,
 *   - otherwise hand to the AI worker if a takeover is configured,
 *   - otherwise hang up.
 */
export function planHandoffAdvance(args: {
  steps: HandoffStep[];
  failedStep: number;
  hasAiTakeover: boolean;
}): HandoffAdvance {
  const next = args.failedStep + 1;
  // `steps` is pre-validated by buildHandoffContext (non-empty to_e164 only).
  const step = args.steps[next];
  if (step) {
    const ringSecs = step.ring_secs > 0 ? Math.floor(step.ring_secs) : 20;
    return { kind: "transfer", step: next, toE164: step.to_e164, ringSecs };
  }
  if (args.hasAiTakeover) return { kind: "ai_takeover" };
  return { kind: "hangup" };
}

/**
 * Coerce a step's `ring_secs` to a positive integer, defaulting to 20. JSONB
 * values can arrive as numbers OR numeric strings (e.g. `"45"`), so accept both;
 * anything non-finite or <= 0 falls back to the 20s default.
 */
export function coerceRingSecs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** Normalize a raw chain row's `steps`/`ai_takeover` into a typed context. */
export function buildHandoffContext(input: {
  toE164: string;
  steps: unknown;
  aiTakeover: unknown;
  /** Flow opt-in (options.starAlerts). Legacy chain rows never pass it. */
  starAlerts?: boolean;
}): HandoffContext {
  const steps: HandoffStep[] = Array.isArray(input.steps)
    ? (input.steps as unknown[])
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          const to = typeof o.to_e164 === "string" ? o.to_e164 : "";
          return { to_e164: to, ring_secs: coerceRingSecs(o.ring_secs) };
        })
        .filter((s) => s.to_e164.length > 0)
    : [];
  let ai: HandoffAiTakeover | null = null;
  if (input.aiTakeover && typeof input.aiTakeover === "object") {
    const o = input.aiTakeover as Record<string, unknown>;
    const notify = typeof o.notify_e164 === "string" ? o.notify_e164 : "";
    if (notify) {
      const alsoNotify = typeof o.also_notify_e164 === "string" ? o.also_notify_e164.trim() : "";
      const digits = Array.isArray(o.accept_digits)
        ? (o.accept_digits as unknown[])
            .map((d) => {
              const row = (d ?? {}) as Record<string, unknown>;
              return {
                digit: typeof row.digit === "string" ? row.digit.trim() : "",
                // Absent stays absent so planAiFirstAccept can tell "no wait
                // chosen" (use the default) from an explicit 0.
                ...(row.after_seconds === undefined
                  ? {}
                  : { after_seconds: coerceDelaySeconds(row.after_seconds) })
              };
            })
            .filter((d) => d.digit.length > 0)
        : undefined;
      const gate = (o.ivr_gate ?? null) as Record<string, unknown> | null;
      const gateDigit = typeof gate?.digit === "string" ? gate.digit.trim() : "";
      const gateFallbackMs =
        typeof gate?.fallback_ms === "number" && Number.isFinite(gate.fallback_ms)
          ? Math.max(0, Math.round(gate.fallback_ms))
          : 0;
      const ivrGate = gateDigit
        ? { digit: gateDigit, ...(gateFallbackMs > 0 ? { fallback_ms: gateFallbackMs } : {}) }
        : null;
      ai = {
        notify_e164: notify,
        persona: typeof o.persona === "string" ? o.persona : undefined,
        capture_fields: Array.isArray(o.capture_fields)
          ? (o.capture_fields as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined,
        // Absent rather than false/empty so an untouched chain's persisted
        // context stays byte-identical to the pre-AI-first shape.
        ...(alsoNotify ? { also_notify_e164: alsoNotify } : {}),
        ...(o.answer_first === true ? { answer_first: true } : {}),
        ...(digits && digits.length > 0 ? { accept_digits: digits } : {}),
        ...(o.media_start_seconds === undefined
          ? {}
          : { media_start_seconds: coerceDelaySeconds(o.media_start_seconds) }),
        ...(typeof o.brief_sms_contains === "string" && o.brief_sms_contains.trim()
          ? { brief_sms_contains: o.brief_sms_contains.trim() }
          : {}),
        ...(ivrGate ? { ivr_gate: ivrGate } : {}),
        ...(o.accept_sent === true ? { accept_sent: true } : {}),
        ...(typeof o.context_note === "string" && o.context_note.trim()
          ? { context_note: o.context_note.trim() }
          : {})
      };
    }
  }
  // Omitted rather than stored as false so an opted-out chain's persisted
  // context stays byte-identical to what it was before star alerts existed.
  return {
    to_e164: input.toE164,
    steps,
    ai_takeover: ai,
    ...(input.starAlerts === true ? { star_alerts: true } : {})
  };
}
