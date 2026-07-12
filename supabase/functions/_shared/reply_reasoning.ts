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
 * Second net: the trailer JSON itself, for trailers that escaped WITHOUT a
 * recognizable marker. Caught live by the e2e suite on its first run — the
 * model emitted `[[<free-form summary>]] {"intent":...}`, replacing the
 * marker word with actual reasoning text, which the marker matcher cannot
 * see. No customer-facing reply legitimately contains `{"intent":"`.
 */
const TRAILER_JSON_PATTERN = /\{\s*"intent"\s*:\s*"/;

/**
 * Where the trailer starts on this line, or -1. A recognizable marker wins;
 * otherwise a trailer-JSON body counts, extended left over a bracket blob
 * glued in front of it (the live-caught `[[summary]] {"intent":...}` shape).
 */
function trailerCutIndex(line: string): number {
  const marker = MARKER_PATTERN.exec(line);
  if (marker) return marker.index;
  const json = line.search(TRAILER_JSON_PATTERN);
  if (json === -1) return -1;
  const blob = Math.max(line.lastIndexOf("[[", json), line.lastIndexOf("\u27E6", json));
  return blob !== -1 ? blob : json;
}

/**
 * Appended to the model's per-turn instructions. Kept terse: the trailer is
 * machine-read, and a long spec would crowd the actual conversation prompt.
 */
export const REASONING_PROMPT_INSTRUCTION =
  `\n\nAfter your reply, on its own final line, append exactly: ` +
  `${REASONING_MARKER}{"intent":"<the texter's goal, snake_case, max 5 words>",` +
  `"why":"<one short sentence: why you replied this way>",` +
  `"handoff":<true ONLY when a human must take this conversation over or follow up — ` +
  `they asked for a person, you could not answer or do what they needed, or the topic ` +
  `is outside what you know. A booking or question you fully handled is NOT a handoff. Else false>}` +
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
 * Third net: free-form double-bracket blobs. Teaching the model the
 * `[[reasoning]]` marker made it generalize "double brackets are my private
 * notes" — live replays showed replies carrying `[[The user wants to
 * schedule...]]` (no marker word, no JSON) straight into customer text.
 * No legitimate SMS reply wraps prose in `[[...]]`, so every such span is
 * stripped wholesale (multi-line included).
 */
const BRACKET_BLOB_PATTERN = /\[\[[\s\S]*?\]\]/g;

/** A line that is only a markdown fence (with an optional language tag). */
function isBareFence(line: string): boolean {
  return /^\s*```[a-z]*\s*$/i.test(line);
}

/**
 * More `{` than `}` so far — the trailer JSON continues on later lines.
 * String-aware: braces inside JSON string literals (a `}` in the `why`
 * text, an escaped quote) don't count, so the multi-line walk neither
 * stops early nor swallows customer text after the trailer.
 */
function unclosedBraces(chunk: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of chunk) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth > 0;
}

/**
 * Strip every trailer from the reply and parse the LAST well-formed one.
 * Handled shapes, all observed live:
 *   - single-line trailers (marker variants or bare trailer JSON), stripped
 *     from the trailer's start to end of line (a model that glued the
 *     trailer onto its last sentence keeps the sentence);
 *   - PRETTY-PRINTED trailers whose JSON spans multiple lines (the walk
 *     consumes lines until the braces balance — stripped even when the
 *     JSON turns out malformed);
 *   - free-form `[[...]]` blobs with no marker word at all (third net);
 *   - markdown fence lines left bare once the trailer inside them is gone.
 */
export function splitReplyReasoning(raw: string): SplitReplyResult {
  if (!MARKER_PATTERN.test(raw) && !TRAILER_JSON_PATTERN.test(raw) && !raw.includes("[[")) {
    return { reply: raw, reasoning: null };
  }
  const lines = raw.split("\n");
  const keptLines: string[] = [];
  let reasoning: ReplyReasoning | null = null;
  let stripped = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const at = trailerCutIndex(line);
    if (at === -1) {
      keptLines.push(line);
      i += 1;
      continue;
    }
    stripped = true;
    const before = line.slice(0, at).trimEnd();
    if (before) keptLines.push(before);
    // Gather the whole trailer: this line's cut, plus following lines while
    // the JSON braces are unbalanced (pretty-printed trailers span lines).
    // Consumed lines are stripped regardless of whether the JSON parses —
    // marker-plus-braces garbage must never reach the customer.
    let chunk = line.slice(at);
    while (chunk.includes("{") && unclosedBraces(chunk) && i + 1 < lines.length) {
      i += 1;
      chunk += "\n" + lines[i];
    }
    // parseTrailer scans for the outermost {...} span, so passing the cut
    // (marker/blob included) parses the same JSON for every variant.
    const parsed = parseTrailer(chunk);
    if (parsed) reasoning = parsed;
    i += 1;
  }

  let reply = keptLines.join("\n");
  // Third net: free-form [[...]] private-note blobs (see pattern doc).
  if (reply.includes("[[")) {
    const scrubbed = reply.replace(BRACKET_BLOB_PATTERN, "");
    if (scrubbed !== reply) stripped = true;
    reply = scrubbed;
  }
  // A stripped trailer can leave its markdown fences behind as bare ```
  // lines; drop them only when something was actually stripped so a benign
  // fenced snippet in a normal reply is left alone.
  if (stripped) {
    reply = reply
      .split("\n")
      .filter((l) => !isBareFence(l))
      .join("\n");
  }
  // Collapse the blank runs the removed content leaves behind (both ends:
  // a leading [[...]] blob strips to an empty first line).
  reply = reply
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .trimEnd();
  return { reply, reasoning };
}
