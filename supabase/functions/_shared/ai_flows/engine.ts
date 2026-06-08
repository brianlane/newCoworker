/**
 * AiFlows pure engine: trigger evaluation, template rendering, and
 * field-extraction helpers. Dependency-free so it runs identically in the Deno
 * ai-flow-worker and the telnyx-sms-inbound trigger hook, and is fully unit
 * tested (counts toward the _shared coverage gate).
 *
 * Everything here is PURE (no IO). Network/DB effects live in the worker
 * (supabase/functions/ai-flow-worker/index.ts), which calls these helpers to
 * decide what to do and to transform fetched page text.
 */
import { AI_FLOW_DEFINITION_VERSION } from "./types.ts";
import type {
  AiFlowDefinition,
  CorrelationMessage,
  SmsTrigger,
  StepCondition,
  TriggerCondition,
  TriggerContext,
  TriggerResult
} from "./types.ts";

export const DEFAULT_CORRELATION_WINDOW_MINUTES = 10;

const URL_RE = /https?:\/\/[^\s<>"')]+/i;
const URL_RE_GLOBAL = /https?:\/\/[^\s<>"')]+/gi;

/** First http(s) URL in a string, or null. Trailing punctuation is trimmed. */
export function firstUrlInText(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return trimUrlPunctuation(m[0]);
}

/** All http(s) URLs in a string (de-duplicated, order preserved). */
export function allUrlsInText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(URL_RE_GLOBAL) ?? [];
  for (const raw of matches) {
    const u = trimUrlPunctuation(raw);
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** Strip common trailing punctuation that gets glued onto URLs in prose. */
function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/** Case-control substring test. */
function textContains(haystack: string, needle: string, caseInsensitive?: boolean): boolean {
  if (caseInsensitive === false) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Safe regex test — an invalid pattern never throws, it just fails to match. */
export function safeRegexTest(pattern: string, value: string, caseInsensitive?: boolean): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive === false ? "" : "i");
  } catch {
    return false;
  }
  return re.test(value);
}

/**
 * Messages within the correlation window (>= now - windowMinutes), oldest
 * first. Messages with an atMs in the future relative to `nowMs` are kept
 * (clock skew tolerance); only those strictly older than the window are dropped.
 */
export function messagesInWindow(ctx: TriggerContext, windowMinutes: number): CorrelationMessage[] {
  const now = ctx.nowMs ?? Date.now();
  const cutoff = now - Math.max(0, windowMinutes) * 60_000;
  return ctx.messages.filter((m) => m.atMs >= cutoff);
}

/** Evaluate one condition against the combined window text + latest sender. */
function evaluateCondition(
  cond: TriggerCondition,
  windowText: string,
  latestFrom: string
): boolean {
  switch (cond.type) {
    case "contains":
      return textContains(windowText, cond.value, cond.caseInsensitive);
    case "regex":
      return safeRegexTest(cond.value, windowText, cond.caseInsensitive);
    case "has_url":
      return firstUrlInText(windowText) !== null;
    case "from_matches":
      return textContains(latestFrom, cond.value, cond.caseInsensitive);
    /* c8 ignore next 2 -- exhaustive switch; unreachable for valid conditions */
    default:
      return false;
  }
}

/**
 * Evaluate an SMS trigger over the correlation window. Returns matched +
 * windowText + first URL. All conditions must pass (AND). An empty condition
 * list matches any inbound SMS.
 */
export function evaluateSmsTrigger(trigger: SmsTrigger, ctx: TriggerContext): TriggerResult {
  const windowMinutes = trigger.correlationWindowMinutes ?? DEFAULT_CORRELATION_WINDOW_MINUTES;
  const inWindow = messagesInWindow(ctx, windowMinutes);
  const windowText = inWindow.map((m) => m.text).join("\n");
  const latestFrom = inWindow.length > 0 ? inWindow[inWindow.length - 1].from : "";
  const url = firstUrlInText(windowText);
  const matched = trigger.conditions.every((c) => evaluateCondition(c, windowText, latestFrom));
  return { matched, windowText, url };
}

// --- Template rendering ------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Resolve a dotted path (e.g. "vars.seller_phone") against a scope object. */
export function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Replace {{path}} placeholders in a template string with values from `scope`.
 * Missing/object/null values render as the empty string so a half-populated
 * context never injects "undefined" or "[object Object]" into an outbound SMS.
 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_full, path: string) => {
    const v = resolvePath(scope, path);
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  });
}

/**
 * Evaluate a per-step `when` guard against the run vars. Returns true when the
 * step should RUN. `equals` is a whole-value match, `contains` is a substring;
 * both are case-insensitive unless `caseInsensitive === false`. String values
 * are trimmed first, since LLM-extracted vars often carry surrounding whitespace
 * or newlines that would otherwise make an `equals` guard silently miss. A
 * missing / non-scalar var resolves to "" so an absent value never accidentally
 * matches a non-empty needle. When neither `equals` nor `contains` is set (the
 * schema normally forbids this), the guard is a presence check: pass iff the var
 * is non-empty.
 */
export function evaluateStepCondition(
  cond: StepCondition,
  scope: { vars?: Record<string, unknown> }
): boolean {
  const raw = scope.vars?.[cond.var];
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : "";
  const ci = cond.caseInsensitive !== false;
  const hay = ci ? value.toLowerCase() : value;
  if (cond.equals !== undefined) {
    return hay === (ci ? cond.equals.toLowerCase() : cond.equals);
  }
  if (cond.contains !== undefined) {
    return hay.includes(ci ? cond.contains.toLowerCase() : cond.contains);
  }
  return value.length > 0;
}

/** True when a template still has unresolved placeholders against `scope`. */
export function hasUnresolvedPlaceholders(template: string, scope: Record<string, unknown>): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const v = resolvePath(scope, m[1]);
    if (v === null || v === undefined || v === "") return true;
  }
  return false;
}

// --- Phone / field extraction ------------------------------------------------

const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

/**
 * Normalize a loose North-American phone string to E.164 (+1XXXXXXXXXX), or
 * null if it is not a plausible 10-digit (optionally +1) number.
 */
export function normalizeNanpToE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Extract candidate phone numbers from free text as E.164 (deduped, in order). */
export function extractPhones(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(PHONE_RE) ?? [];
  for (const raw of matches) {
    const e164 = normalizeNanpToE164(raw);
    /* c8 ignore next -- PHONE_RE only matches 10/11-digit numbers, which always normalize */
    if (!e164) continue;
    if (seen.has(e164)) continue;
    seen.add(e164);
    out.push(e164);
  }
  return out;
}

/**
 * Build the Gemini extraction prompt: ask for a strict JSON object with exactly
 * the requested field names, from the provided page text. Page text is truncated
 * to keep the prompt bounded.
 */
export function buildExtractionPrompt(
  fields: { name: string; description?: string }[],
  pageText: string,
  maxChars = 12_000
): string {
  const fieldLines = fields
    .map((f) => `- ${f.name}${f.description ? `: ${f.description}` : ""}`)
    .join("\n");
  const clipped = pageText.length > maxChars ? pageText.slice(0, maxChars) : pageText;
  return [
    "Extract the following fields from the web page content below.",
    "Return ONLY a JSON object whose keys are exactly these field names.",
    'If a field is not present, use an empty string "". Do not invent values.',
    "",
    "Fields:",
    fieldLines,
    "",
    "Page content:",
    clipped
  ].join("\n");
}

/**
 * Parse a Gemini extraction response into a flat string map limited to the
 * declared field names. Tolerates fenced code blocks and surrounding prose by
 * scanning for the first JSON object. Unknown keys are dropped; missing keys
 * become "". Never throws.
 */
export function parseExtractionJson(
  raw: string,
  fields: { name: string }[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of fields) result[f.name] = "";
  const obj = extractFirstJsonObject(raw);
  if (!obj) return result;
  for (const f of fields) {
    const v = obj[f.name];
    if (typeof v === "string") result[f.name] = v;
    else if (typeof v === "number" || typeof v === "boolean") result[f.name] = String(v);
  }
  return result;
}

/** Find and parse the first balanced JSON object in a string. Null on failure. */
function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
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
      if (depth === 0) {
        // A balanced `{...}` slice parses to a plain object or throws, so no
        // array/non-object guard is needed past the catch.
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Collapse fetched HTML/markup to readable text for extraction: strip script /
 * style blocks and tags, decode a few common entities, and squeeze whitespace.
 * Deliberately simple (no DOM) — good enough to feed an LLM or a phone regex.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Decode &amp; LAST so a sequence like "&amp;lt;" does not get
    // double-unescaped into "<" (CodeQL js/double-escaping).
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runtime guard the worker runs before executing a stored definition (the rich
 * authoring validation lives in src/lib/ai-flows/schema.ts). Confirms the basic
 * shape so a corrupt/legacy row fails fast as `failed` rather than throwing deep
 * in a step.
 */
export function isExecutableDefinition(def: unknown): def is AiFlowDefinition {
  if (!def || typeof def !== "object") return false;
  const d = def as Record<string, unknown>;
  if (d.version !== AI_FLOW_DEFINITION_VERSION) return false;
  const trigger = d.trigger as Record<string, unknown> | undefined;
  if (!trigger || trigger.channel !== "sms" || !Array.isArray(trigger.conditions)) return false;
  if (!Array.isArray(d.steps)) return false;
  for (const s of d.steps) {
    if (!s || typeof s !== "object") return false;
    const step = s as Record<string, unknown>;
    if (typeof step.type !== "string" || typeof step.id !== "string") return false;
  }
  return true;
}
