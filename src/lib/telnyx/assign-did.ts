/**
 * High-level DID-to-business assignment flow.
 *
 * Two entry points:
 *
 *  - {@link assignExistingDidToBusiness}: operator already owns the DID inside
 *    our Telnyx account. We just associate it with the tenant (messaging
 *    profile + Call Control connection) and upsert the routing rows.
 *
 *  - {@link orderAndAssignDidForBusiness}: operator (or the orchestrator)
 *    wants to buy a new US DID for this tenant. We search the Telnyx
 *    inventory, place an order, wait for it to ship, associate the number
 *    with our platform wiring, then upsert the routing rows.
 *
 * Both paths end with the tenant having:
 *
 *   - one `telnyx_voice_routes` row pointing the DID at their `business_id`
 *     (with the per-tenant bridge WSS origin if it's known);
 *   - one `business_telnyx_settings` row caching the DID, messaging profile,
 *     connection id, and bridge origin so subsequent sends / routing read
 *     from the database instead of environment defaults.
 *
 * This module never reads env vars directly. The two public functions accept
 * a `platformDefaults` struct so tests can inject deterministic values and
 * so the admin/orchestrator callers can supply exactly the connection /
 * messaging profile ids the operator expects.
 */

import type { TelnyxNumbersClient, AvailablePhoneNumber, NumberOrder } from "@/lib/telnyx/numbers";
import {
  upsertTelnyxVoiceRoute,
  upsertBusinessTelnyxSettings,
  getBusinessTelnyxSettings,
  type TelnyxVoiceRouteRow,
  type BusinessTelnyxSettingsRow
} from "@/lib/db/telnyx-routes";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type PlatformTelnyxDefaults = {
  /** Platform Call Control Application id. */
  connectionId?: string;
  /** Platform Messaging Profile id. */
  messagingProfileId?: string;
  /** Fallback bridge WSS origin (wss://…). */
  bridgeMediaWssOrigin?: string;
};

export type AssignDidResult = {
  route: TelnyxVoiceRouteRow;
  settings: BusinessTelnyxSettingsRow;
  /** When the flow ordered a new number, this is set to the Telnyx order id. */
  orderId?: string;
};

export type AssignExistingDidInput = {
  businessId: string;
  toE164: string;
  platformDefaults?: PlatformTelnyxDefaults;
  /** When true, also PATCH the number in Telnyx to associate it with platform wiring. */
  associateWithPlatform?: boolean;
};

/**
 * Normalize an E.164 number to `+<digits>`. Throws on malformed input.
 */
export function normalizeE164(input: string): string {
  const trimmed = (input ?? "").trim();
  const digits = trimmed.replace(/[^\d+]/g, "");
  const stripped = digits.startsWith("+") ? `+${digits.slice(1).replace(/\+/g, "")}` : `+${digits}`;
  const rest = stripped.slice(1);
  if (rest.length < 8 || rest.length > 15 || !/^\d+$/.test(rest)) {
    throw new Error(`normalizeE164: invalid E.164 number: ${input}`);
  }
  return stripped;
}

async function resolveBridgeOrigin(
  businessId: string,
  platformDefaults: PlatformTelnyxDefaults | undefined,
  client: SupabaseClient
): Promise<string | null> {
  const existing = await getBusinessTelnyxSettings(businessId, client);
  if (existing?.bridge_media_wss_origin && existing.bridge_media_wss_origin.length > 0) {
    return existing.bridge_media_wss_origin;
  }
  return platformDefaults?.bridgeMediaWssOrigin ?? null;
}

export async function assignExistingDidToBusiness(
  input: AssignExistingDidInput,
  deps?: {
    telnyxNumbers?: TelnyxNumbersClient;
    client?: SupabaseClient;
  }
): Promise<AssignDidResult> {
  const toE164 = normalizeE164(input.toE164);
  const db = deps?.client ?? (await createSupabaseServiceClient());
  const bridgeOrigin = await resolveBridgeOrigin(input.businessId, input.platformDefaults, db);
  const connectionId = input.platformDefaults?.connectionId ?? null;
  const messagingProfileId = input.platformDefaults?.messagingProfileId ?? null;

  if (input.associateWithPlatform) {
    if (!deps?.telnyxNumbers) {
      throw new Error("assignExistingDidToBusiness: telnyxNumbers client required when associateWithPlatform=true");
    }
    await deps.telnyxNumbers.updatePhoneNumber({
      phoneNumberIdOrE164: toE164,
      connectionId: connectionId ?? undefined,
      messagingProfileId: messagingProfileId ?? undefined,
      customerReference: `business:${input.businessId}`
    });
  }

  const settings = await upsertBusinessTelnyxSettings(
    {
      businessId: input.businessId,
      telnyxSmsFromE164: toE164,
      telnyxMessagingProfileId: messagingProfileId,
      telnyxConnectionId: connectionId,
      bridgeMediaWssOrigin: bridgeOrigin
    },
    db
  );

  const route = await upsertTelnyxVoiceRoute(
    {
      toE164,
      businessId: input.businessId,
      mediaWssOrigin: bridgeOrigin,
      mediaPath: settings.bridge_media_path
    },
    db
  );

  return { route, settings };
}

export type OrderAndAssignDidInput = {
  businessId: string;
  platformDefaults?: PlatformTelnyxDefaults;
  search: {
    countryCode?: string;
    areaCode?: string;
    locality?: string;
    administrativeArea?: string;
    /** Passed to the Telnyx API; default is ["sms","voice"]. */
    features?: Array<"sms" | "voice" | "mms" | "fax" | "emergency">;
  };
  /** Polling budget for the number order (default 60_000ms). */
  orderTimeoutMs?: number;
};

export class OrderAndAssignError extends Error {
  public readonly reason:
    | "no_numbers_available"
    | "order_not_success"
    | "missing_ordered_number";
  public readonly order?: NumberOrder;
  constructor(
    reason: OrderAndAssignError["reason"],
    message: string,
    order?: NumberOrder
  ) {
    super(message);
    this.name = "OrderAndAssignError";
    this.reason = reason;
    this.order = order;
  }
}

export async function orderAndAssignDidForBusiness(
  input: OrderAndAssignDidInput,
  deps: {
    telnyxNumbers: TelnyxNumbersClient;
    client?: SupabaseClient;
  }
): Promise<AssignDidResult> {
  const candidates: AvailablePhoneNumber[] = await deps.telnyxNumbers.searchAvailable({
    countryCode: input.search.countryCode ?? "US",
    areaCode: input.search.areaCode,
    locality: input.search.locality,
    administrativeArea: input.search.administrativeArea,
    features: input.search.features ?? ["sms", "voice"],
    limit: 5
  });
  if (candidates.length === 0) {
    throw new OrderAndAssignError(
      "no_numbers_available",
      "Telnyx returned no available numbers matching the search criteria"
    );
  }

  const pick = candidates[0].phone_number;
  const order = await deps.telnyxNumbers.orderNumbers({
    phoneNumbers: [pick],
    connectionId: input.platformDefaults?.connectionId,
    messagingProfileId: input.platformDefaults?.messagingProfileId,
    customerReference: `business:${input.businessId}`
  });

  const finalOrder = await deps.telnyxNumbers.waitForNumberOrder(order.id, {
    timeoutMs: input.orderTimeoutMs ?? 60_000
  });

  if (finalOrder.status !== "success") {
    throw new OrderAndAssignError(
      "order_not_success",
      `Telnyx number order ${finalOrder.id} ended in status ${finalOrder.status}`,
      finalOrder
    );
  }

  const shipped = finalOrder.phone_numbers?.find((n) => n.phone_number === pick);
  if (!shipped) {
    throw new OrderAndAssignError(
      "missing_ordered_number",
      `Telnyx order ${finalOrder.id} did not include ${pick}`,
      finalOrder
    );
  }

  const result = await assignExistingDidToBusiness(
    {
      businessId: input.businessId,
      toE164: pick,
      platformDefaults: input.platformDefaults,
      associateWithPlatform: false // already set on the order
    },
    { client: deps.client }
  );

  return { ...result, orderId: finalOrder.id };
}
