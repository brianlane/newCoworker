/**
 * Node-side trigger evaluation helpers for the non-SMS AiFlow channels.
 *
 * The SMS channel is evaluated in the Telnyx webhook Edge Function against
 * `supabase/functions/_shared/ai_flows/engine.ts`; these mirror that engine's
 * URL/condition/text semantics (kept in sync deliberately, the same
 * dual-runtime pattern as schema.ts ↔ types.ts) for the places that run in
 * Next.js instead: the manual "Run now" route and the inbound-email poller.
 */
import { tenantEmailDomain } from "@/lib/email/tenant-mailbox";
import type { TriggerCondition } from "@/lib/ai-flows/schema";

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

/** First http(s) URL in a string (trailing punctuation trimmed), or null. */
export function firstUrlInText(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, "");
}

/** Safe regex test, an invalid pattern never throws, it just fails to match. */
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
 * resolveFromMatchesRefValues), a ref with no entry fails closed.
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
 * Collapse an HTML email body to readable text. Twin of the Cloudflare email
 * worker's `cloudflare/email-worker/src/html-text.ts` (keep in sync): drops
 * the CONTENTS of comments/head/script/style/title too, a naive tag strip
 * leaks whole stylesheets and unrendered `*|MC:SUBJECT|*` merge tags into the
 * "text", keeps http(s) link destinations as `label (url)` so buttons stay
 * actionable, decodes common entities, and squeezes whitespace.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\b[^>]*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\b[^>]*>/gi, " ")
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\b[^>]*>/gi,
      (_m, href: string, label: string) => ` ${label} (${href}) `
    )
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

/**
 * True when a message's "plain text" part is really tag-stripped template
 * source rather than prose (twin of the email worker's copy, keep in sync).
 * Some senders generate the text/plain alternative by naively flattening the
 * HTML, leaving the stylesheet and unrendered merge tags in the "text".
 * Signals: a Mailchimp-style merge tag anywhere, or 3+ CSS rule blocks.
 * A false positive only means the text gets re-derived from the HTML part.
 */
export function looksLikeStrippedTemplate(text: string): boolean {
  if (/\*\|[^|*\s][^|*]*\|\*/.test(text)) return true;
  const cssBlocks = text.match(/\{[^{}]*:[^{}]*;[^{}]*\}/g);
  return (cssBlocks?.length ?? 0) >= 3;
}

/** What an enqueued run's `context.trigger` looks like for these channels. */
export type TriggerScope = {
  channel: "manual" | "email" | "schedule" | "tenant_email" | "webhook" | "calendar";
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
  /**
   * Provider conversation id (Gmail threadId), shared by every reply on the
   * thread. Optional: only the connected-mailbox poller can supply one, and a
   * step keyed on it degrades to per-message behavior when it is absent.
   */
  threadId?: string;
  /**
   * The message's RFC 5322 `Message-Id` header. threadId is how Gmail FILES a
   * conversation; this is what In-Reply-To and References carry, so a reply
   * needs both to nest correctly in a strict client. Same optionality rule as
   * threadId.
   */
  messageRef?: string;
  /**
   * The raw To / Cc header values. An introduction email names the PROSPECT
   * here while the introducer sits in From, so answering only From reaches
   * the wrong person. Raw strings, normalized where they are used.
   */
  toRecipients?: string;
  ccRecipients?: string;
  /**
   * True when this business has already SENT on this conversation. Turns a
   * message that reads like a broadcast into the next turn of a
   * correspondence, which is never routine.
   */
  weRepliedOnThread?: boolean;
  receivedAt?: string;
};

/** Max chars of subject+body kept in the run context / matched against. */
export const EMAIL_WINDOW_TEXT_MAX = 6000;

/** Trigger scope for an inbound email that matched a flow's conditions. */
export function emailTriggerScope(
  msg: InboundEmailMessage,
  opts?: {
    connectionId?: string;
    /** The connected account's own address, so it drops out of others_*. */
    selfEmail?: string;
  }
): TriggerScope {
  const bodyWindow = `${msg.subject}\n${msg.bodyText}`.slice(0, EMAIL_WINDOW_TEXT_MAX);
  // AFTER the body slice, so a long message cannot truncate the marker away.
  const windowText = msg.weRepliedOnThread
    ? `${bodyWindow}\n\n${EMAIL_THREAD_REPLY_MARKER}`
    : bodyWindow;
  const connectionId = opts?.connectionId?.trim();
  const others = otherRecipients(
    msg.toRecipients,
    msg.ccRecipients,
    msg.fromEmail,
    opts?.selfEmail
  );
  return {
    channel: "email",
    windowText,
    // Also a plain key, so a step can branch on it without parsing text.
    thread_has_our_reply: msg.weRepliedOnThread ? "yes" : "no",
    // The prospect, split so a send step can use them: `to` takes one address
    // and `cc` takes the rest (normalizeRecipients splits the comma string).
    others_to: others[0] ?? "",
    others_cc: others.slice(1).join(", "),
    url: firstUrlInText(windowText),
    from: msg.fromEmail,
    subject: msg.subject.slice(0, 300),
    message_id: msg.id,
    // Absent for providers that expose no conversation id: the key is omitted
    // rather than emitted empty, so a cooldown keyed on it falls back to
    // per-message behavior instead of collapsing every message onto "".
    ...(msg.threadId ? { thread_id: msg.threadId } : {}),
    // Same rule: a blank Message-Id must not look like a real one, or a reply
    // would be threaded against nothing.
    ...(msg.messageRef ? { message_ref: msg.messageRef } : {}),
    // WHO ELSE IS ON THIS. An introduction names the prospect in the body but
    // puts them on To or Cc, and a drafter that cannot see the recipient list
    // writes "Bobby, please reach out" to an email Bobby never receives (live,
    // Aug 6 2026: James referred Bobby and never included his address). A step
    // can now check before addressing anyone.
    ...(msg.toRecipients ? { to: msg.toRecipients } : {}),
    ...(msg.ccRecipients ? { cc: msg.ccRecipients } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
    ...(msg.receivedAt ? { received_at: msg.receivedAt } : {})
  };
}

/**
 * Trigger scope for an inbound email delivered to the AI coworker's dedicated
 * mailbox (the `tenant_email` channel). Same shape as `emailTriggerScope` but
 * tagged with the distinct channel and the recipient address so steps can
 * template the mailbox the mail arrived at.
 */
/** Cap on the attachment-names line appended to tenant-mail windowText. */
export const EMAIL_ATTACHMENT_NAMES_MAX = 500;

/**
 * Marker prefixing the appended attachment-names line. Bracketed and
 * guaranteed to sit at the very END of windowText, so receipt flows can
 * anchor on `\n\[inbound attachments\] .+$`, prose that merely mentions
 * attachments can't false-positive (only a body deliberately ENDING with
 * this exact bracketed line could, and the worst case is a courteous
 * confirmation email).
 */
/**
 * Everyone on this message who is neither US nor the sender: in practice, the
 * prospect an introducer put on To or Cc.
 *
 * Exists so a flow can write to the prospect DIRECTLY rather than replying-all
 * with copy aimed partly at someone else. An intro reply that thanks the
 * introducer and pitches the prospect in one message reads oddly to both of
 * them: each sees a paragraph written for the other.
 *
 * "Ours" is the connected account plus anything on the tenant email domain,
 * which is where the AI mailbox and the catch-all aliases live. Display names
 * are dropped because the send path validates bare addresses.
 */
export function otherRecipients(
  toHeader: string | undefined,
  ccHeader: string | undefined,
  fromEmail: string,
  selfEmail?: string
): string[] {
  const domain = tenantEmailDomain();
  const mine = new Set(
    [selfEmail, fromEmail].map((a) => (a ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of `${toHeader ?? ""},${ccHeader ?? ""}`.split(",")) {
    const m = /<([^<>]+)>/.exec(raw);
    const addr = (m ? m[1] : raw).trim().toLowerCase();
    if (!addr.includes("@") || seen.has(addr) || mine.has(addr)) continue;
    const at = addr.lastIndexOf("@");
    if (addr.slice(at + 1) === domain) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/**
 * Appended to windowText when we have already sent on this conversation.
 *
 * A classifier reading a message in isolation cannot tell a newsletter from
 * the next turn of a correspondence we started. Live, Aug 9 2026: Google
 * acknowledged our OWN OAuth verification request, on a thread Brian had
 * replied to on Jul 30, and it was filed as routine and binned. Being in the
 * conversation is a stronger signal than any phrase in the subject, and it
 * does not depend on the sender wording things a particular way.
 *
 * Carried in windowText rather than only as a scope key because `classify`
 * reads windowText (or a named var) and its `question` is not templated, so
 * this is the only way the signal reaches the model.
 */
export const EMAIL_THREAD_REPLY_MARKER =
  "[thread] we have already replied on this conversation";

export const EMAIL_ATTACHMENTS_MARKER = "[inbound attachments]";

export function tenantEmailTriggerScope(
  msg: InboundEmailMessage & {
    toEmail?: string;
    /**
     * First image attachment on the mail, as an `email-attachments:<path>`
     * bucket reference. Exposed as {{trigger.image}} so a generate_image
     * step's inputImageTemplate can edit the photo the sender attached.
     */
    imageRef?: string;
    /**
     * First DOCUMENT attachment (pdf/docx/txt/md/csv) on the mail, as an
     * `email-attachments:<path>` ref. Exposed as {{trigger.document}}, the
     * doc_extract step's default source. `documentName` is its display
     * filename ({{trigger.document_name}}).
     */
    documentRef?: string;
    documentName?: string;
    /**
     * Filenames of every attachment on the mail. Appended to windowText as
     * an `attachments: …` line (AFTER the body slice, so a long body can't
     * truncate it away) and exposed as {{trigger.attachments}}, this is
     * what document-receipt flows condition on and confirm back.
     */
    attachmentNames?: string[];
    /**
     * email_log row id written before enqueue. email_organize prefers this
     * over provider_message_id when filing the AI mailbox message.
     */
    emailLogId?: string;
  }
): TriggerScope {
  const attachmentNames = (msg.attachmentNames ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const attachmentsLine =
    attachmentNames.length > 0
      ? `${EMAIL_ATTACHMENTS_MARKER} ${attachmentNames.join(", ").slice(0, EMAIL_ATTACHMENT_NAMES_MAX)}`
      : "";
  const bodyWindow = `${msg.subject}\n${msg.bodyText}`.slice(0, EMAIL_WINDOW_TEXT_MAX);
  const windowText = attachmentsLine ? `${bodyWindow}\n\n${attachmentsLine}` : bodyWindow;
  return {
    channel: "tenant_email",
    windowText,
    url: firstUrlInText(windowText),
    from: msg.fromEmail,
    subject: msg.subject.slice(0, 300),
    message_id: msg.id,
    ...(msg.toEmail ? { to: msg.toEmail } : {}),
    ...(msg.receivedAt ? { received_at: msg.receivedAt } : {}),
    ...(msg.emailLogId ? { email_log_id: msg.emailLogId } : {}),
    image: msg.imageRef ?? "",
    document: msg.documentRef ?? "",
    document_name: (msg.documentName ?? "").slice(0, 255),
    attachments: attachmentNames.join(", ").slice(0, EMAIL_ATTACHMENT_NAMES_MAX),
    attachment_count: attachmentNames.length
  };
}

/**
 * Flatten a webhook event payload into readable "key: value" lines, so trigger
 * conditions and the Gemini `extract_text` step see the lead exactly the way
 * they'd see an email body. Nested objects flatten with dotted keys
 * (`field_data.city: Phoenix`), arrays with indices. Depth/size-bounded so a
 * hostile payload can't blow up the run context.
 */
export function flattenWebhookPayload(
  data: Record<string, unknown>,
  maxChars = EMAIL_WINDOW_TEXT_MAX
): string {
  const lines: string[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4 || lines.length >= 200) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      // The root is always an object (Record), so an array is always reached
      // under a key, `path` is never empty here.
      value.forEach((v, i) => walk(v, `${path}.${i}`, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    lines.push(`${path}: ${String(value)}`);
  };
  walk(data, "", 0);
  return lines.join("\n").slice(0, maxChars);
}

/** A normalized calendar event (Google or Microsoft) the poller evaluates. */
export type CalendarEventInput = {
  /** Provider event id (occurrence id for recurring events; drives dedupe). */
  id: string;
  title: string;
  description?: string;
  location?: string;
  organizerEmail?: string;
  /** Attendee display strings ("Name <email>" or bare emails). */
  attendees?: string[];
  startIso?: string;
  endIso?: string;
  /** ISO creation timestamp (drives the event_created lookback filter). */
  createdIso?: string;
  /** ISO last-modified timestamp (drives the event_canceled lookback filter). */
  updatedIso?: string;
  /**
   * All-day event: its "start" is a calendar-local date, not a moment in
   * time, so event_start reminders skip it (event_created still fires).
   */
  allDay?: boolean;
  /**
   * Cancelled/deleted event: only the event_canceled mode fires for it (the
   * other modes skip, a cancelled event neither starts nor ends).
   */
  cancelled?: boolean;
  /** Which watched calendar the event came from. */
  calendar: "primary" | "shared";
};

/**
 * Readable "key: value" text for a calendar event, so trigger conditions and
 * the Gemini `extract_text` step see it the way they'd see an email body.
 */
export function calendarEventText(ev: CalendarEventInput): string {
  const lines = [
    `title: ${ev.title}`,
    ev.startIso ? `starts: ${ev.startIso}` : "",
    ev.endIso ? `ends: ${ev.endIso}` : "",
    ev.location ? `location: ${ev.location}` : "",
    ev.organizerEmail ? `organizer: ${ev.organizerEmail}` : "",
    ...(ev.attendees ?? []).map((a) => `attendee: ${a}`),
    ev.description ? `description: ${htmlToText(ev.description)}` : ""
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

/** Trigger scope for a calendar event that matched a flow's conditions. */
export function calendarTriggerScope(ev: CalendarEventInput): TriggerScope {
  const windowText = calendarEventText(ev).slice(0, EMAIL_WINDOW_TEXT_MAX);
  return {
    channel: "calendar",
    windowText,
    url: firstUrlInText(windowText),
    from: ev.organizerEmail ?? "",
    event_id: ev.id,
    event_title: ev.title.slice(0, 300),
    calendar: ev.calendar,
    ...(ev.startIso ? { starts_at: ev.startIso } : {}),
    ...(ev.endIso ? { ends_at: ev.endIso } : {})
  };
}

export type WebhookEventInput = {
  /** Caller-supplied source label, e.g. "facebook_lead_ads". */
  source: string;
  /** The event payload (already parsed JSON object). */
  data: Record<string, unknown>;
  /** Caller-supplied event id (drives the run dedupe key), if any. */
  eventId?: string;
};

/**
 * Trigger scope for a public-API webhook event (the `webhook` channel).
 * windowText is the flattened payload; `from` is the source label so a
 * `from_matches` condition can scope a flow to one bridge/lead source.
 */
export function webhookTriggerScope(event: WebhookEventInput): TriggerScope {
  const windowText = flattenWebhookPayload(event.data);
  return {
    // Named payload keys FIRST, so a reserved name below always wins: a
    // payload carrying its own "channel" or "from" must not be able to
    // rewrite what the trigger actually was.
    ...webhookPayloadKeys(event.data),
    channel: "webhook",
    windowText,
    url: firstUrlInText(windowText),
    from: event.source.slice(0, 120),
    ...(event.eventId ? { event_id: event.eventId.slice(0, 200) } : {})
  };
}

/** Bounds on the named keys promoted out of a webhook payload. */
const WEBHOOK_SCOPE_MAX_KEYS = 40;
const WEBHOOK_SCOPE_MAX_VALUE_CHARS = 500;

/**
 * Promote a webhook payload's top-level scalars to named trigger keys, so a
 * step can say `{{trigger.comment_id}}` instead of digging the value back
 * out of the flattened windowText blob.
 *
 * Top level only, scalars only, and bounded in both count and length: the
 * blob stays the place to read nested structure, and a hostile payload
 * cannot grow the run context. Steps templating an absent key get "" as
 * they always have, so this only ever adds reach.
 */
function webhookPayloadKeys(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Object.keys(out).length >= WEBHOOK_SCOPE_MAX_KEYS) break;
    // Only plain identifier-ish names: `{{trigger.x}}` cannot address
    // anything else anyway, so a dotted or spaced key would be dead weight.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value === "string") {
      out[key] = value.slice(0, WEBHOOK_SCOPE_MAX_VALUE_CHARS);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}
