/**
 * Vagaro webhook processing — the Zapier-free inbound path.
 *
 * The owner pastes the tenant's webhook URL (which embeds the connection's
 * `webhook_verification_token`) into Vagaro's APIs & Webhooks settings.
 * Deliveries land on /api/webhooks/vagaro, which authenticates the token
 * (timing-safe) and calls `processVagaroWebhookEvent` here to:
 *
 *   1. start every enabled `webhook`-channel AiFlow whose conditions match
 *      (same engine path as the Zapier "Send Lead to Coworker" action, with
 *      `source: "vagaro"` so flows can filter on it), idempotent per Vagaro
 *      event id; and
 *   2. sync `customer` created/updated events into the coworker's contacts
 *      (create-if-missing, fill-only on name/email — never clobber).
 *
 * Both halves are best-effort relative to each other: a contact-sync failure
 * must not lose the flow event, and vice versa.
 */
import { timingSafeEqual } from "node:crypto";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

/** Serialized payload ceiling — mirrors /api/public/v1/flow-events. */
export const VAGARO_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Constant-time token check (both sides are attacker-observable strings). */
export function verificationTokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type VagaroWebhookEvent = {
  /** Vagaro's event id — the idempotency key when present. */
  id: string | null;
  /** e.g. "appointment", "customer", "transaction", "formResponse". */
  type: string | null;
  /** e.g. "created", "updated", "deleted". */
  action: string | null;
  /** The event's payload object (shape varies by type). */
  payload: Record<string, unknown>;
  /** The full body, flattened into the flow trigger's window text. */
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Normalize a Vagaro delivery body into the fields we consume. */
export function parseVagaroWebhookBody(body: unknown): VagaroWebhookEvent | null {
  const record = asRecord(body);
  if (Object.keys(record).length === 0) return null;
  const payload = asRecord(record.payload);
  return {
    id: asString(record.id) ?? asString(record.eventId),
    type: asString(record.type) ?? asString(record.resourceType),
    action: asString(record.action),
    payload,
    raw: record
  };
}

/**
 * Best-effort E.164 normalization for Vagaro-supplied phone strings.
 * US-assumed for bare 10-digit numbers (Vagaro's core market, matching the
 * public-API send_sms hint). Null when the shape isn't usable.
 */
export function normalizeVagaroPhone(input: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/[^0-9+]/g, "");
  if (digits.startsWith("+")) {
    const rest = digits.slice(1).replace(/[^0-9]/g, "");
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Pull the customer's contact fields out of a `customer` event payload. */
export function extractVagaroCustomer(payload: Record<string, unknown>): {
  phone: string | null;
  name: string | null;
  email: string | null;
} {
  const customer = asRecord(payload.customer);
  const source = Object.keys(customer).length > 0 ? customer : payload;
  const phoneRaw =
    asString(source.phone) ??
    asString(source.phoneNumber) ??
    asString(source.mobilePhone) ??
    asString(source.cellPhone);
  const first = asString(source.firstName);
  const last = asString(source.lastName);
  const name =
    asString(source.name) ??
    asString(source.fullName) ??
    (first || last ? [first, last].filter(Boolean).join(" ") : null);
  return {
    phone: normalizeVagaroPhone(phoneRaw),
    name,
    email: asString(source.email)?.toLowerCase() ?? null
  };
}

/**
 * Contact sync for `customer` created/updated events. Create-if-missing;
 * existing rows get FILL-ONLY name/email (an owner's manual edit or a
 * richer earlier value is never clobbered). No phone → nothing to key on.
 */
export async function syncVagaroCustomer(
  businessId: string,
  event: VagaroWebhookEvent
): Promise<void> {
  if (event.type !== "customer") return;
  if (event.action !== "created" && event.action !== "updated") return;
  const { phone, name, email } = extractVagaroCustomer(event.payload);
  if (!phone) return;

  const existing = await getCustomerMemory(businessId, phone);
  if (!existing) {
    try {
      await createCustomerMemory(businessId, {
        customerE164: phone,
        displayName: name,
        email
      });
    } catch (err) {
      // Concurrent deliveries can race the existence check; the profile
      // exists either way, so fall through to the fill-only path below.
      if (!(err instanceof CustomerExistsError)) throw err;
    }
    return;
  }

  const patch: { displayName?: string; email?: string } = {};
  if (name && !existing.display_name) patch.displayName = name;
  if (email && !existing.email) patch.email = email;
  if (Object.keys(patch).length === 0) return;
  await updateCustomerOwnerFields(businessId, existing.customer_e164, patch);
}

export type VagaroWebhookResult = {
  enqueued: number;
  flowsEvaluated: number;
  flowsMatched: number;
  contactSynced: boolean;
};

/** The route's core: flow events + contact sync, isolated from each other. */
export async function processVagaroWebhookEvent(
  businessId: string,
  event: VagaroWebhookEvent
): Promise<VagaroWebhookResult> {
  const flowResult = await processWebhookFlowEvent(businessId, {
    source: "vagaro",
    data: event.raw,
    eventId: event.id ?? undefined
  });

  let contactSynced = false;
  try {
    await syncVagaroCustomer(businessId, event);
    contactSynced = event.type === "customer";
  } catch (err) {
    logger.warn("vagaro webhook contact sync failed", {
      businessId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return {
    enqueued: flowResult.enqueued,
    flowsEvaluated: flowResult.flowsEvaluated,
    flowsMatched: flowResult.flowsMatched,
    contactSynced
  };
}
