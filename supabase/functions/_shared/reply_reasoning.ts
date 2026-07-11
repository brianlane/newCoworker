/**
 * Reply-reasoning trailer: how the SMS pipeline captures the AI's decision
 * record (Lead Management PRD Ch. 6) without an extra model call.
 *
 * The worker appends REASONING_PROMPT_INSTRUCTION to the per-turn preamble,
 * asking the model to end its reply with ONE trailer line:
 *
 *   [[reasoning]]{"intent":"wants_quote","why":"...","handoff":false}
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

/**
 * Sentinel that opens a reasoning trailer line.
 *
 * Plain ASCII on purpose. The first version used the Unicode brackets
 * ⟦reasoning⟧ (un-typeable by customers), but production showed models do
 * NOT reproduce exotic brackets byte-perfectly — one live reply came back as
 * `⟦reasoning}{...}⟧` (closer swapped for `}` and the `⟧` displaced to the
 * end of the line), the exact match found nothing, and the whole trailer was
 * texted to the customer. Doubled square brackets are trivial for any model
 * to emit verbatim, and the tolerant matcher below scrubs the near-misses.
 */
export const REASONING_MARKER = "[[reasoning]]";

/**
 * Tolerant marker detector used for STRIPPING (never for teaching — the
 * prompt always shows the canonical marker). Accepts every observed and
 * plausible mangling: `[[reasoning]]`, `[reasoning]`, `⟦reasoning⟧`,
 * `⟦reasoning}` (the production leak), with optional inner whitespace and
 * any case. Stripping is deliberately over-eager: a false positive costs a
 * clipped line; a false negative texts internal reasoning to a customer.
 */
const MARKER_PATTERN = /[⟦\[]{1,2}\s*reasoning\s*[⟧\]}]{0,2}/i;

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
 * only the documented shape; anything else is null. Parses the outermost
 * `{...}` span rather than the raw payload because marker debris can bracket
 * the JSON (the production leak carried a displaced `⟧` after the closing
 * brace).
 */
function parseTrailer(payload: string): ReplyReasoning | null {
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(start, end + 1));
  } catch {
    return null;
  }
  // A valid-JSON string that starts with "{" and ends with "}" can only be
  // an object, so no shape guard is needed between parse and field checks.
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
  if (!MARKER_PATTERN.test(raw)) {
    return { reply: raw, reasoning: null };
  }
  const keptLines: string[] = [];
  let reasoning: ReplyReasoning | null = null;
  for (const line of raw.split("\n")) {
    const match = MARKER_PATTERN.exec(line);
    if (!match) {
      keptLines.push(line);
      continue;
    }
    const before = line.slice(0, match.index).trimEnd();
    if (before) keptLines.push(before);
    const parsed = parseTrailer(line.slice(match.index + match[0].length));
    if (parsed) reasoning = parsed;
  }
  // Collapse the blank tail the removed trailer line usually leaves behind.
  const reply = keptLines.join("\n").replace(/\n+$/, "").trimEnd();
  return { reply, reasoning };
}
