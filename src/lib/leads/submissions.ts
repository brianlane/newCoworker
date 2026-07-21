/**
 * Durable lead-submission records (`lead_submissions`).
 *
 * Every inbound webhook flow event (direct Meta Lead Ads, the Zapier /
 * Make / Privyr bridges, lead-backlog imports) is persisted here at
 * delivery time by processWebhookFlowEvent — BEFORE any flow runs — so the
 * Tasks page's Data view has one row per lead with the submitted answers,
 * and the Meta Conversions API feedback loop can resolve a contact back to
 * its `leadgen_id`.
 *
 * There is deliberately NO contact FK: when a lead arrives the contact
 * usually doesn't exist yet (the intake flow creates it later). Instead,
 * best-effort phone/email identifiers are extracted from the answers at
 * write time and readers join on those.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import {
  isE164,
  isPhoneFieldName,
  normalizeNanpToE164
} from "../../../supabase/functions/_shared/ai_flows/engine";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Bounds on the stored `fields` map — hostile payloads can't bloat rows. */
export const MAX_SUBMISSION_FIELDS = 60;
export const MAX_SUBMISSION_KEY_LENGTH = 80;
export const MAX_SUBMISSION_VALUE_LENGTH = 500;

/** Meta lead ids are 15-17 digit numbers; accept a little slack. */
const LEADGEN_ID_RE = /^\d{10,20}$/;

const EMAIL_VALUE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Does this field name denote an email address? (token-wise, like phones) */
function isEmailFieldName(name: string): boolean {
  return name
    .split(/[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])/)
    .some((t) => t.toLowerCase() === "email" || t.toLowerCase() === "e-mail");
}

/**
 * Flatten a webhook payload into a bounded `{key: value}` map for storage —
 * the Data view's dynamic columns render straight from these keys. Nested
 * objects flatten with dotted keys, arrays with indices (same shape as the
 * trigger windowText flattener, kept as a map instead of lines).
 */
export function flattenSubmissionFields(
  data: Record<string, unknown>
): Record<string, string> {
  const fields: Record<string, string> = {};
  let count = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4 || count >= MAX_SUBMISSION_FIELDS) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}.${i}`, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    // count is re-checked on entry above; only an empty key can fall out here.
    if (!path) return;
    fields[path.slice(0, MAX_SUBMISSION_KEY_LENGTH)] = String(value).slice(
      0,
      MAX_SUBMISSION_VALUE_LENGTH
    );
    count += 1;
  };
  walk(data, "", 0);
  return fields;
}

export type SubmissionIdentifiers = {
  phoneE164: string | null;
  email: string | null;
};

/**
 * Best-effort phone/email extraction from the flattened answers.
 *
 * Phone is deliberately conservative: only values under a phone-NAMED key
 * qualify (`phone_number`, `mobile`, `contact_no`, ... — isPhoneFieldName's
 * token rules), so an office line in a notes field never becomes the lead's
 * identifier. Email accepts an email-named key first, then any value that
 * looks like an address (addresses are unambiguous in a way numbers aren't).
 */
export function extractSubmissionIdentifiers(
  fields: Record<string, string>
): SubmissionIdentifiers {
  let phoneE164: string | null = null;
  let email: string | null = null;
  for (const [key, raw] of Object.entries(fields)) {
    const value = raw.trim();
    if (!value) continue;
    if (!phoneE164 && isPhoneFieldName(key)) {
      phoneE164 = isE164(value) ? value : normalizeNanpToE164(value);
    }
    if (!email && isEmailFieldName(key) && EMAIL_VALUE_RE.test(value)) {
      email = value.toLowerCase();
    }
  }
  if (!email) {
    for (const raw of Object.values(fields)) {
      const value = raw.trim();
      if (EMAIL_VALUE_RE.test(value)) {
        email = value.toLowerCase();
        break;
      }
    }
  }
  return { phoneE164, email };
}

/**
 * The Meta lead id carried by this event, if any: an explicit `leadgen_id`
 * field (the direct integration and well-built bridges send one, sometimes
 * `l:`-prefixed the way sheet exports render it), else an event id that IS
 * a bare Meta lead id (the direct webhook uses the leadgen id as the event
 * id). Returns null when neither looks like a Meta id.
 */
export function extractLeadgenId(
  data: Record<string, unknown>,
  eventKey: string
): string | null {
  const explicit = data["leadgen_id"];
  const candidates = [
    typeof explicit === "string" || typeof explicit === "number" ? String(explicit) : "",
    eventKey
  ];
  for (const raw of candidates) {
    const value = raw.trim().replace(/^l:/i, "");
    if (LEADGEN_ID_RE.test(value)) return value;
  }
  return null;
}

export type LeadSubmissionInput = {
  /** Caller-supplied source label, e.g. "facebook_lead_ads". */
  source: string;
  /** The parsed event payload. */
  data: Record<string, unknown>;
  /** The event's idempotency key (webhookEventKey) — unique per business. */
  eventKey: string;
};

/**
 * Persist one submission. Exactly-once per (business, eventKey): a
 * redelivery's insert is an ignore-duplicates no-op. Never throws — losing
 * a Data-view row must never fail the webhook delivery that carried it.
 */
export async function recordLeadSubmission(
  businessId: string,
  input: LeadSubmissionInput,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const fields = flattenSubmissionFields(input.data);
    const { phoneE164, email } = extractSubmissionIdentifiers(fields);
    const { error } = await db.from("lead_submissions").upsert(
      {
        business_id: businessId,
        source: input.source.slice(0, 120),
        event_key: input.eventKey.slice(0, 200),
        leadgen_id: extractLeadgenId(input.data, input.eventKey),
        fields,
        phone_e164: phoneE164,
        email
      },
      { onConflict: "business_id,event_key", ignoreDuplicates: true }
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("lead submission record failed (ignored)", {
      businessId,
      source: input.source,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
