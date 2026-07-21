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
  `they asked for a person/representative/human (ALWAYS true then, even if you offered ` +
  `to schedule or book a call for them), you could not answer or do what they needed, ` +
  `or the topic is outside what you know. A booking or question you fully handled is ` +
  `NOT a handoff — but asking to talk to a person is never "handled" by a booking offer. ` +
  `Else false>}` +
  ` — this line is stripped before the texter sees your message; never mention it.`;

export type ReplyReasoning = {
  intent: string;
  rationale: string;
  escalated: boolean;
};

/**
 * Deterministic backstop for the handoff flag (Truly Insurance 2026-07-20):
 * their tester asked to "speak to a representative" six times and every turn
 * came back intent=request_human_agent with handoff:false — the model judged
 * its schedule-a-call offer to have HANDLED the person-request, so the
 * needs-human escalation (PR #534) never fired. When the intent itself NAMES
 * a human, the worker must not depend on the model's handoff judgment.
 *
 * Matching is token-based over the snake_case intent so substrings never
 * false-positive ("rep" must not match "repair_estimate_request", "person"
 * must not match "personal_insurance_question"):
 *
 *  - an unambiguous human noun (human / representative / rep / operator)
 *    escalates on its own IF a contact verb accompanies it — "representative
 *    _office_hours_question" is about a person, not a request FOR one;
 *  - the ambiguous nouns (agent / person / someone / somebody) additionally
 *    require the contact verb and exclude the "in_person" meeting-mode bigram
 *    ("in_person_meeting_request" is a booking, not a staffing request).
 *
 * In practice the observed live intents (request_human_agent,
 * speak_to_representative, …) always carry a verb; a verbless noun-only
 * intent falls through to the model's own handoff flag.
 */
const HUMAN_NOUN_RE = /(^|_)(human|representative|rep|operator|agent|person|someone|somebody)(_|$)/;
const CONTACT_VERB_RE =
  /(^|_)(speak|talk|call|contact|connect|reach|request|want|wants|need|needs|ask|asked|get)(_|$)/;
const IN_PERSON_BIGRAM_RE = /(^|_)in_person(_|$)/g;

export function isHumanRequestIntent(intent: string): boolean {
  const normalized = intent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(IN_PERSON_BIGRAM_RE, "$1");
  return HUMAN_NOUN_RE.test(normalized) && CONTACT_VERB_RE.test(normalized);
}

/**
 * The worker's single escalation decision: the model's own handoff flag OR
 * the deterministic human-request intent. Callers store and act on THIS,
 * never on `escalated` alone.
 */
export function shouldEscalateToHuman(reasoning: ReplyReasoning): boolean {
  return reasoning.escalated || isHumanRequestIntent(reasoning.intent);
}

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

/** Max lines a multi-line (pretty-printed) trailer may span past its marker. */
const MAX_TRAILER_LINES = 12;

/**
 * A markdown fence-only line (``` or ```json). When a trailer was stripped,
 * these are debris from a model that fenced its trailer — never customer
 * copy — and are scrubbed too. (An SMS reply has no legitimate code fences;
 * stripping here is deliberately over-eager, like the marker matcher.)
 */
const FENCE_LINE_RE = /^\s*`{3,}[a-zA-Z]*\s*$/;

/** True when `text` contains a complete balanced `{...}` span. */
function hasBalancedObject(text: string): boolean {
  const start = text.indexOf("{");
  if (start === -1) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * Third net, for a PRETTY-PRINTED trailer with no marker at all: a line that
 * is just `{` whose next non-blank line opens with `"intent":`. Neither the
 * marker matcher nor the (line-local) trailer-JSON matcher can see this
 * shape, and no customer-facing reply legitimately contains it.
 */
function bareObjectTrailerStart(lines: string[], i: number): boolean {
  if (!/^\s*\{\s*$/.test(lines[i])) return false;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  return j < lines.length && /^\s*"intent"\s*:/.test(lines[j]);
}

/**
 * Collect the full trailer payload starting at `cutIndex` on `startLine`.
 * The instruction asks for a single line, but models pretty-print: the JSON
 * may OPEN on the marker line and close later, or start on a following line
 * entirely (`[[reasoning]]\n{\n  "intent": … }`). Both used to leak the JSON
 * body to the customer because stripping was strictly line-based. Consumes
 * forward (bounded by MAX_TRAILER_LINES) only while the shape still looks
 * like a trailer; anything else falls back to stripping just the marker line.
 */
function gatherTrailerPayload(
  lines: string[],
  startLine: number,
  cutIndex: number
): { payload: string; endLine: number } {
  const single = lines[startLine].slice(cutIndex);
  if (hasBalancedObject(single)) return { payload: single, endLine: startLine };
  if (!single.includes("{")) {
    // Marker with no JSON on its own line: only treat following lines as the
    // trailer when the next non-blank line actually opens an object.
    let peek = startLine + 1;
    while (peek < lines.length && lines[peek].trim() === "") peek++;
    if (peek >= lines.length || !lines[peek].trimStart().startsWith("{")) {
      return { payload: single, endLine: startLine };
    }
  }
  let payload = single;
  for (
    let i = startLine + 1;
    i < lines.length && i - startLine <= MAX_TRAILER_LINES;
    i++
  ) {
    payload += "\n" + lines[i];
    if (hasBalancedObject(payload)) return { payload, endLine: i };
  }
  // Never balanced: don't swallow reply text — strip only the marker line.
  return { payload: single, endLine: startLine };
}

/**
 * Fourth net: free-form double-bracket note blobs. Teaching the model the
 * `[[reasoning]]` marker made it generalize "double brackets are my private
 * notes" — live replays showed replies carrying `[[The user wants to
 * schedule...]]` prose (no marker word, no JSON) straight into customer
 * text, which no marker or trailer-JSON matcher can see. No legitimate SMS
 * reply wraps prose in `[[...]]`, so every complete span is scrubbed
 * (multi-line included).
 */
const BRACKET_BLOB_PATTERN = /\[\[[\s\S]*?\]\]/g;

/**
 * Remove every `[[...]]` span, DEPTH-AWARE so a nested `[[a [[b]] c]]` is
 * removed in full (a non-greedy regex would stop at the inner `]]` and leak
 * the outer blob's tail). When the brackets never balance (a dangling `[[`
 * in otherwise-legitimate text), fall back to scrubbing only the complete
 * non-greedy spans so the dangling literal is not eaten to end-of-reply.
 */
function scrubBracketBlobs(text: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("[[", i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (depth > 0 && text.startsWith("]]", i)) {
      depth -= 1;
      i += 2;
      continue;
    }
    if (depth === 0) out += text[i];
    i += 1;
  }
  return depth === 0 ? out : text.replace(BRACKET_BLOB_PATTERN, "");
}

/**
 * Strip every trailer from the reply and parse the LAST one. A trailer
 * mid-line strips from its start to the end of that line (a model that glued
 * the trailer onto its last sentence keeps the sentence); a trailer whose
 * JSON spans multiple lines (pretty-printed / fenced) is stripped whole.
 * Lines are trailer-carrying when they hold a marker variant OR a bare
 * trailer JSON body (see TRAILER_JSON_PATTERN); free-form `[[...]]` note
 * blobs are scrubbed afterwards (see BRACKET_BLOB_PATTERN).
 */
export function splitReplyReasoning(raw: string): SplitReplyResult {
  if (!MARKER_PATTERN.test(raw) && !TRAILER_JSON_PATTERN.test(raw) && !raw.includes("[[")) {
    return { reply: raw, reasoning: null };
  }
  const lines = raw.split("\n");
  const keptLines: string[] = [];
  let reasoning: ReplyReasoning | null = null;
  let strippedAny = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let at = trailerCutIndex(line);
    if (at === -1 && bareObjectTrailerStart(lines, i)) at = line.indexOf("{");
    if (at === -1) {
      keptLines.push(line);
      continue;
    }
    strippedAny = true;
    const before = line.slice(0, at).trimEnd();
    if (before) keptLines.push(before);
    // parseTrailer scans for the outermost {...} span, so passing the cut
    // (marker/blob included) parses the same JSON for every variant.
    const gathered = gatherTrailerPayload(lines, i, at);
    const parsed = parseTrailer(gathered.payload);
    if (parsed) reasoning = parsed;
    i = gathered.endLine;
  }
  const kept = strippedAny ? keptLines.filter((l) => !FENCE_LINE_RE.test(l)) : keptLines;
  let reply = kept.join("\n");
  // Fourth net: free-form [[...]] private-note blobs (see pattern doc).
  if (reply.includes("[[")) {
    reply = scrubBracketBlobs(reply);
  }
  // Collapse the blanks the removed content leaves behind (both ends: a
  // leading [[...]] blob strips to an empty first line).
  reply = reply.replace(/^\n+/, "").replace(/\n+$/, "").trimEnd();
  return { reply, reasoning };
}
