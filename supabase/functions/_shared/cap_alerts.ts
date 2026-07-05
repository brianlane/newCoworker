/**
 * Once-per-period urgent owner alerts (SMS monthly cap, shared Gemini spend
 * cap, missed-call spikes).
 *
 * Before this existed, a business hitting either cap got pure silence: an
 * inbound texter received nothing (outbound block) and chat replies quietly
 * degraded to the local model. The first cap hit per period now sends one
 * urgent owner notification through the existing `notifications` Edge
 * function (the same direct-POST contract vps/scripts/heartbeat.sh uses).
 *
 * Once-per-period dedupe lives in Postgres (`mark_usage_cap_alert`, unique on
 * business + cap kind + period key) so concurrent workers can't double-send.
 *
 * Dependency-free (caller injects the supabase client + fetch) so this is
 * unit-tested from vitest under the shared 100% coverage gate.
 */

export type CapAlertKind = "sms_monthly" | "chat_spend" | "missed_call_spike";

type DbResult = { data: unknown; error: { message: string } | null };

export interface CapAlertSupabase {
  // PromiseLike (not Promise) so supabase-js's thenable PostgrestFilterBuilder
  // satisfies the interface structurally.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DbResult>;
}

export function capAlertTaskType(kind: CapAlertKind): string {
  if (kind === "sms_monthly") return "sms_cap_reached";
  if (kind === "chat_spend") return "chat_spend_cap_reached";
  return "missed_call_spike";
}

/** UTC month-start period key for the SMS monthly cap (YYYY-MM-DD). */
export function smsCapPeriodKey(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export type CapAlertResult = "sent" | "already_alerted" | "mark_failed" | "post_failed";

/**
 * Send the urgent cap alert if this is the FIRST hit for (business, kind,
 * period). Never throws — alerting must never fail the send/turn that
 * discovered the cap.
 *
 * The mark RPC atomically claims the once-per-period guard BEFORE the post
 * (so concurrent workers can't double-send); if the post then fails, the
 * claim is ROLLED BACK so the next cap hit retries instead of the owner
 * silently never hearing about the cap for the whole period.
 */
export async function sendCapAlertOnce(
  supabase: CapAlertSupabase,
  opts: {
    businessId: string;
    kind: CapAlertKind;
    periodKey: string;
    /** `${SUPABASE_URL}/functions/v1/notifications` */
    notifyUrl: string;
    bearer: string;
    payload?: Record<string, unknown>;
    fetchFn?: typeof fetch;
  }
): Promise<CapAlertResult> {
  const unmark = async () => {
    try {
      const { error } = await supabase.rpc("unmark_usage_cap_alert", {
        p_business_id: opts.businessId,
        p_cap_kind: opts.kind,
        p_period_key: opts.periodKey
      });
      if (error) console.error("cap_alert unmark failed", opts.kind, error.message);
    } catch (err) {
      console.error(
        "cap_alert unmark failed",
        opts.kind,
        err instanceof Error ? err.message : String(err)
      );
    }
  };
  let marked = false;
  try {
    const { data, error } = await supabase.rpc("mark_usage_cap_alert", {
      p_business_id: opts.businessId,
      p_cap_kind: opts.kind,
      p_period_key: opts.periodKey
    });
    if (error) {
      console.error("cap_alert mark failed", opts.kind, error.message);
      return "mark_failed";
    }
    if (data !== true) return "already_alerted";
    marked = true;

    const doFetch = opts.fetchFn ?? fetch;
    const res = await doFetch(opts.notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.bearer}`
      },
      body: JSON.stringify({
        type: "INSERT",
        table: "coworker_logs",
        record: {
          id: crypto.randomUUID(),
          business_id: opts.businessId,
          task_type: capAlertTaskType(opts.kind),
          status: "urgent_alert",
          log_payload: { period_key: opts.periodKey, ...(opts.payload ?? {}) },
          created_at: new Date().toISOString()
        }
      })
    });
    if (!res.ok) {
      console.error("cap_alert post failed", opts.kind, res.status);
      await unmark();
      return "post_failed";
    }
    return "sent";
  } catch (err) {
    console.error("cap_alert unexpected", opts.kind, err instanceof Error ? err.message : String(err));
    if (marked) await unmark();
    return "post_failed";
  }
}
