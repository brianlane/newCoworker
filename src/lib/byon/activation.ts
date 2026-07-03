/**
 * BYON activation: wire a fully ported number into the tenant's platform
 * routing the moment Telnyx reports `ported`.
 *
 * A completed port only moves the number INTO our Telnyx account — nothing
 * points it at the tenant yet. Activation reuses the exact wiring purchased
 * numbers get:
 *
 *   1. `assignExistingDidToBusiness` — PATCH the number onto the platform
 *      Call Control connection + messaging profile, upsert the
 *      `telnyx_voice_routes` row and `business_telnyx_settings` (the ported
 *      number becomes the SMS "from"). The tenant's previously assigned
 *      platform DID keeps its own voice-route row, so it still works as a
 *      secondary route — releasing it is a deliberate, separate step.
 *   2. `attachBusinessDidToCampaign` — 10DLC shared-campaign attach so A2P
 *      SMS from the ported number actually delivers. `pending` outcomes are
 *      normal (the periodic retry worker finishes the job); only hard
 *      rejections are surfaced.
 *
 * Failure semantics: activation runs inside the porting webhook AFTER the
 * `ported` milestone was claimed, and Telnyx will not redeliver a webhook we
 * 200'd — so this function NEVER throws. A failed activation logs loudly,
 * alerts the owner ("we're connecting your number, no action needed yet"),
 * and leaves recovery to the admin assign-did tooling which performs the
 * same wiring idempotently.
 */

import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import {
  assignExistingDidToBusiness,
  type AssignDidResult
} from "@/lib/telnyx/assign-did";
import {
  assertPlatformTelnyxDefaults,
  readPlatformTelnyxDefaults
} from "@/lib/telnyx/platform-defaults";
import {
  attachBusinessDidToCampaign,
  type AttachOutcome
} from "@/lib/provisioning/tendlc-attach";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { formatDid } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";
import type { NumberPortRequestRow } from "@/lib/byon/port-requests";

export type PortedNumberRow = Pick<
  NumberPortRequestRow,
  "id" | "business_id" | "phone_e164" | "telnyx_order_id"
>;

export type ActivationDeps = {
  /** Inject for tests; defaults to the real assign flow. */
  assign?: typeof assignExistingDidToBusiness;
  /** Inject for tests; defaults to the real 10DLC attach. */
  attach?: typeof attachBusinessDidToCampaign;
  /** Inject for tests; defaults to dispatchUrgentNotification. */
  dispatch?: typeof dispatchUrgentNotification;
  /** Inject for tests; defaults to a real client built from TELNYX_API_KEY. */
  numbersClient?: TelnyxNumbersClient;
  /** Inject for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
};

export type ActivationResult = {
  /** True when the voice/SMS wiring (step 1) completed. */
  activated: boolean;
  assign: AssignDidResult | null;
  /** 10DLC outcome; null when activation failed before the attach step. */
  tendlc: AttachOutcome | null;
  error: string | null;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function activatePortedNumber(
  row: PortedNumberRow,
  deps: ActivationDeps = {}
): Promise<ActivationResult> {
  const env = deps.env ?? process.env;
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;

  const fail = async (error: string): Promise<ActivationResult> => {
    logger.error("byon: ported number activation failed", {
      portRequestId: row.id,
      businessId: row.business_id,
      phoneE164: row.phone_e164,
      telnyxOrderId: row.telnyx_order_id,
      error
    });
    try {
      await dispatch({
        businessId: row.business_id,
        summary: `We're connecting your ported number ${formatDid(row.phone_e164)}`,
        kind: "byon_activation",
        payload: {
          phone_e164: row.phone_e164,
          port_request_id: row.id,
          telnyx_order_id: row.telnyx_order_id,
          activation_error: error
        },
        emailBody:
          `Your number ${formatDid(row.phone_e164)} finished porting, and we're completing the final connection to your AI coworker. ` +
          `No action is needed from you — our team has been notified and calls/texts will be live shortly.`
      });
    } catch (err) {
      logger.warn("byon: activation-failure notification failed", {
        portRequestId: row.id,
        error: errMessage(err)
      });
    }
    return { activated: false, assign: null, tendlc: null, error };
  };

  const apiKey = env.TELNYX_API_KEY?.trim();
  if (!apiKey) return fail("TELNYX_API_KEY is not configured");

  const platformDefaults = readPlatformTelnyxDefaults(env);
  try {
    // Same canary as number purchases: a DID PATCHed with a blank
    // connection id routes nowhere and fails invisibly.
    assertPlatformTelnyxDefaults(platformDefaults);
  } catch (err) {
    return fail(errMessage(err));
  }

  let assign: AssignDidResult;
  try {
    assign = await (deps.assign ?? assignExistingDidToBusiness)(
      {
        businessId: row.business_id,
        toE164: row.phone_e164,
        platformDefaults,
        associateWithPlatform: true
      },
      { telnyxNumbers: deps.numbersClient ?? new TelnyxNumbersClient({ apiKey }) }
    );
  } catch (err) {
    return fail(errMessage(err));
  }

  // 10DLC attach is deliberately non-fatal: `pending` is the normal state
  // right after a port (the retry worker completes it), and voice + inbound
  // SMS already work without it.
  let tendlc: AttachOutcome;
  try {
    tendlc = await (deps.attach ?? attachBusinessDidToCampaign)({
      businessId: row.business_id,
      toE164: row.phone_e164
    });
  } catch (err) {
    tendlc = { kind: "error", reason: errMessage(err) };
  }
  if (tendlc.kind === "rejected" || tendlc.kind === "error") {
    logger.warn("byon: 10DLC attach for ported number did not complete", {
      portRequestId: row.id,
      businessId: row.business_id,
      phoneE164: row.phone_e164,
      reason: tendlc.reason
    });
  }

  logger.info("byon: ported number activated", {
    portRequestId: row.id,
    businessId: row.business_id,
    phoneE164: row.phone_e164,
    tendlc: tendlc.kind
  });
  return { activated: true, assign, tendlc, error: null };
}
