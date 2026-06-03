// Server-side owner-rule capture for the dashboard chat worker.
//
// Why this exists: the dashboard "OwnerCoworker" agent was supposed to call a
// Rowboat tool (owner_append_business_memory) whenever the owner stated a
// durable business rule ("never discuss budget with customers"). In practice
// that path never persisted anything — Rowboat treats tools without a bound
// project-level webhookUrl as MOCKS, so the tool silently no-op'd, and the
// small per-tenant model (qwen3:4b) frequently hallucinated "saved!" without
// emitting any tool call at all. Owners lost rules and got lied to about it.
//
// The fix moves rule capture OUT of the unreliable in-agent tool call and INTO
// the worker: every owner turn, we run a tiny local-Ollama extraction over the
// owner's message ("is this a durable business rule? if so, as bullets"), and
// if it is, POST it to the already-proven platform adapter
// (/api/voice/tools/owner-append-business-memory) which writes memory_md and
// triggers a vault sync. The worker then appends an HONEST confirmation to the
// reply only when the save actually succeeded.
//
// Everything here is dependency-injected (fetch, logger, timers) and free of
// process.env / network side effects at import time so it can be unit-tested.

/**
 * System prompt for the extraction model. Deliberately strict: we want a
 * high bar for `save: true` so casual chatter, questions, and one-off task
 * requests don't pollute the business memory. The model only ever emits the
 * JSON shape enforced by MEMORY_EXTRACTION_FORMAT.
 */
export const OWNER_MEMORY_SYSTEM_PROMPT = [
  "You extract DURABLE, business-wide rules that a business OWNER wants their",
  "AI receptionist to follow permanently on customer SMS and phone calls.",
  "",
  "You are given the owner's latest dashboard message. Decide whether it states",
  "such a standing rule or preference.",
  "",
  "SAVE (save=true) only for lasting instructions about how the assistant should",
  "behave with customers, e.g.:",
  '  - "never discuss budget or pricing with customers"',
  '  - "always mention we offer free estimates"',
  '  - "we are closed on Sundays, do not book then"',
  '  - "keep replies short and friendly"',
  "",
  "DO NOT SAVE (save=false) for anything that is not a durable rule, e.g.:",
  "  - questions or requests for information",
  "  - greetings, small talk, venting, or thinking out loud",
  "  - one-off tasks (\"text Joe back\", \"summarize today's calls\")",
  "  - hypotheticals (\"what if we stopped doing X\")",
  "",
  "When save=true, rewrite the rule(s) as concise, standalone, imperative lines",
  "(one rule per bullet). When save=false, return an empty bullets array.",
  "Respond with JSON only."
].join("\n");

/**
 * JSON schema handed to Ollama's `format` field so /api/chat returns a
 * machine-parseable object instead of prose. Supported by Ollama >= 0.5
 * structured outputs (KVM hosts run 0.22+).
 */
export const MEMORY_EXTRACTION_FORMAT = {
  type: "object",
  properties: {
    save: { type: "boolean" },
    bullets: { type: "array", items: { type: "string" } }
  },
  required: ["save", "bullets"]
};

// Channel markers the dashboard route prepends to the user turn
// (src/app/api/dashboard/chat/route.ts builds "[Dashboard] <message>").
const CHANNEL_MARKER_RE = /^\[(?:Dashboard|SMS|Call)\]\s+/;

const MAX_BULLETS = 10;
const MAX_BULLET_LEN = 280;

// Hard cap on the newline-joined `args.bullets` string the owner-append
// adapter accepts (BULLETS_MAX_CHARS in
// src/app/api/voice/tools/owner-append-business-memory/route.ts). We bound the
// payload on this side so a large extraction degrades to "save the first N
// rules that fit" instead of a silent HTTP 400 (which would drop the whole
// save with no confirmation).
export const ADAPTER_BULLETS_MAX_CHARS = 2000;

/**
 * Pull the owner's most recent raw message out of a job's input_messages.
 * The route stores the live turn as the LAST role:"user" entry, prefixed
 * with a "[Dashboard] " channel marker which we strip here so the extractor
 * sees exactly what the owner typed.
 *
 * @param {Array<{role?: string, content?: unknown}>|null|undefined} inputMessages
 * @returns {string} the owner's message, or "" when none is present.
 */
export function extractLatestOwnerMessage(inputMessages) {
  if (!Array.isArray(inputMessages)) return "";
  for (let i = inputMessages.length - 1; i >= 0; i--) {
    const m = inputMessages[i];
    if (m && m.role === "user" && typeof m.content === "string") {
      return m.content.replace(CHANNEL_MARKER_RE, "").trim();
    }
  }
  return "";
}

/**
 * Normalize raw model bullets into clean, deduped, bounded rule lines.
 * Strips leading list punctuation, collapses whitespace, drops empties and
 * case-insensitive duplicates, and caps both count and length so a confused
 * model can't write an unbounded blob into the owner's memory.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeBullets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item
      .replace(/^\s*[-*•]\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_BULLET_LEN);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

/**
 * Parse the extraction model's JSON content into a safe { save, bullets }
 * result. Accepts either a JSON string or an already-parsed object. ANY
 * malformed / unexpected input degrades to { save:false, bullets:[] } — a
 * capture miss is always preferable to a crash or a bogus write.
 *
 * @param {unknown} content
 * @returns {{ save: boolean, bullets: string[] }}
 */
export function parseMemoryExtraction(content) {
  let obj = content;
  if (typeof content === "string") {
    try {
      obj = JSON.parse(content);
    } catch {
      return { save: false, bullets: [] };
    }
  }
  if (!obj || typeof obj !== "object") return { save: false, bullets: [] };
  const bullets = normalizeBullets(obj.bullets);
  // Only honor a save when the model both flags it AND gives us at least one
  // usable bullet; "save:true, bullets:[]" is treated as no-op.
  const save = obj.save === true && bullets.length > 0;
  return { save, bullets: save ? bullets : [] };
}

/**
 * Build the Ollama /api/chat request body for one extraction call.
 * temperature:0 for determinism; stream:false so we get a single response.
 *
 * @param {string} model
 * @param {string} ownerMessage
 */
export function buildExtractionRequestBody(model, ownerMessage) {
  return {
    model,
    stream: false,
    format: MEMORY_EXTRACTION_FORMAT,
    options: { temperature: 0 },
    messages: [
      { role: "system", content: OWNER_MEMORY_SYSTEM_PROMPT },
      { role: "user", content: ownerMessage }
    ]
  };
}

/**
 * Take the longest prefix of `bullets` whose newline-joined form fits within
 * `maxChars`, so the adapter never rejects an over-long payload. If even the
 * first bullet exceeds the budget it is truncated to fit. Returns the bullets
 * actually kept (which the caller should also use for the confirmation, so the
 * owner is only told about rules that were really saved).
 *
 * @param {string[]} bullets
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function fitBulletsToPayload(bullets, maxChars = ADAPTER_BULLETS_MAX_CHARS) {
  if (!Array.isArray(bullets)) return [];
  const kept = [];
  let len = 0;
  for (const b of bullets) {
    if (typeof b !== "string") continue;
    const addedLen = (kept.length === 0 ? 0 : 1) + b.length; // +1 for the "\n"
    if (len + addedLen > maxChars) {
      if (kept.length === 0) kept.push(b.slice(0, maxChars));
      break;
    }
    kept.push(b);
    len += addedLen;
  }
  return kept;
}

/**
 * Render the honest "saved" confirmation appended to the assistant reply.
 * Only ever called by the worker AFTER the platform adapter confirmed the
 * write, so the owner never sees this line for a save that didn't happen.
 *
 * @param {string[]} bullets
 * @returns {string}
 */
export function formatSavedConfirmation(bullets) {
  const lines = bullets.map((b) => `• ${b}`).join("\n");
  return `\n\n— Saved to your business memory:\n${lines}`;
}

/**
 * Run the local-Ollama extraction for one owner message. Fully self-contained
 * and defensive: a missing message, a network/timeout error, a non-2xx
 * response, or unparseable output all resolve to { save:false, bullets:[] }
 * so capture can never break or delay the chat reply beyond `timeoutMs`.
 *
 * @param {object} args
 * @param {string} args.ownerMessage
 * @param {string} args.model
 * @param {string} args.ollamaBaseUrl  e.g. http://host.docker.internal:11434
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @param {(level: string, event: string, data?: object) => void} [args.logger]
 * @returns {Promise<{ save: boolean, bullets: string[] }>}
 */
export async function extractOwnerRule({
  ownerMessage,
  model,
  ollamaBaseUrl,
  fetchImpl = fetch,
  timeoutMs = 30000,
  logger
}) {
  const noop = { save: false, bullets: [] };
  if (typeof ownerMessage !== "string" || ownerMessage.trim() === "") {
    return noop;
  }
  const base = String(ollamaBaseUrl || "").replace(/\/+$/, "");
  if (!base) return noop;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExtractionRequestBody(model, ownerMessage)),
      signal: controller.signal
    });
    if (!res.ok) {
      logger?.("warn", "memory_extract_http_error", { status: res.status });
      return noop;
    }
    const data = await res.json();
    const content = data?.message?.content;
    return parseMemoryExtraction(content);
  } catch (err) {
    logger?.("warn", "memory_extract_failed", {
      error: err?.message || String(err)
    });
    return noop;
  } finally {
    clearTimeout(timer);
  }
}
