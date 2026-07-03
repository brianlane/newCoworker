/**
 * Bring-your-own-number (BYON) orchestration.
 *
 * Sits between the dashboard API routes and the raw Telnyx porting client:
 *   - `runPortabilityCheck`     — wizard step 1 ("can my number move?")
 *   - `createByonPortRequest`   — wizard submit: create order → upload LOA +
 *                                 bill → attach details → confirm → persist
 *                                 `number_port_requests` rows
 *   - `listByonPortRequests`    — status card data
 *   - `cancelByonPortRequest`   — abort a not-yet-ported order
 *   - `handlePortingStatusChange` — webhook: mirror Telnyx status onto the
 *                                 row and alert the owner on milestones
 *
 * Service-role only. Owner authorization is the API route's job
 * (requireOwner before any call here) — same trust model as `src/lib/csv`.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  TelnyxPortingClient,
  type PortingOrder,
  type PortingExceptionDetail
} from "@/lib/telnyx/porting";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Subset of TelnyxPortingClient this module drives (injectable for tests). */
export type PortingClientLike = Pick<
  TelnyxPortingClient,
  | "checkPortability"
  | "createPortingOrder"
  | "updatePortingOrder"
  | "confirmPortingOrder"
  | "cancelPortingOrder"
  | "uploadDocument"
>;

export type ByonDeps = {
  client?: SupabaseClient;
  porting?: PortingClientLike;
  dispatch?: typeof dispatchUrgentNotification;
};

export type NumberPortRequestRow = {
  id: string;
  business_id: string;
  phone_e164: string;
  telnyx_order_id: string | null;
  status: string;
  status_detail: PortingExceptionDetail[] | null;
  foc_at: string | null;
  support_key: string | null;
  loa_document_id: string | null;
  invoice_document_id: string | null;
  created_at: string;
  updated_at: string;
};

/** 5 MB of raw bytes ≈ 6.7 MB of base64 text. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Statuses where the port is finished and cancel no longer makes sense. */
const TERMINAL_STATUSES = new Set(["ported", "cancelled"]);

/** Milestones worth an owner notification (vs. silent bookkeeping moves). */
const NOTIFY_STATUSES = new Set(["exception", "foc-date-confirmed", "ported", "cancelled"]);

/**
 * Rough forward order of the Telnyx porting lifecycle, used to spot webhook
 * redeliveries arriving out of order. Unknown statuses rank highest so a
 * status Telnyx adds later is never mistaken for a stale event.
 */
const STATUS_ORDER: Record<string, number> = {
  draft: 0,
  "in-process": 1,
  submitted: 2,
  exception: 3,
  "foc-date-confirmed": 4,
  "cancel-pending": 5,
  ported: 6,
  cancelled: 6
};

/**
 * Decide whether a status_changed event may be applied over the stored row.
 *
 * - Terminal rows (`ported`/`cancelled`) never change again.
 * - Same-status redeliveries always apply (detail merge handles them).
 * - Forward moves always apply.
 * - Backward moves are legitimate (exception → in-process after a fix, FOC
 *   rescheduled, …) but indistinguishable from a delayed retry by status
 *   alone — so they only apply when the event's `occurred_at` is newer than
 *   our last write. A retry of an old event carries its original timestamp
 *   and is dropped instead of regressing the row.
 */
function shouldApplyStatusChange(
  prior: NumberPortRequestRow,
  status: string,
  occurredAt: string | null
): boolean {
  if (status === prior.status) return true;
  if (TERMINAL_STATUSES.has(prior.status)) return false;
  const priorRank = STATUS_ORDER[prior.status] ?? Number.POSITIVE_INFINITY;
  const nextRank = STATUS_ORDER[status] ?? Number.POSITIVE_INFINITY;
  if (nextRank >= priorRank) return true;
  const occurred = occurredAt ? Date.parse(occurredAt) : Number.NaN;
  const lastWrite = prior.updated_at ? Date.parse(prior.updated_at) : Number.NaN;
  return Number.isFinite(occurred) && Number.isFinite(lastWrite) && occurred > lastWrite;
}

function getPorting(deps: ByonDeps): PortingClientLike {
  if (deps.porting) return deps.porting;
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY missing — cannot talk to the Telnyx porting API");
  }
  return new TelnyxPortingClient({ apiKey, userAgent: "newcoworker-byon" });
}

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wizard-facing validation error: message is safe to show the owner. */
export class ByonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByonValidationError";
  }
}

function requireE164(raw: string): string {
  const normalized = normalizeContactNumber(raw);
  if (!normalized.ok) throw new ByonValidationError(normalized.reason);
  if (!normalized.value.startsWith("+")) {
    throw new ByonValidationError("Short codes can't be ported — enter a full phone number.");
  }
  return normalized.value;
}

// ---------------------------------------------------------------------------
// Portability check
// ---------------------------------------------------------------------------

export type PortabilityCheckSummary = {
  phoneE164: string;
  portable: boolean;
  /** FastPort → 1–4 business days; standard → 3–7. */
  fastPortable: boolean;
  etaDays: string;
  notPortableReason: string | null;
  carrierName: string | null;
};

export async function runPortabilityCheck(
  phoneRaw: string,
  deps: ByonDeps = {}
): Promise<PortabilityCheckSummary> {
  const phoneE164 = requireE164(phoneRaw);
  const porting = getPorting(deps);
  const results = await porting.checkPortability([phoneE164]);
  const result = results.find((r) => r.phone_number === phoneE164) ?? results[0];
  if (!result) {
    return {
      phoneE164,
      portable: false,
      fastPortable: false,
      etaDays: "",
      notPortableReason: "Telnyx could not evaluate this number.",
      carrierName: null
    };
  }
  const portable = result.portable === true;
  const fastPortable = portable && result.fast_portable === true;
  return {
    phoneE164,
    portable,
    fastPortable,
    etaDays: portable ? (fastPortable ? "1-4 business days" : "3-7 business days") : "",
    notPortableReason: portable ? null : (result.not_portable_reason ?? "Not portable"),
    carrierName: result.carrier_name ?? null
  };
}

// ---------------------------------------------------------------------------
// Create (wizard submit)
// ---------------------------------------------------------------------------

export type ByonDocumentInput = {
  /** Raw file bytes, base64-encoded (no data: prefix). */
  base64: string;
  filename: string;
};

export type CreateByonPortRequestInput = {
  phone: string;
  carrier: {
    /** Business name exactly as it appears on the losing carrier's account. */
    entityName: string;
    /** Person authorized to port (matches the LOA signature). */
    authorizedName: string;
    accountNumber: string;
    pin?: string;
    billingPhone?: string;
  };
  serviceAddress: {
    street: string;
    extended?: string;
    city: string;
    state: string;
    zip: string;
    /** Defaults to US. */
    country?: string;
  };
  loa: ByonDocumentInput;
  bill: ByonDocumentInput;
  /** Optional ISO datetime for the requested FOC (activation) date. */
  focDatetimeRequested?: string;
};

export type CreateByonPortRequestResult = {
  /**
   * One row per Telnyx porting order (a single submit can split into
   * several). Each row's `status` reflects its own outcome — `submitted`
   * when confirmed, `draft` with a SUBMIT_FAILED detail when the carrier
   * side rejected that order.
   */
  rows: NumberPortRequestRow[];
  /** True only when EVERY order confirmed; check rows for partial results. */
  submitted: boolean;
  /** First failure's owner-facing explanation when submitted is false. */
  submitError: string | null;
};

function validateDocument(doc: ByonDocumentInput, label: string): void {
  if (!doc?.base64?.trim()) {
    throw new ByonValidationError(`Upload the ${label} PDF first.`);
  }
  if (!doc.filename?.trim()) {
    throw new ByonValidationError(`The ${label} upload is missing a filename.`);
  }
  // base64 inflates bytes by 4/3 — compare in encoded space to avoid decoding.
  if (doc.base64.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3)) {
    throw new ByonValidationError(`The ${label} file is too large (max 5 MB).`);
  }
}

function requireField(value: string | undefined, message: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new ByonValidationError(message);
  return trimmed;
}

export async function createByonPortRequest(
  businessId: string,
  input: CreateByonPortRequestInput,
  deps: ByonDeps = {}
): Promise<CreateByonPortRequestResult> {
  const phoneE164 = requireE164(input.phone);
  const entityName = requireField(
    input.carrier?.entityName,
    "Enter the business name on your current carrier's account."
  );
  const authorizedName = requireField(
    input.carrier?.authorizedName,
    "Enter the name of the person authorized to port this number."
  );
  const accountNumber = requireField(
    input.carrier?.accountNumber,
    "Enter your current carrier account number."
  );
  const street = requireField(input.serviceAddress?.street, "Enter the service street address.");
  const city = requireField(input.serviceAddress?.city, "Enter the service address city.");
  const state = requireField(input.serviceAddress?.state, "Enter the service address state.");
  const zip = requireField(input.serviceAddress?.zip, "Enter the service address ZIP code.");
  // Validate optional inputs UP FRONT too — a bad billing phone must fail as
  // a 400 before any Telnyx order/document exists, not mid-submit.
  const billingPhoneE164 = input.carrier?.billingPhone?.trim()
    ? requireE164(input.carrier.billingPhone)
    : null;
  validateDocument(input.loa, "signed LOA");
  validateDocument(input.bill, "recent bill");

  const porting = getPorting(deps);
  const db = await resolveDb(deps.client);

  const orders = await porting.createPortingOrder({
    phoneNumbers: [phoneE164],
    customerReference: `byon:${businessId}`
  });
  if (orders.length === 0) {
    throw new Error("Telnyx did not return a porting order for this number.");
  }

  // Telnyx deletes unlinked documents after 30 minutes — upload right before
  // the PATCH that links them.
  const [loaDoc, billDoc] = await Promise.all([
    porting.uploadDocument({
      base64: input.loa.base64,
      filename: input.loa.filename,
      customerReference: `byon:${businessId}:loa`
    }),
    porting.uploadDocument({
      base64: input.bill.base64,
      filename: input.bill.filename,
      customerReference: `byon:${businessId}:bill`
    })
  ]);

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const webhookUrl = `${appUrl}/api/telnyx/porting-webhook`;

  // Persist tracking rows BEFORE anything is submitted to the carrier. If
  // the insert fails, the Telnyx orders are still unconfirmed drafts (safe
  // to abandon); the reverse ordering could confirm a port that no webhook
  // row can ever match.
  const nowIso = new Date().toISOString();
  const { data: insertedRows, error: insertErr } = await db
    .from("number_port_requests")
    .insert(
      orders.map((order) => ({
        business_id: businessId,
        phone_e164: phoneE164,
        telnyx_order_id: order.id,
        status: order.status?.value ?? "draft",
        status_detail: order.status?.details ?? null,
        foc_at: null,
        support_key: order.support_key ?? null,
        loa_document_id: loaDoc.id,
        invoice_document_id: billDoc.id,
        created_at: nowIso,
        updated_at: nowIso
      }))
    )
    .select();
  if (insertErr) throw new Error(`createByonPortRequest: ${insertErr.message}`);

  // One phone number normally yields one order, but Telnyx can split — treat
  // each order independently so one carrier-side rejection doesn't strand
  // the others. `submitted` means "every order confirmed".
  let submitted = true;
  let submitError: string | null = null;
  const finalRows: NumberPortRequestRow[] = [];

  for (const order of orders) {
    let finalOrder: PortingOrder = order;
    let confirmError: string | null = null;
    try {
      await porting.updatePortingOrder(order.id, {
        documents: { loa: loaDoc.id, invoice: billDoc.id },
        endUser: {
          admin: {
            entity_name: entityName,
            auth_person_name: authorizedName,
            account_number: accountNumber,
            ...(input.carrier.pin?.trim() ? { pin_passcode: input.carrier.pin.trim() } : {}),
            ...(billingPhoneE164 ? { billing_phone_number: billingPhoneE164 } : {})
          },
          location: {
            street_address: street,
            ...(input.serviceAddress.extended?.trim()
              ? { extended_address: input.serviceAddress.extended.trim() }
              : {}),
            locality: city,
            administrative_area: state,
            postal_code: zip,
            country_code: (input.serviceAddress.country ?? "US").toUpperCase()
          }
        },
        misc: { type: "full" },
        ...(input.focDatetimeRequested ? { focDatetimeRequested: input.focDatetimeRequested } : {}),
        webhookUrl
      });
      finalOrder = await porting.confirmPortingOrder(order.id);
    } catch (err) {
      // Update/confirm can fail on carrier-side validation (e.g. requirements
      // not met). Keep the draft + documents so the owner can fix and
      // resubmit instead of losing everything they typed — and keep going so
      // sibling orders in a split still submit.
      submitted = false;
      confirmError = errMessage(err);
      submitError = submitError ?? confirmError;
      logger.warn("byon: porting order submit failed; kept as draft", {
        businessId,
        orderId: order.id,
        error: confirmError
      });
    }

    // Refresh the tracking row from the confirm snapshot — but only while it
    // still holds the status we inserted. Telnyx can deliver a
    // status_changed webhook between confirm and this write; a newer webhook
    // state (exception details, ported, …) must never be clobbered by the
    // older confirm response, so the update is conditional on the status.
    const insertedStatus = order.status?.value ?? "draft";
    const { data: updatedRows, error: updateErr } = await db
      .from("number_port_requests")
      .update({
        status: finalOrder.status?.value ?? (confirmError ? "draft" : "submitted"),
        status_detail: confirmError
          ? [{ code: "SUBMIT_FAILED", description: confirmError }]
          : (finalOrder.status?.details ?? null),
        foc_at:
          finalOrder.activation_settings?.foc_datetime_actual ??
          finalOrder.activation_settings?.foc_datetime_requested ??
          null,
        support_key: finalOrder.support_key ?? null,
        updated_at: new Date().toISOString()
      })
      .eq("telnyx_order_id", order.id)
      .eq("status", insertedStatus)
      .select();
    const updatedRow = ((updatedRows ?? []) as NumberPortRequestRow[])[0] ?? null;
    if (updateErr) {
      // The row exists and the webhook will heal its status; don't fail the
      // whole submit over a bookkeeping write.
      logger.warn("byon: failed to refresh port request row after submit", {
        businessId,
        orderId: order.id,
        error: updateErr.message
      });
    }
    if (updatedRow) {
      finalRows.push(updatedRow);
      continue;
    }
    if (!updateErr) {
      // Zero rows matched: a webhook already advanced the status. Return the
      // row as the webhook left it.
      const { data: current } = await db
        .from("number_port_requests")
        .select("*")
        .eq("telnyx_order_id", order.id)
        .maybeSingle();
      if (current) {
        finalRows.push(current as NumberPortRequestRow);
        continue;
      }
    }
    const fallback = ((insertedRows ?? []) as NumberPortRequestRow[]).find(
      (r) => r.telnyx_order_id === order.id
    );
    if (fallback) finalRows.push(fallback);
  }

  return { rows: finalRows, submitted, submitError };
}

// ---------------------------------------------------------------------------
// List / cancel
// ---------------------------------------------------------------------------

export async function listByonPortRequests(
  businessId: string,
  client?: SupabaseClient
): Promise<NumberPortRequestRow[]> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("number_port_requests")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listByonPortRequests: ${error.message}`);
  return (data ?? []) as NumberPortRequestRow[];
}

export async function cancelByonPortRequest(
  businessId: string,
  requestId: string,
  deps: ByonDeps = {}
): Promise<NumberPortRequestRow | null> {
  const db = await resolveDb(deps.client);
  const { data: row, error } = await db
    .from("number_port_requests")
    .select("*")
    .eq("id", requestId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`cancelByonPortRequest: ${error.message}`);
  if (!row) return null;

  const existing = row as NumberPortRequestRow;
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw new ByonValidationError(
      existing.status === "ported"
        ? "This number already finished porting — it can't be cancelled."
        : "This request is already cancelled."
    );
  }

  let nextStatus = "cancelled";
  if (existing.telnyx_order_id) {
    const porting = getPorting(deps);
    const order = await porting.cancelPortingOrder(existing.telnyx_order_id);
    // In-flight ports go through cancel-pending before the carrier confirms.
    nextStatus = order.status?.value ?? "cancel-pending";
  }

  const { data: updated, error: updateErr } = await db
    .from("number_port_requests")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("business_id", businessId)
    .select()
    .single();
  if (updateErr) throw new Error(`cancelByonPortRequest: ${updateErr.message}`);
  return updated as NumberPortRequestRow;
}

// ---------------------------------------------------------------------------
// Webhook: porting_order.status_changed
// ---------------------------------------------------------------------------

/** The `data.payload` of a porting_order.status_changed webhook. */
export type PortingWebhookOrderPayload = {
  id?: string;
  status?: { value?: string; details?: PortingExceptionDetail[] };
  activation_settings?: {
    foc_datetime_actual?: string | null;
    foc_datetime_requested?: string | null;
  };
  support_key?: string | null;
};

export type PortingStatusChangeResult = {
  /** False when no number_port_requests row matches the order id. */
  handled: boolean;
  /** True exactly when this event moved the request into `ported`. */
  ported: boolean;
  row: NumberPortRequestRow | null;
};

function statusSummary(status: string, phoneE164: string): string {
  switch (status) {
    case "exception":
      return `Action needed on your number port for ${phoneE164}`;
    case "foc-date-confirmed":
      return `Port date confirmed for ${phoneE164}`;
    case "ported":
      return `Your number ${phoneE164} finished porting`;
    default:
      return `Your number port for ${phoneE164} was cancelled`;
  }
}

export async function handlePortingStatusChange(
  payload: PortingWebhookOrderPayload,
  deps: ByonDeps = {},
  /** `data.occurred_at` of the webhook event, used to order backward moves. */
  occurredAt: string | null = null
): Promise<PortingStatusChangeResult> {
  const orderId = payload.id?.trim();
  const status = payload.status?.value?.trim();
  if (!orderId || !status) return { handled: false, ported: false, row: null };

  const db = await resolveDb(deps.client);
  const { data: existing, error } = await db
    .from("number_port_requests")
    .select("*")
    .eq("telnyx_order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`handlePortingStatusChange: ${error.message}`);
  if (!existing) {
    logger.warn("byon: porting webhook for unknown order", { orderId, status });
    return { handled: false, ported: false, row: null };
  }

  const prior = existing as NumberPortRequestRow;
  if (!shouldApplyStatusChange(prior, status, occurredAt)) {
    logger.warn("byon: dropped stale porting status event", {
      orderId,
      priorStatus: prior.status,
      status,
      occurredAt
    });
    return { handled: true, ported: false, row: prior };
  }

  const focAt =
    payload.activation_settings?.foc_datetime_actual ??
    payload.activation_settings?.foc_datetime_requested ??
    prior.foc_at;

  // A status TRANSITION owns the details outright (clearing stale exception
  // codes when the port recovers). A redelivery of the same status only
  // overwrites when it actually carries details — Telnyx retries can omit
  // them, and wiping stored exception codes would strip the dashboard of
  // its "here's how to fix it" hints.
  const payloadDetails = payload.status?.details ?? null;
  const statusDetail =
    status !== prior.status
      ? payloadDetails
      : payloadDetails && payloadDetails.length > 0
        ? payloadDetails
        : prior.status_detail;

  const { data: updated, error: updateErr } = await db
    .from("number_port_requests")
    .update({
      status,
      status_detail: statusDetail,
      foc_at: focAt,
      support_key: payload.support_key ?? prior.support_key,
      updated_at: new Date().toISOString()
    })
    .eq("id", prior.id)
    .select()
    .single();
  if (updateErr) throw new Error(`handlePortingStatusChange: ${updateErr.message}`);
  const row = updated as NumberPortRequestRow;

  // Only alert on transitions into a milestone — Telnyx re-delivers webhooks,
  // and repeats of the same status must not re-ping the owner.
  if (status !== prior.status && NOTIFY_STATUSES.has(status)) {
    const dispatch = deps.dispatch ?? dispatchUrgentNotification;
    try {
      await dispatch({
        businessId: prior.business_id,
        summary: statusSummary(status, prior.phone_e164),
        kind: "byon_port",
        payload: {
          phone_e164: prior.phone_e164,
          port_request_id: prior.id,
          telnyx_order_id: orderId,
          status,
          status_detail: payload.status?.details ?? [],
          foc_at: focAt
        }
      });
    } catch (err) {
      // Never fail the webhook (Telnyx would retry) because an alert didn't send.
      logger.warn("byon: status notification failed", {
        orderId,
        status,
        error: errMessage(err)
      });
    }
  }

  return { handled: true, ported: status === "ported" && prior.status !== "ported", row };
}
