// Dashboard-chat email tool: parse + fulfil EMAIL_SEND blocks.
//
// The owner-chat agent has no Rowboat tool execution path (the worker calls
// /chat non-streaming and only reads assistant text), so "send an email" is
// implemented as a deterministic sentinel-block protocol: the enqueue route
// teaches the model to emit
//
//   <<EMAIL_SEND>>
//   {"to": "x@y.com", "subject": "...", "body": "...", "cc": [...], "bcc": [...]}
//   <<END_EMAIL_SEND>>
//
// (cc/bcc are optional arrays of addresses; capped + validated like `to`.)
//
// and this module extracts those blocks from the reply, POSTs each one to the
// platform adapter (/api/voice/tools/dashboard-email — gateway-token authed,
// re-checks the Settings toggle authoritatively, sends via the owner's Nango
// mailbox), strips the raw blocks from the visible reply, and appends an
// HONEST per-email delivery result. The model is explicitly told never to
// claim an email was sent — only the lines appended here report outcomes.
//
// MUST stay in lockstep with:
//   - src/app/api/dashboard/chat/route.ts (EMAIL_SEND_OPEN/CLOSE + prompt)
//   - src/app/api/voice/tools/dashboard-email/route.ts (zod field caps)

export const EMAIL_SEND_OPEN = "<<EMAIL_SEND>>";
export const EMAIL_SEND_CLOSE = "<<END_EMAIL_SEND>>";

export const MAX_EMAILS_PER_TURN = 3;
export const SUBJECT_MAX_CHARS = 150;
export const BODY_MAX_CHARS = 4000;
// Cap cc (and, separately, bcc) recipients so a runaway model can't blast mail.
export const MAX_CC_BCC_RECIPIENTS = 10;

// Pragmatic RFC-5322-ish check, same strictness class as zod's z.string().email().
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize a cc/bcc value (array of strings or a comma/semicolon/whitespace
 * separated string) into a de-duplicated, capped array of valid addresses.
 * Mirrors src/lib/email/recipients.ts so every surface behaves identically.
 */
function parseRecipients(value) {
  let parts = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string") parts = parts.concat(v.split(/[,;\s]+/));
    }
  } else if (typeof value === "string") {
    parts = value.split(/[,;\s]+/);
  }
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const addr = part.trim().toLowerCase();
    if (!addr || seen.has(addr) || !EMAIL_RE.test(addr)) continue;
    seen.add(addr);
    out.push(addr);
    if (out.length >= MAX_CC_BCC_RECIPIENTS) break;
  }
  return out;
}

/**
 * Extract every EMAIL_SEND block from an assistant reply.
 *
 * Returns:
 *   cleanedContent — the reply with all blocks (and any code fences that
 *                    immediately wrapped them) removed; never shows raw JSON.
 *   requests       — validated { to, subject, body } objects, in order.
 *   invalidCount   — blocks that failed JSON parsing / validation.
 */
export function extractEmailSendRequests(content) {
  if (typeof content !== "string" || content.indexOf(EMAIL_SEND_OPEN) === -1) {
    return { cleanedContent: typeof content === "string" ? content : "", requests: [], invalidCount: 0 };
  }

  const requests = [];
  let invalidCount = 0;

  // Match optional surrounding code fences the model may add despite the
  // prompt (```json\n<<EMAIL_SEND>>…<<END_EMAIL_SEND>>\n```), so stripping
  // the block doesn't leave empty fences behind.
  const blockRe = new RegExp(
    "(?:```[a-zA-Z]*\\s*)?" +
      escapeRegExp(EMAIL_SEND_OPEN) +
      "([\\s\\S]*?)" +
      escapeRegExp(EMAIL_SEND_CLOSE) +
      "(?:\\s*```)?",
    "g"
  );

  const cleanedContent = content
    .replace(blockRe, (_match, inner) => {
      const parsed = parseEmailRequest(inner);
      if (parsed) requests.push(parsed);
      else invalidCount += 1;
      return "";
    })
    // Collapse the whitespace holes the removed blocks leave behind.
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEmailRequest(inner) {
  let obj;
  try {
    obj = JSON.parse(String(inner).trim());
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  // The prompt teaches {to, subject, body}; accept the adapter's field names
  // as aliases so a model that echoes the wire shape still works.
  const to = typeof obj.to === "string" ? obj.to : typeof obj.toEmail === "string" ? obj.toEmail : "";
  const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
  const body =
    typeof obj.body === "string" ? obj.body : typeof obj.bodyText === "string" ? obj.bodyText : "";
  const toTrimmed = to.trim();
  if (!EMAIL_RE.test(toTrimmed)) return null;
  if (subject.length < 1 || subject.length > SUBJECT_MAX_CHARS) return null;
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.length < 1 || bodyTrimmed.length > BODY_MAX_CHARS) return null;
  const cc = parseRecipients(obj.cc);
  const bcc = parseRecipients(obj.bcc);
  return { to: toTrimmed, subject, body: bodyTrimmed, cc, bcc };
}

/**
 * Human-readable, honest delivery line for one send outcome. `detail` is the
 * adapter's machine detail (tool_disabled, email_not_connected, …) or one of
 * the worker-local sentinels (too_many_emails, adapter_unreachable,
 * not_configured, invalid_block).
 */
export function describeEmailOutcome(result) {
  const target = `Email to ${result.to}${result.subject ? ` ("${result.subject}")` : ""}`;
  if (result.ok) {
    return `${target}: sent from your connected mailbox.`;
  }
  switch (result.detail) {
    case "tool_disabled":
      return `${target}: NOT sent — the Send email tool is turned off (enable it under Settings → Coworker tools).`;
    case "email_not_connected":
      return `${target}: NOT sent — no email account is connected (connect one under Integrations).`;
    case "too_many_emails":
      return `${target}: NOT sent — at most ${MAX_EMAILS_PER_TURN} emails per reply; please ask again separately.`;
    case "not_configured":
      return `${target}: NOT sent — email sending isn't configured on this server.`;
    case "invalid_block":
      return `${target}: NOT sent — the email request was malformed; please rephrase and try again.`;
    default:
      return `${target}: NOT sent — sending failed (${result.detail || "unknown error"}). Please try again.`;
  }
}

/** Append delivery-result lines to the cleaned reply. */
export function appendEmailResults(cleanedContent, results) {
  if (!Array.isArray(results) || results.length === 0) return cleanedContent;
  const lines = results.map((r) => describeEmailOutcome(r));
  const base = (cleanedContent || "").trim();
  const sep = base.length > 0 ? "\n\n---\n" : "";
  return `${base}${sep}${lines.join("\n")}`;
}

/**
 * POST one send request to the platform adapter. Never throws — every
 * failure mode collapses to { ok: false, detail } so the caller can render
 * an honest line.
 */
export async function postEmailSend({
  url,
  bearer,
  businessId,
  request,
  fetchImpl = fetch,
  timeoutMs = 15_000
}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify({
        businessId,
        args: {
          toEmail: request.to,
          subject: request.subject,
          bodyText: request.body,
          ...(request.cc && request.cc.length > 0 ? { cc: request.cc } : {}),
          ...(request.bcc && request.bcc.length > 0 ? { bcc: request.bcc } : {})
        }
      }),
      signal: ctl.signal
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body && body.ok === true) {
      return { ok: true, to: request.to, subject: request.subject };
    }
    const detail =
      body && typeof body.detail === "string" && body.detail
        ? body.detail
        : `http_${res.status}`;
    return { ok: false, to: request.to, subject: request.subject, detail };
  } catch (err) {
    const detail = ctl.signal.aborted ? "timeout" : "adapter_unreachable";
    return {
      ok: false,
      to: request.to,
      subject: request.subject,
      detail,
      error: err && err.message ? String(err.message) : String(err)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full pipeline for one assistant reply: extract blocks, send (bounded by
 * MAX_EMAILS_PER_TURN), and return the owner-visible reply with honest
 * results appended. Never throws; with no blocks present it returns the
 * reply unchanged and `sentCount: 0`.
 */
export async function fulfillEmailSends({
  content,
  url,
  bearer,
  businessId,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  logger = () => {}
}) {
  const { cleanedContent, requests, invalidCount } = extractEmailSendRequests(content);
  if (requests.length === 0 && invalidCount === 0) {
    return { content, sentCount: 0, failedCount: 0, invalidCount: 0 };
  }

  const results = [];
  for (let i = 0; i < invalidCount; i++) {
    results.push({ ok: false, to: "(unparsed request)", subject: "", detail: "invalid_block" });
  }

  if (requests.length > 0 && !url) {
    for (const r of requests) {
      results.push({ ok: false, to: r.to, subject: r.subject, detail: "not_configured" });
    }
  } else {
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (i >= MAX_EMAILS_PER_TURN) {
        results.push({ ok: false, to: request.to, subject: request.subject, detail: "too_many_emails" });
        continue;
      }
      logger("info", "email_send_attempt", { to: request.to, subject: request.subject });
      // Sequential by design: preserves the model's intended order and keeps
      // the adapter (and Nango) from seeing a burst from one reply.
      const result = await postEmailSend({ url, bearer, businessId, request, fetchImpl, timeoutMs });
      logger(result.ok ? "info" : "warn", "email_send_result", {
        to: request.to,
        ok: result.ok,
        detail: result.ok ? undefined : result.detail,
        error: result.error
      });
      results.push(result);
    }
  }

  return {
    content: appendEmailResults(cleanedContent, results),
    sentCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    invalidCount
  };
}
