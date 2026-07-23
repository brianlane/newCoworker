/**
 * Dashboard-chat email tool — platform-side EMAIL_SEND block handling.
 *
 * The owner-chat model is taught a deterministic sentinel-block protocol
 * (see EMAIL_TOOL_ENABLED_PREAMBLE in the chat route): it emits
 *
 *   <<EMAIL_SEND>>
 *   {"to": "x@y.com", "subject": "...", "body": "...", "cc": [...], "bcc": [...]}
 *   <<END_EMAIL_SEND>>
 *
 * and the executing side extracts the blocks, sends each one, strips the raw
 * JSON from the visible reply, and appends HONEST per-email delivery lines.
 * The VPS chat-worker fulfils this via the gateway-authed platform adapter
 * (vps/chat-worker/email-tool.mjs); this module is the TypeScript mirror for
 * the INLINE (platform-Gemini) turn path, which can call the send stack
 * directly. Parsing/normalization semantics MUST stay in lockstep with:
 *   - vps/chat-worker/email-tool.mjs (the worker-side twin)
 *   - src/app/api/voice/tools/dashboard-email/route.ts (zod field caps)
 */

export const EMAIL_SEND_OPEN = "<<EMAIL_SEND>>";
export const EMAIL_SEND_CLOSE = "<<END_EMAIL_SEND>>";

export const MAX_EMAILS_PER_TURN = 3;
export const SUBJECT_MAX_CHARS = 150;
export const BODY_MAX_CHARS = 4000;
/** Cap cc (and, separately, bcc) recipients so a runaway model can't blast mail. */
export const MAX_CC_BCC_RECIPIENTS = 10;

// Pragmatic RFC-5322-ish check, same strictness class as zod's z.string().email().
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailSendRequest = {
  to: string;
  subject: string;
  body: string;
  cc: string[];
  bcc: string[];
};

export type EmailSendOutcome = {
  ok: boolean;
  to: string;
  subject: string;
  /** Machine detail on failure (tool_disabled, email_not_connected, …). */
  detail?: string;
};

/**
 * Normalize a cc/bcc value (array of strings or a comma/semicolon/whitespace
 * separated string) into a de-duplicated, capped array of valid addresses.
 */
function parseRecipients(value: unknown): string[] {
  let parts: string[] = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string") parts = parts.concat(v.split(/[,;\s]+/));
    }
  } else if (typeof value === "string") {
    parts = value.split(/[,;\s]+/);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const addr = part.trim().toLowerCase();
    if (!addr || seen.has(addr) || !EMAIL_RE.test(addr)) continue;
    seen.add(addr);
    out.push(addr);
    if (out.length >= MAX_CC_BCC_RECIPIENTS) break;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEmailRequest(inner: string): EmailSendRequest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(inner.trim());
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  // The prompt teaches {to, subject, body}; accept the adapter's field names
  // as aliases so a model that echoes the wire shape still works.
  const to =
    typeof rec.to === "string" ? rec.to : typeof rec.toEmail === "string" ? rec.toEmail : "";
  const subject = typeof rec.subject === "string" ? rec.subject.trim() : "";
  const body =
    typeof rec.body === "string" ? rec.body : typeof rec.bodyText === "string" ? rec.bodyText : "";
  const toTrimmed = to.trim();
  if (!EMAIL_RE.test(toTrimmed)) return null;
  if (subject.length < 1 || subject.length > SUBJECT_MAX_CHARS) return null;
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.length < 1 || bodyTrimmed.length > BODY_MAX_CHARS) return null;
  return {
    to: toTrimmed,
    subject,
    body: bodyTrimmed,
    cc: parseRecipients(rec.cc),
    bcc: parseRecipients(rec.bcc)
  };
}

/**
 * Extract every EMAIL_SEND block from an assistant reply. Returns the reply
 * with all blocks (and any code fences immediately wrapping them) removed,
 * the validated requests in order, and a count of malformed blocks.
 */
export function extractEmailSendRequests(content: string): {
  cleanedContent: string;
  requests: EmailSendRequest[];
  invalidCount: number;
} {
  if (typeof content !== "string" || content.indexOf(EMAIL_SEND_OPEN) === -1) {
    return {
      cleanedContent: typeof content === "string" ? content : "",
      requests: [],
      invalidCount: 0
    };
  }

  const requests: EmailSendRequest[] = [];
  let invalidCount = 0;

  const blockRe = new RegExp(
    "(?:```[a-zA-Z]*\\s*)?" +
      escapeRegExp(EMAIL_SEND_OPEN) +
      "([\\s\\S]*?)" +
      escapeRegExp(EMAIL_SEND_CLOSE) +
      "(?:\\s*```)?",
    "g"
  );

  const cleanedContent = content
    .replace(blockRe, (_match, inner: string) => {
      const parsed = parseEmailRequest(inner);
      if (parsed) requests.push(parsed);
      else invalidCount += 1;
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // A dangling OPEN with no CLOSE (truncated generation) — strip from the
  // marker to the end so half a JSON object never reaches the owner.
  const dangling = cleanedContent.indexOf(EMAIL_SEND_OPEN);
  if (dangling !== -1) {
    invalidCount += 1;
    return {
      cleanedContent: cleanedContent.slice(0, dangling).trim(),
      requests,
      invalidCount
    };
  }

  return { cleanedContent, requests, invalidCount };
}

/** Human-readable, honest delivery line for one send outcome. */
export function describeEmailOutcome(result: EmailSendOutcome): string {
  const target = `Email to ${result.to}${result.subject ? ` ("${result.subject}")` : ""}`;
  if (result.ok) {
    return `${target}: sent from your connected mailbox.`;
  }
  switch (result.detail) {
    case "tool_disabled":
      return `${target}: NOT sent, the Send email tool is turned off (enable it under Settings → Coworker tools).`;
    case "email_not_connected":
      return `${target}: NOT sent, no email account is connected (connect one under Integrations).`;
    case "too_many_emails":
      return `${target}: NOT sent, at most ${MAX_EMAILS_PER_TURN} emails per reply; please ask again separately.`;
    case "invalid_block":
      return `${target}: NOT sent, the email request was malformed; please rephrase and try again.`;
    default:
      return `${target}: NOT sent, sending failed (${result.detail || "unknown error"}). Please try again.`;
  }
}

/** Append delivery-result lines to the cleaned reply. */
export function appendEmailResults(cleanedContent: string, results: EmailSendOutcome[]): string {
  if (results.length === 0) return cleanedContent;
  const lines = results.map((r) => describeEmailOutcome(r));
  const base = (cleanedContent || "").trim();
  const sep = base.length > 0 ? "\n\n---\n" : "";
  return `${base}${sep}${lines.join("\n")}`;
}

/**
 * Full pipeline for one assistant reply on the INLINE path: extract blocks,
 * send each through the injected sender (bounded by MAX_EMAILS_PER_TURN,
 * sequential to preserve intent order), and return the owner-visible reply
 * with honest results appended. Never throws; with no blocks present it
 * returns the reply unchanged.
 */
export async function fulfillEmailBlocks(args: {
  content: string;
  /** Executes one send; resolves to the outcome (never throws). */
  send: (request: EmailSendRequest) => Promise<{ ok: boolean; detail?: string }>;
}): Promise<{ content: string; sentCount: number; failedCount: number }> {
  const { cleanedContent, requests, invalidCount } = extractEmailSendRequests(args.content);
  if (requests.length === 0 && invalidCount === 0) {
    return { content: args.content, sentCount: 0, failedCount: 0 };
  }

  const results: EmailSendOutcome[] = [];
  for (let i = 0; i < invalidCount; i++) {
    results.push({ ok: false, to: "(unparsed request)", subject: "", detail: "invalid_block" });
  }
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    if (i >= MAX_EMAILS_PER_TURN) {
      results.push({ ok: false, to: request.to, subject: request.subject, detail: "too_many_emails" });
      continue;
    }
    let outcome: { ok: boolean; detail?: string };
    try {
      outcome = await args.send(request);
    } catch (err) {
      outcome = { ok: false, detail: err instanceof Error ? err.message : "send_failed" };
    }
    results.push({
      ok: outcome.ok,
      to: request.to,
      subject: request.subject,
      ...(outcome.ok ? {} : { detail: outcome.detail ?? "send_failed" })
    });
  }

  return {
    content: appendEmailResults(cleanedContent, results),
    sentCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length
  };
}
