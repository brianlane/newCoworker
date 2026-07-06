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
 * Trigger semantics: activation keys off durable row state — any webhook
 * delivery whose row shows `status = 'ported'` with `activated_at IS NULL`
 * attempts it, NOT just the delivery that claimed the ported alert. A worker
 * dying between the alert claim and the wiring therefore doesn't strand the
 * number: the next redelivery (a no-op for status purposes) retries the
 * activation. The wiring itself is idempotent (upserts + a 409-tolerant
 * 10DLC attach), so a rare concurrent double-run is harmless; `activated_at`
 * is stamped after success so settled rows skip the Telnyx calls entirely.
 *
 * Failure semantics: this function NEVER throws (a webhook 500 would make
 * Telnyx redeliver into a mostly-settled row). A failed activation logs
 * loudly, alerts the owner ("we're connecting your number, no action needed
 * yet"), leaves `activated_at` null so any later delivery retries, and can
 * always be finished manually via the idempotent admin assign-did tooling.
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
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { formatDid } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";
import type { NumberPortRequestRow } from "@/lib/byon/port-requests";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type PortedNumberRow = Pick<
  NumberPortRequestRow,
  | "id"
  | "business_id"
  | "phone_e164"
  | "telnyx_order_id"
  | "status"
  | "activated_at"
  | "activation_error"
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
  /** Inject for tests; defaults to the service-role Supabase client. */
  client?: SupabaseClient;
  /** Inject for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
};

export type ActivationResult = {
  /** False when the row didn't need activation (not ported / already done). */
  attempted: boolean;
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

const SKIPPED: ActivationResult = {
  attempted: false,
  activated: false,
  assign: null,
  tendlc: null,
  error: null
};

function needsActivation(row: PortedNumberRow): boolean {
  return row.status === "ported" && row.activated_at === null;
}

export async function activatePortedNumber(
  snapshot: PortedNumberRow,
  deps: ActivationDeps = {}
): Promise<ActivationResult> {
  const resolveClient = async () => deps.client ?? (await createSupabaseServiceClient());

  // Durable-state trigger: only ported rows that were never activated need
  // work. This makes the caller trivially safe to invoke on EVERY webhook
  // delivery (including redeliveries after a crashed activation). The
  // caller's snapshot can LAG the database (e.g. handlePortingStatusChange
  // drops a stale event and returns the pre-ported row it read while a
  // parallel delivery was moving it to ported), so before skipping we
  // re-check durable state — never the other way around: a snapshot that
  // qualifies was just read by the status handler.
  let row = snapshot;
  if (!needsActivation(row)) {
    try {
      const db = await resolveClient();
      const { data, error } = await db
        .from("number_port_requests")
        .select("*")
        .eq("id", snapshot.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      row = (data as PortedNumberRow | null) ?? snapshot;
    } catch (err) {
      logger.warn("byon: could not refresh port request before activation", {
        portRequestId: snapshot.id,
        error: errMessage(err)
      });
    }
    if (!needsActivation(row)) return SKIPPED;
  }

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

    // Alert-once: Telnyx redeliveries re-run activation while activated_at
    // is null, so a persistent failure would otherwise ping the owner on
    // every retry. The delivery that swaps activation_error NULL → error
    // (compare-and-swap) sends the single alert; later failures only log.
    // The claim also requires activated_at to STILL be null, so a slow
    // parallel failure can't record an error (or alert) after another
    // delivery already activated the number and cleared the field.
    let alertClaimed = false;
    if (row.activation_error === null) {
      try {
        const db = await resolveClient();
        const { data, error: claimErr } = await db
          .from("number_port_requests")
          .update({ activation_error: error })
          .eq("id", row.id)
          .is("activation_error", null)
          .is("activated_at", null)
          .select();
        if (claimErr) throw new Error(claimErr.message);
        alertClaimed = ((data ?? []) as unknown[]).length > 0;
      } catch (err) {
        // Can't tell whether an alert went out — stay quiet (the failure is
        // in the logs and a later delivery can still claim the alert).
        logger.warn("byon: failed to claim activation-failure alert", {
          portRequestId: row.id,
          error: errMessage(err)
        });
      }
    }

    if (alertClaimed) {
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
            `No action is needed from you. Our team has been notified and calls/texts will be live shortly.`
        });
      } catch (err) {
        logger.warn("byon: activation-failure notification failed", {
          portRequestId: row.id,
          error: errMessage(err)
        });
        // Release the claim so a later delivery re-attempts the alert —
        // otherwise a dispatch failure here would mute the owner forever.
        try {
          const db = await resolveClient();
          const { error: releaseErr } = await db
            .from("number_port_requests")
            .update({ activation_error: null })
            .eq("id", row.id)
            .eq("activation_error", error);
          if (releaseErr) throw new Error(releaseErr.message);
        } catch (releaseErr) {
          logger.error("byon: failed to release activation-failure alert claim", {
            portRequestId: row.id,
            error: errMessage(releaseErr)
          });
        }
      }
    }
    return { attempted: true, activated: false, assign: null, tendlc: null, error };
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

  // Stamp activated_at (and clear any recorded failure) so future
  // redeliveries skip the Telnyx calls. A failed stamp is non-fatal: the
  // wiring is idempotent, so the worst case is one redundant re-run on the
  // next redelivery.
  try {
    const db = await resolveClient();
    const { error: stampErr } = await db
      .from("number_port_requests")
      .update({ activated_at: new Date().toISOString(), activation_error: null })
      .eq("id", row.id)
      .is("activated_at", null);
    if (stampErr) {
      logger.warn("byon: failed to stamp activated_at", {
        portRequestId: row.id,
        error: stampErr.message
      });
    }
  } catch (err) {
    logger.warn("byon: failed to stamp activated_at", {
      portRequestId: row.id,
      error: errMessage(err)
    });
  }

  logger.info("byon: ported number activated", {
    portRequestId: row.id,
    businessId: row.business_id,
    phoneE164: row.phone_e164,
    tendlc: tendlc.kind
  });
  return { attempted: true, activated: true, assign, tendlc, error: null };
}
