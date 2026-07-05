/**
 * Webhook event model shared by the Next.js public API
 * (`/api/public/v1/events`, REST-hook validation) and the
 * `webhook-dispatcher` Edge cron. Pure data + mappers — no I/O — so both
 * runtimes (Node and Deno) shape identical payloads and the whole module is
 * unit-testable.
 *
 * Each event type maps 1:1 onto an existing source table; the dispatcher
 * polls `table` for rows with `created_at > subscription.last_cursor` and
 * POSTs `buildWebhookPayload(...)` for each. No hot-path instrumentation:
 * SMS workers / voice functions / email webhooks stay untouched.
 */

export const WEBHOOK_EVENT_TYPES = [
  "sms.inbound",
  "sms.outbound",
  "call.completed",
  "email.inbound"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (
    typeof value === "string" &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export type WebhookEventSource = {
  /** Source table polled by the dispatcher. */
  table: string;
  /** Columns to select (bounded — payload jsonb only where needed). */
  select: string;
  /**
   * Optional extra PostgREST filter as [column, operator, value], applied on
   * top of the business + cursor filters (e.g. only inbound emails).
   */
  filter: [string, string, string] | null;
};

export const WEBHOOK_EVENT_SOURCES: Record<WebhookEventType, WebhookEventSource> = {
  "sms.inbound": {
    table: "sms_inbound_jobs",
    select: "id, business_id, customer_e164, payload, channel, created_at",
    filter: null
  },
  "sms.outbound": {
    table: "sms_outbound_log",
    select: "id, business_id, to_e164, from_e164, body, source, channel, created_at",
    filter: null
  },
  "call.completed": {
    table: "voice_call_transcripts",
    select:
      "id, business_id, caller_e164, direction, status, started_at, ended_at, summary, sentiment, created_at",
    // Only calls that actually finished; in-flight rows would fire twice.
    filter: ["ended_at", "not.is", "null"]
  },
  "email.inbound": {
    table: "email_log",
    select: "id, business_id, from_email, to_email, subject, body_preview, created_at",
    filter: ["direction", "eq", "inbound"]
  }
};

/**
 * The dispatcher orders + cursors on `created_at` for every source, so a
 * generic row just needs id/created_at plus whatever the mapper reads.
 */
export type WebhookSourceRow = {
  id: string;
  created_at: string;
  [key: string]: unknown;
};

export type WebhookPayload = {
  event: WebhookEventType;
  business_id: string;
  /** Source-row id — idempotency key for consumers. */
  id: string;
  occurred_at: string;
  data: Record<string, unknown>;
};

function str(row: WebhookSourceRow, key: string): string | null {
  const v = row[key];
  return typeof v === "string" ? v : null;
}

/**
 * Inbound SMS text lives inside the raw Telnyx envelope. Mirrors the happy
 * paths of `inboundTextFromPayload` in src/lib/db/sms-history.ts (plain
 * `text`, legacy `body` string) — RCS suggestion taps degrade to "" which
 * is acceptable for a webhook feed.
 */
export function inboundSmsTextFromEnvelope(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = (payload as { data?: { payload?: Record<string, unknown> } }).data;
  const inner = data?.payload ?? {};
  const text = inner["text"];
  if (typeof text === "string") return text;
  const body = inner["body"];
  if (typeof body === "string") return body;
  return "";
}

export function buildWebhookPayload(
  event: WebhookEventType,
  row: WebhookSourceRow
): WebhookPayload {
  const base = {
    event,
    business_id: str(row, "business_id") ?? "",
    id: row.id,
    occurred_at: row.created_at
  };
  switch (event) {
    case "sms.inbound":
      return {
        ...base,
        data: {
          from: str(row, "customer_e164"),
          text: inboundSmsTextFromEnvelope(row["payload"]),
          channel: str(row, "channel") ?? "sms"
        }
      };
    case "sms.outbound":
      return {
        ...base,
        data: {
          to: str(row, "to_e164"),
          from: str(row, "from_e164"),
          text: str(row, "body"),
          source: str(row, "source"),
          channel: str(row, "channel") ?? "sms"
        }
      };
    case "call.completed":
      return {
        ...base,
        data: {
          caller: str(row, "caller_e164"),
          direction: str(row, "direction"),
          status: str(row, "status"),
          started_at: str(row, "started_at"),
          ended_at: str(row, "ended_at"),
          summary: str(row, "summary"),
          sentiment: str(row, "sentiment")
        }
      };
    case "email.inbound":
      return {
        ...base,
        data: {
          from: str(row, "from_email"),
          to: str(row, "to_email"),
          subject: str(row, "subject"),
          body_preview: str(row, "body_preview")
        }
      };
  }
}
