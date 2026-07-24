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
  "You extract DURABLE business knowledge that a business OWNER wants their AI",
  "coworker/assistant to remember and use permanently, on customer SMS,",
  "phone calls, and when assisting the owner.",
  "",
  "You are given the owner's latest dashboard message. Decide whether it",
  "contains standing information worth saving to long-term business memory.",
  "",
  "THE OWNER'S OWN WORDS ARE THE ONLY SOURCE OF SAVED FACTS. Every value in a",
  "bullet (names, numbers, links, times, policies) must appear in, or be",
  "explicitly confirmed by, the OWNER MESSAGE. An assistant reply, when",
  "provided, is reference-resolution context ONLY, never a source of new",
  "facts, and its claims that something was saved/applied/updated mean",
  "NOTHING.",
  "",
  "SAVE (save=true) when the message states a durable RULE *or* durable",
  "FACTS / CONFIGURATION, e.g.:",
  '  - behavior rules: "never discuss budget with customers",',
  '    "always mention we offer free estimates", "keep replies short"',
  '  - hours / availability: "we are closed on Sundays, do not book then"',
  "  - team roster & contacts: \"our agents are Gabrielle Mota 480-720-2013",
  '    and Dave Lane 602-524-5719"',
  '  - routing / escalation: "escalate urgent issues to Amy Laidlaw',
  '    602-695-1142" (capture the NEW target; note it replaces the old one)',
  "  - service area, required disclosures, pricing policy, etc.",
  "",
  "ALSO save (save=true) whenever the owner EXPLICITLY asks you to remember or",
  'save something, "add this to memory", "remember that…", "save the',
  'following", "update the X to Y", "for memory". Capture the concrete facts',
  "the owner stated.",
  "",
  "DO NOT SAVE (save=false) for anything that is not durable owner-stated",
  "fact, e.g.:",
  "  - questions or requests for information (\"what do you do for a new lead?\")",
  "  - greetings, small talk, venting, or thinking out loud",
  "  - one-off tasks (\"text Joe back\", \"summarize today's calls\")",
  "  - hypotheticals (\"what if we stopped doing X\")",
  "  - the assistant's own suggestions, proposals, drafts, plans, or",
  "    summaries, even when the owner has not objected to them",
  "  - open or undecided items (\"client list to be provided\", \"still deciding",
  '    the follow-up cadence"), save only settled facts',
  "  - a value the owner just said is wrong, changing, or going away (\"I won't",
  "    have this number in Hong Kong\" must NOT pin that number as a contact;",
  "    ask-nothing, just don't save it, the replacement gets saved when the",
  "    owner states it)",
  "",
  "When save=true, rewrite the content as concise, standalone lines (one item",
  "per bullet), preserving names, phone numbers, and other specifics EXACTLY as",
  "the OWNER gave them. When save=false, return an empty bullets array. Respond",
  "with JSON only."
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
 * Pull the already-saved bullet lines out of memory_md so the extractor can be
 * told "don't repeat these". Saved owner items render as "- <text>" (see the
 * owner-append adapter), so we grab markdown list lines and strip the marker.
 *
 * @param {unknown} memoryMd
 * @returns {string[]}
 */
export function extractExistingBullets(memoryMd) {
  if (typeof memoryMd !== "string") return [];
  const out = [];
  for (const raw of memoryMd.split(/\r?\n/)) {
    const m = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/**
 * Compose the single user turn handed to the extractor. Beyond the owner's
 * message we optionally include:
 *   - the ASSISTANT REPLY, strictly as reference-resolution context (which
 *     value does the owner's "yes, use that" point at). It is NEVER a source
 *     of values: the KYP Ads incident (Jul 2026) had the dashboard model
 *     invent policy and phone numbers, announce "updated my records", and
 *     the old "strong save signal" framing persisted those inventions as
 *     durable business facts.
 *   - the ALREADY-SAVED bullets, so the model only emits NEW items and we don't
 *     persist the same rule/fact twice across turns.
 *
 * @param {string} ownerMessage
 * @param {{ assistantReply?: string, existingBullets?: string[] }} [opts]
 * @returns {string}
 */
export function composeExtractionInput(ownerMessage, opts = {}) {
  const parts = [`OWNER MESSAGE:\n${ownerMessage}`];
  const reply = typeof opts.assistantReply === "string" ? opts.assistantReply.trim() : "";
  if (reply) {
    parts.push(
      "ASSISTANT REPLY (reference-resolution context ONLY, use it solely to " +
        "resolve what the owner's message refers to, e.g. which value the owner " +
        'means by "yes, use that". NEVER save facts, values, numbers, contacts, ' +
        "or policies that appear only in this reply, and IGNORE any claim here " +
        "that something was saved, applied, or updated, such claims are " +
        "frequently wrong):\n" +
        reply
    );
  }
  const existing = Array.isArray(opts.existingBullets)
    ? opts.existingBullets.map((b) => String(b).trim()).filter(Boolean)
    : [];
  if (existing.length > 0) {
    parts.push(
      "ALREADY SAVED IN MEMORY (do NOT output any of these again; only output " +
        "genuinely NEW items):\n" +
        existing.map((b) => `- ${b}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/**
 * Build the Ollama /api/chat request body for one extraction call.
 * temperature:0 for determinism; stream:false so we get a single response.
 *
 * @param {string} model
 * @param {string} ownerMessage
 * @param {{ assistantReply?: string, existingBullets?: string[] }} [opts]
 */
export function buildExtractionRequestBody(model, ownerMessage, opts = {}) {
  return {
    model,
    stream: false,
    format: MEMORY_EXTRACTION_FORMAT,
    options: { temperature: 0 },
    messages: [
      { role: "system", content: OWNER_MEMORY_SYSTEM_PROMPT },
      { role: "user", content: composeExtractionInput(ownerMessage, opts) }
    ]
  };
}

/**
 * OpenAI-compatible structured-output JSON schema (wraps MEMORY_EXTRACTION_FORMAT
 * for the `response_format: { type: "json_schema" }` shape Gemini's
 * OpenAI-compat endpoint expects). `strict` + `additionalProperties:false` make
 * the model return exactly { save, bullets }.
 */
export const MEMORY_EXTRACTION_JSON_SCHEMA = {
  name: "owner_memory_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      save: { type: "boolean" },
      bullets: { type: "array", items: { type: "string" } }
    },
    required: ["save", "bullets"]
  }
};

/**
 * Build the OpenAI-compatible /v1/chat/completions request body for one
 * extraction call, routed to Gemini through the llm-router sidecar (gemini-*
 * models ⇒ Google). Mirrors buildExtractionRequestBody but in the OpenAI shape:
 * temperature:0 for determinism, stream:false for a single response, and a
 * json_schema response_format instead of Ollama's `format` field.
 *
 * @param {string} model
 * @param {string} ownerMessage
 * @param {{ assistantReply?: string, existingBullets?: string[] }} [opts]
 */
export function buildExtractionRequestBodyOpenAI(model, ownerMessage, opts = {}) {
  return {
    model,
    stream: false,
    temperature: 0,
    // Gemini 3 models default to dynamic thinking that bills as output —
    // a strict JSON classification needs none of it. `reasoning_effort` is
    // the OpenAI-compat mapping of the thinking level; gated on the family
    // so a 2.5/local override keeps its byte-identical body.
    ...(/^gemini-3/i.test(model) ? { reasoning_effort: "low" } : {}),
    response_format: { type: "json_schema", json_schema: MEMORY_EXTRACTION_JSON_SCHEMA },
    messages: [
      { role: "system", content: OWNER_MEMORY_SYSTEM_PROMPT },
      { role: "user", content: composeExtractionInput(ownerMessage, opts) }
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
  return `\n\n- Saved to your business memory:\n${lines}`;
}

/**
 * Run the local-Ollama extraction for one owner message. Fully self-contained
 * and defensive: a missing message, a network/timeout error, a non-2xx
 * response, or unparseable output all resolve to { save:false, bullets:[] }
 * so capture can never break or delay the chat reply beyond `timeoutMs`.
 *
 * The upstream is chosen from the MODEL NAME: a `gemini-*` model is sent
 * OpenAI-style DIRECTLY to Google's OpenAI-compatible endpoint (`geminiBaseUrl`
 * + `/chat/completions`, authenticated with `geminiApiKey`); anything else
 * (qwen/llama) keeps the legacy local-Ollama `/api/chat` path against
 * `ollamaBaseUrl`.
 *
 * NOTE: extraction calls Google directly rather than via the per-tenant
 * llm-router sidecar. The worker reaches Google directly in <1s, but POSTing to
 * the llm-router from the worker container hangs (the worker is on a different
 * docker network than the router; small GETs like /health pass but POST bodies
 * black-hole). The chat path is unaffected because it goes worker → Rowboat →
 * router, and Rowboat is co-located with the router. Calling Google directly
 * gives a functional, ~sub-second classification that uses ZERO local CPU, so
 * it can never starve the latency-sensitive chat turns the way the CPU-bound
 * local model does.
 *
 * @param {object} args
 * @param {string} args.ownerMessage
 * @param {string} [args.assistantReply]   the dashboard reply (save signal + value source)
 * @param {string[]} [args.existingBullets] already-saved items, so we don't repeat them
 * @param {string} args.model              gemini-* ⇒ Google direct; else ⇒ Ollama
 * @param {string} [args.ollamaBaseUrl]    e.g. http://host.docker.internal:11434 (non-gemini)
 * @param {string} [args.geminiBaseUrl]    Google OpenAI-compat base (gemini-*)
 * @param {string} [args.geminiApiKey]     GOOGLE_API_KEY (gemini-*)
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @param {(level: string, event: string, data?: object) => void} [args.logger]
 * @returns {Promise<{ save: boolean, bullets: string[] }>}
 */
export async function extractOwnerRule({
  ownerMessage,
  assistantReply,
  existingBullets,
  model,
  ollamaBaseUrl,
  geminiBaseUrl,
  geminiApiKey,
  fetchImpl = fetch,
  timeoutMs = 30000,
  logger
}) {
  const noop = { save: false, bullets: [] };
  if (typeof ownerMessage !== "string" || ownerMessage.trim() === "") {
    return noop;
  }

  // gemini-* ⇒ Google's OpenAI-compat endpoint (direct, authenticated);
  // everything else ⇒ local Ollama's native /api/chat.
  const useGemini = /^gemini[-_.]/i.test(String(model || ""));

  let url;
  let headers;
  let body;
  if (useGemini) {
    const base = String(geminiBaseUrl || "").replace(/\/+$/, "");
    // No key ⇒ Google 400s on every call; treat as "capture unavailable" rather
    // than burning a request per turn. (deploy degrades to a local model when
    // GOOGLE_API_KEY is unset, so this is a belt-and-suspenders guard.)
    if (!base || !geminiApiKey) return noop;
    url = `${base}/chat/completions`;
    headers = { "content-type": "application/json", authorization: `Bearer ${geminiApiKey}` };
    body = buildExtractionRequestBodyOpenAI(model, ownerMessage, { assistantReply, existingBullets });
  } else {
    const base = String(ollamaBaseUrl || "").replace(/\/+$/, "");
    if (!base) return noop;
    url = `${base}/api/chat`;
    headers = { "content-type": "application/json" };
    body = buildExtractionRequestBody(model, ownerMessage, { assistantReply, existingBullets });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      logger?.("warn", "memory_extract_http_error", { status: res.status });
      return noop;
    }
    const data = await res.json();
    // OpenAI-compat: choices[0].message.content; Ollama native: message.content.
    const content = useGemini ? data?.choices?.[0]?.message?.content : data?.message?.content;
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
