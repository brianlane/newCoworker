/**
 * Node-side trigger evaluation helpers for the non-SMS AiFlow channels.
 *
 * The SMS channel is evaluated in the Telnyx webhook Edge Function against
 * `supabase/functions/_shared/ai_flows/engine.ts`; these mirror that engine's
 * URL/condition/text semantics (kept in sync deliberately, the same
 * dual-runtime pattern as schema.ts ↔ types.ts) for the places that run in
 * Next.js instead: the manual "Run now" route and the inbound-email poller.
 */
import type { TriggerCondition } from "@/lib/ai-flows/schema";

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

/** First http(s) URL in a string (trailing punctuation trimmed), or null. */
export function firstUrlInText(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, "");
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

function textContains(haystack: string, needle: string, caseInsensitive?: boolean): boolean {
  if (caseInsensitive === false) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Evaluate an AND-ed condition list the way the SMS engine does: `contains`,
 * `regex` and `has_url` test the window text; `from_matches` tests the sender
 * (for email triggers, the sender address). Empty list matches everything.
 * `refValues` carries pre-resolved identity values (phones/emails) for any
 * `from_matches` contact refs, keyed `${source}:${id}` (see
 * resolveFromMatchesRefValues) — a ref with no entry fails closed.
 */
export function evaluateTriggerConditions(
  conditions: TriggerCondition[],
  windowText: string,
  from: string,
  refValues?: ReadonlyMap<string, string[]>
): boolean {
  return conditions.every((cond) => {
    switch (cond.type) {
      case "contains":
        return textContains(windowText, cond.value, cond.caseInsensitive);
      case "regex":
        return safeRegexTest(cond.value, windowText, cond.caseInsensitive);
      case "has_url":
        return firstUrlInText(windowText) !== null;
      case "from_matches": {
        if (cond.ref) {
          const candidates = refValues?.get(`${cond.ref.source}:${cond.ref.id}`) ?? [];
          return candidates.some((v) => textContains(from, v, cond.caseInsensitive));
        }
        return typeof cond.value === "string"
          ? textContains(from, cond.value, cond.caseInsensitive)
          : false;
      }
    }
  });
}

/**
 * Collapse an HTML email body to readable text (mirror of the engine's
 * htmlToText): strip script/style/tags, decode common entities, squeeze
 * whitespace. Plain-text bodies pass through nearly untouched.
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
    // Decode &amp; LAST so "&amp;lt;" does not double-unescape into "<".
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** What an enqueued run's `context.trigger` looks like for these channels. */
export type TriggerScope = {
  channel: "manual" | "email" | "schedule" | "tenant_email";
  windowText: string;
  url: string | null;
  from: string;
  [key: string]: unknown;
};

/** Trigger scope for a manual "Run now" with optional free-text input. */
export function manualTriggerScope(input: string, startedBy: string): TriggerScope {
  const windowText = input.trim();
  return {
    channel: "manual",
    windowText,
    url: firstUrlInText(windowText),
    from: startedBy
  };
}

export type InboundEmailMessage = {
  /** Provider message id (drives the run dedupe key). */
  id: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  receivedAt?: string;
};

/** Max chars of subject+body kept in the run context / matched against. */
export const EMAIL_WINDOW_TEXT_MAX = 6000;

/** Trigger scope for an inbound email that matched a flow's conditions. */
export function emailTriggerScope(msg: InboundEmailMessage): TriggerScope {
  const windowText = `${msg.subject}\n${msg.bodyText}`.slice(0, EMAIL_WINDOW_TEXT_MAX);
  return {
    channel: "email",
    windowText,
    url: firstUrlInText(windowText),
    from: msg.fromEmail,
    subject: msg.subject.slice(0, 300),
    message_id: msg.id,
    ...(msg.receivedAt ? { received_at: msg.receivedAt } : {})
  };
}

/**
 * Trigger scope for an inbound email delivered to the AI coworker's dedicated
 * mailbox (the `tenant_email` channel). Same shape as `emailTriggerScope` but
 * tagged with the distinct channel and the recipient address so steps can
 * template the mailbox the mail arrived at.
 */
export function tenantEmailTriggerScope(
  msg: InboundEmailMessage & { toEmail?: string }
): TriggerScope {
  const windowText = `${msg.subject}\n${msg.bodyText}`.slice(0, EMAIL_WINDOW_TEXT_MAX);
  return {
    channel: "tenant_email",
    windowText,
    url: firstUrlInText(windowText),
    from: msg.fromEmail,
    subject: msg.subject.slice(0, 300),
    message_id: msg.id,
    ...(msg.toEmail ? { to: msg.toEmail } : {}),
    ...(msg.receivedAt ? { received_at: msg.receivedAt } : {})
  };
}
