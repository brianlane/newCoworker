/**
 * Meta Conversions API — Conversion Leads (CRM) uploads.
 *
 * The feedback half of the Lead Ads loop: when a lead that arrived from an
 * Instant Form moves pipeline stages (Contacted, Booked, Won, ...), we
 * upload the stage as a CRM event to the connection's dataset
 * (`POST /{dataset_id}/events`). Campaigns using the Conversion Leads
 * performance goal train on these, so Meta optimizes delivery toward the
 * leads that actually book.
 *
 * Payload rules (Meta's Conversion Leads payload specification):
 *   - `action_source` MUST be "system_generated";
 *   - `custom_data.event_source` = "crm", `lead_event_source` = our CRM name;
 *   - at least one customer information parameter: `lead_id` (the 15-17
 *     digit leadgen id — highest priority) or hashed email/phone;
 *   - `event_time` must be after lead creation and no older than 7 days.
 */
import { createHash } from "node:crypto";
import {
  META_GRAPH_BASE_URL,
  META_REQUEST_TIMEOUT_MS,
  MetaApiError
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";

/** custom_data.lead_event_source — the CRM name shown in Events Manager. */
export const CAPI_LEAD_EVENT_SOURCE = "New Coworker";

/** Meta discards Conversion Leads events older than this. */
export const CAPI_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash-normalize an email per Meta's matching rules (trim + lowercase). */
export function hashedEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? sha256Hex(normalized) : null;
}

/**
 * Hash-normalize a phone per Meta's matching rules: digits only, with
 * country code, no plus/punctuation. E.164 input makes this a strip.
 */
export function hashedPhone(phoneE164: string): string | null {
  const digits = phoneE164.replace(/[^\d]/g, "");
  return digits.length >= 7 ? sha256Hex(digits) : null;
}

export type ConversionLeadEventInput = {
  /** The CRM stage label (free-form; maps to the Events Manager funnel). */
  eventName: string;
  /** Stage-change time (ms epoch). */
  eventTimeMs: number;
  /** Deduplication key forwarded as the CAPI event_id. */
  eventId: string;
  /** The Meta leadgen id (preferred match key). */
  leadgenId?: string | null;
  /** Fallback identifiers, hashed before upload. */
  email?: string | null;
  phoneE164?: string | null;
};

/**
 * Build the raw JSON body for one Conversion Leads event, or null when the
 * event has no usable customer identifier (Meta rejects identifier-less
 * events, so callers skip instead of sending).
 *
 * Returned as a STRING with `lead_id` inlined as a bare number: 17-digit
 * lead ids exceed Number.MAX_SAFE_INTEGER, so building this via a JS
 * number could silently corrupt the id before serialization.
 */
export function buildConversionLeadBody(input: ConversionLeadEventInput): string | null {
  const leadgenId = input.leadgenId?.trim().replace(/^l:/i, "") ?? "";
  const useLeadId = /^\d{10,20}$/.test(leadgenId);
  const em = input.email ? hashedEmail(input.email) : null;
  const ph = input.phoneE164 ? hashedPhone(input.phoneE164) : null;
  if (!useLeadId && !em && !ph) return null;

  const userData: Record<string, unknown> = {};
  if (!useLeadId) {
    if (em) userData.em = [em];
    if (ph) userData.ph = [ph];
  } else {
    // Placeholder swapped for the bare digits after stringify (see above).
    userData.lead_id = "__LEAD_ID__";
    if (em) userData.em = [em];
    if (ph) userData.ph = [ph];
  }

  const body = JSON.stringify({
    data: [
      {
        event_name: input.eventName.slice(0, 100),
        event_time: Math.floor(input.eventTimeMs / 1000),
        event_id: input.eventId.slice(0, 100),
        action_source: "system_generated",
        user_data: userData,
        custom_data: {
          lead_event_source: CAPI_LEAD_EVENT_SOURCE,
          event_source: "crm"
        }
      }
    ]
  });
  return useLeadId ? body.replace('"__LEAD_ID__"', leadgenId) : body;
}

/**
 * Upload one pre-built Conversion Leads body to a dataset. Throws
 * MetaApiError on refusal (the outbox drain records it and retries inside
 * the 7-day window); returns Meta's events_received count when provided.
 */
export async function sendConversionLeadBody(
  datasetId: string,
  accessToken: string,
  body: string
): Promise<{ eventsReceived: number | null }> {
  const url = new URL(`${META_GRAPH_BASE_URL}/${datasetId}/events`);
  url.searchParams.set("access_token", accessToken);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), META_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new MetaApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Meta Conversions API timed out" : "Meta Conversions API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("meta conversions api upload failed", {
      datasetId,
      status: res.status,
      body: text.slice(0, 300)
    });
    throw new MetaApiError(
      "request_failed",
      `Meta Conversions API POST /${datasetId}/events failed (${res.status})`,
      res.status
    );
  }
  const payload = (await res.json().catch(() => null)) as {
    events_received?: unknown;
  } | null;
  return {
    eventsReceived:
      typeof payload?.events_received === "number" ? payload.events_received : null
  };
}
