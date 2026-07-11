/**
 * Reply-reasoning trailer: how the SMS pipeline captures the AI's decision
 * record (Lead Management PRD Ch. 6) without an extra model call.
 *
 * The worker appends REASONING_PROMPT_INSTRUCTION to the per-turn preamble,
 * asking the model to end its reply with ONE trailer line:
 *
 *   ⟦reasoning⟧{"intent":"wants_quote","why":"...","handoff":false}
 *
 * `splitReplyReasoning` then strips every trailer-marked line from the reply
 * (the customer must NEVER see it — including echoes a customer might try to
 * inject) and parses the LAST one into a typed record. Everything is
 * best-effort: no trailer, or a malformed one, yields `reasoning: null` and
 * the untouched customer-facing text.
 *
 * Pure module (no IO) so it is fully unit-tested and importable from both
 * the Deno worker and any Node surface.
 */

/** Sentinel that opens a reasoning trailer line. Unusual on purpose. */
export const REASONING_MARKER = "\u27E6reasoning\u27E7";

/**
 * Appended to the model's per-turn instructions. Kept terse: the trailer is
 * machine-read, and a long spec would crowd the actual conversation prompt.
 */
export const REASONING_PROMPT_INSTRUCTION =
  `\n\nAfter your reply, on its own final line, append exactly: ` +
  `${REASONING_MARKER}{"intent":"<the texter's goal, snake_case, max 5 words>",` +
  `"why":"<one short sentence: why you replied this way>",` +
  `"handoff":<true if this reply books, escalates, or hands the person to a human, else false>}` +
  ` — this line is stripped before the texter sees your message; never mention it.`;

export type ReplyReasoning = {
  intent: string;
  rationale: string;
  escalated: boolean;
};

export type SplitReplyResult = {
  /** Customer-facing text with every trailer line removed. */
  reply: string;
  /** Parsed record from the last well-formed trailer, or null. */
  reasoning: ReplyReasoning | null;
};

/** DB check bounds (mirrors the ai_reply_reasoning column constraints). */
const MAX_INTENT_LENGTH = 80;
const MAX_RATIONALE_LENGTH = 400;

/**
 * Parse one trailer payload (the text after the marker on its line). Accepts
 * only the documented shape; anything else is null.
 */
function parseTrailer(payload: string): ReplyReasoning | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const intent = typeof rec.intent === "string" ? rec.intent.trim() : "";
  const why = typeof rec.why === "string" ? rec.why.trim() : "";
  if (!intent || !why) return null;
  return {
    intent: intent.slice(0, MAX_INTENT_LENGTH),
    rationale: why.slice(0, MAX_RATIONALE_LENGTH),
    escalated: rec.handoff === true
  };
}

/**
 * Strip every marker-carrying line from the reply and parse the LAST one.
 * A marker mid-line strips from the marker to the end of that line (a model
 * that glued the trailer onto its last sentence keeps the sentence).
 */
export function splitReplyReasoning(raw: string): SplitReplyResult {
  if (!raw.includes(REASONING_MARKER)) {
    return { reply: raw, reasoning: null };
  }
  const keptLines: string[] = [];
  let reasoning: ReplyReasoning | null = null;
  for (const line of raw.split("\n")) {
    const at = line.indexOf(REASONING_MARKER);
    if (at === -1) {
      keptLines.push(line);
      continue;
    }
    const before = line.slice(0, at).trimEnd();
    if (before) keptLines.push(before);
    const parsed = parseTrailer(line.slice(at + REASONING_MARKER.length));
    if (parsed) reasoning = parsed;
  }
  // Collapse the blank tail the removed trailer line usually leaves behind.
  const reply = keptLines.join("\n").replace(/\n+$/, "").trimEnd();
  return { reply, reasoning };
}
