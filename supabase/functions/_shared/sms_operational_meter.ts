/**
 * Operational-SMS metering (owner alerts, teammate acks, Safe-Mode
 * forwards, compliance auto-replies, provisioning notices).
 *
 * Policy (Jul 14 2026): NOTHING is exempt from the tenant's monthly SMS
 * metering. These sends were historically invisible to the quota ledger;
 * now every one counts via the `meter_sms_operational_send` RPC — plan
 * slot, bonus-text spill, or explicit overage — while remaining sends that
 * are never REFUSED (STOP/HELP/START replies are legally required, and
 * the cap alert itself must outrun the cap it reports).
 *
 * Both helpers are deliberately fire-safe: a metering failure logs and
 * returns instead of throwing, because blocking a compliance reply on a
 * ledger hiccup would invert the priority order.
 */

import { telnyxSendSms } from "./telnyx_sms_compliance.ts";

type RpcResult = { data: unknown; error: { message: string } | null };

export interface OperationalMeterSupabase {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

export type OperationalMeterOutcome = {
  counted: boolean;
  /** 'plan' | 'bonus' | 'overage' when counted; error/reason detail otherwise. */
  detail: string;
};

/**
 * Count one operational send against the tenant's pool. Never throws,
 * never refuses — the returned outcome is for logging/telemetry only.
 */
export async function meterOperationalSms(
  supabase: OperationalMeterSupabase,
  businessId: string
): Promise<OperationalMeterOutcome> {
  try {
    const { data, error } = await supabase.rpc("meter_sms_operational_send", {
      p_business_id: businessId
    });
    if (error) {
      console.warn(`meterOperationalSms(${businessId}): ${error.message}`);
      return { counted: false, detail: `rpc_error:${error.message}` };
    }
    const row = data as { counted?: boolean; source?: string; reason?: string } | null;
    if (row?.counted === true) {
      return { counted: true, detail: row.source ?? "plan" };
    }
    return { counted: false, detail: row?.reason ?? "not_counted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`meterOperationalSms(${businessId}): ${message}`);
    return { counted: false, detail: `error:${message}` };
  }
}

/**
 * Give a counted slot back after a send that never left Telnyx (network
 * error / non-2xx). Reuses release_sms_outbound_slot, refunding the bonus
 * text when the meter consumed one. Best-effort like the meter itself.
 */
export async function releaseOperationalSms(
  supabase: OperationalMeterSupabase,
  businessId: string,
  outcome: OperationalMeterOutcome
): Promise<void> {
  if (!outcome.counted) return;
  try {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: businessId,
      p_refund_bonus: outcome.detail === "bonus"
    });
    if (error) {
      console.warn(`releaseOperationalSms(${businessId}): ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `releaseOperationalSms(${businessId}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Metered wrapper for OPERATIONAL Edge sends (owner alerts, teammate acks,
 * Safe-Mode forwards, STOP/HELP/START compliance replies, provisioning
 * notices): count → send → release-on-failure. The send itself is never
 * blocked by the meter (count-only mode has no refusal path), so the
 * calling code's behavior is unchanged except that the tenant's ledger now
 * sees the traffic. `businessId` may be null for sends that could not be
 * routed to a tenant (e.g. a keyword reply on an unmapped DID) — those
 * have no pool to meter against and send as before.
 */
export async function sendOperationalSms(
  supabase: OperationalMeterSupabase,
  businessId: string | null,
  params: Parameters<typeof telnyxSendSms>[0]
): Promise<Awaited<ReturnType<typeof telnyxSendSms>>> {
  const outcome = businessId
    ? await meterOperationalSms(supabase, businessId)
    : { counted: false, detail: "no_business" };
  const send = await telnyxSendSms(params);
  if (!send.ok && businessId) {
    await releaseOperationalSms(supabase, businessId, outcome);
  }
  return send;
}
