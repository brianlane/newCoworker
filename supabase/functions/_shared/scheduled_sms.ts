/**
 * Scheduled SMS dispatch (Standard/Enterprise perk, tier relaunch).
 *
 * Owners queue texts for a future send time from the dashboard
 * (`/api/dashboard/messages/schedule`); the scheduled-sms-sweep Edge cron
 * calls processDueScheduledSms every minute to dispatch what's due.
 *
 * Per-row gate chain (each failure marks THAT row and moves on — one bad row
 * must never wedge the batch):
 *   1. tier still allows (standard/enterprise — a downgrade between
 *      scheduling and dispatch voids the perk)
 *   2. CTIA opt-out (sms_is_opted_out) → canceled, not failed
 *   3. Telnyx messaging configured for the tenant
 *   4. monthly SMS cap (try_reserve_sms_outbound_slot — owner-scheduled
 *      sends are customer-facing and metered like any other outbound)
 *   5. Telnyx send (idempotency key scheduled_sms:<id> makes stale-claim
 *      retries safe), RCS-first for eligible tenants
 *
 * Dependency-injected (structural supabase type + fetchFn) so this is
 * unit-tested from vitest under the shared 100% coverage gate, mirroring
 * missed_call_autotext.ts / cap_alerts.ts.
 */

import { telnyxSendSms } from "./telnyx_sms_compliance.ts";
import { resolveRcsAgentId } from "./channel_settings.ts";
import { sendCapAlertOnce, smsCapPeriodKey } from "./cap_alerts.ts";

type Row = { data: unknown; error: { message: string } | null };

export interface ScheduledSmsSupabase {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<Row>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<Row>;
    };
    insert(values: Record<string, unknown>): PromiseLike<Row>;
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Row>;
}

export type ScheduledSmsRow = {
  id: string;
  business_id: string;
  to_e164: string;
  body: string;
};

export type ScheduledSmsOutcome = {
  id: string;
  status: "sent" | "canceled" | "failed";
  /** Machine-readable detail; unset on "sent". */
  detail?: string;
};

/** Tiers entitled to scheduled + template SMS. */
export function scheduledSmsTierAllowed(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/** Claim batch size per sweep run (the RPC clamps to 1..100 anyway). */
export const SCHEDULED_SMS_BATCH_SIZE = 25;

export async function processDueScheduledSms(
  supabase: ScheduledSmsSupabase,
  opts: {
    telnyxApiKey: string;
    /** Env fallbacks (TELNYX_MESSAGING_PROFILE_ID / TELNYX_SMS_FROM_E164). */
    defaultMessagingProfileId: string;
    defaultFromE164: string;
    /** `${SUPABASE_URL}/functions/v1/notifications` + cron bearer for the
     * once-per-period SMS cap alert. Omit to skip alerting. */
    notifyUrl?: string;
    notifyBearer?: string;
    batchSize?: number;
    fetchFn?: typeof fetch;
  }
): Promise<{ claimed: number; outcomes: ScheduledSmsOutcome[] }> {
  const { data: claimedRaw, error: claimErr } = await supabase.rpc("claim_due_scheduled_sms", {
    p_limit: opts.batchSize ?? SCHEDULED_SMS_BATCH_SIZE
  });
  if (claimErr) throw new Error(`claim_due_scheduled_sms: ${claimErr.message}`);
  const rows = (Array.isArray(claimedRaw) ? claimedRaw : []) as ScheduledSmsRow[];

  const outcomes: ScheduledSmsOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await dispatchOne(supabase, row, opts));
  }
  return { claimed: rows.length, outcomes };
}

async function markRow(
  supabase: ScheduledSmsSupabase,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabase.from("scheduled_sms").update(values).eq("id", id);
    if (error) console.error("scheduled_sms mark failed", id, error.message);
  } catch (err) {
    // A row left in 'sending' is reclaimed by the sweep after 10 minutes and
    // the Telnyx idempotency key dedupes the retry, so swallowing is safe.
    console.error("scheduled_sms mark threw", id, err instanceof Error ? err.message : String(err));
  }
}

async function dispatchOne(
  supabase: ScheduledSmsSupabase,
  row: ScheduledSmsRow,
  opts: Parameters<typeof processDueScheduledSms>[1]
): Promise<ScheduledSmsOutcome> {
  const fail = async (detail: string): Promise<ScheduledSmsOutcome> => {
    await markRow(supabase, row.id, { status: "failed", error: detail });
    return { id: row.id, status: "failed", detail };
  };
  try {
    const { data: bizData, error: bizErr } = await supabase
      .from("businesses")
      .select("tier")
      .eq("id", row.business_id)
      .maybeSingle();
    if (bizErr) return await fail(`business_lookup:${bizErr.message}`);
    const tier = (bizData as { tier?: string | null } | null)?.tier ?? null;
    if (!scheduledSmsTierAllowed(tier)) return await fail("tier_not_allowed");

    // Opt-out is a recipient decision, not a system fault → canceled. A
    // lookup error fails toward NOT sending (scheduled texts are
    // marketing-adjacent; never risk texting an opted-out number).
    const { data: optedRaw, error: optErr } = await supabase.rpc("sms_is_opted_out", {
      p_business_id: row.business_id,
      p_sender_e164: row.to_e164
    });
    if (optErr) return await fail(`opt_out_lookup:${optErr.message}`);
    if (optedRaw === true) {
      await markRow(supabase, row.id, { status: "canceled", error: "recipient_opted_out" });
      return { id: row.id, status: "canceled", detail: "recipient_opted_out" };
    }

    const { data: tsetData } = await supabase
      .from("business_telnyx_settings")
      .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
      .eq("business_id", row.business_id)
      .maybeSingle();
    const tset = tsetData as
      | { telnyx_messaging_profile_id?: string | null; telnyx_sms_from_e164?: string | null }
      | null;
    const messagingProfileId =
      (tset?.telnyx_messaging_profile_id ?? "").length > 0
        ? String(tset?.telnyx_messaging_profile_id)
        : opts.defaultMessagingProfileId;
    const fromE164 =
      (tset?.telnyx_sms_from_e164 ?? "").length > 0
        ? String(tset?.telnyx_sms_from_e164)
        : opts.defaultFromE164;
    if (!opts.telnyxApiKey || !messagingProfileId) return await fail("no_messaging");

    const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
      "try_reserve_sms_outbound_slot",
      { p_business_id: row.business_id }
    );
    if (reserveErr) return await fail(`sms_reserve:${reserveErr.message}`);
    const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
    if (!reserve?.ok) {
      const reason = reserve?.reason ?? "monthly_sms_limit";
      if (reason === "monthly_sms_limit" && opts.notifyUrl && opts.notifyBearer) {
        await sendCapAlertOnce(supabase, {
          businessId: row.business_id,
          kind: "sms_monthly",
          periodKey: smsCapPeriodKey(),
          notifyUrl: opts.notifyUrl,
          bearer: opts.notifyBearer,
          payload: { trigger: "scheduled_sms" },
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {})
        });
      }
      return await fail(`sms_cap:${reason}`);
    }

    const release = async () => {
      const { error } = await supabase.rpc("release_sms_outbound_slot", {
        p_business_id: row.business_id,
        p_refund_bonus: reserve.source === "bonus"
      });
      if (error) console.error("release_sms_outbound_slot", row.id, error.message);
    };

    let send: Awaited<ReturnType<typeof telnyxSendSms>>;
    try {
      send = await telnyxSendSms({
        apiKey: opts.telnyxApiKey,
        messagingProfileId,
        ...(fromE164 ? { fromE164 } : {}),
        toE164: row.to_e164,
        text: row.body,
        // Stale-claim retries (sweep died mid-dispatch) reuse this key, so
        // Telnyx dedupes instead of double-texting the customer.
        idempotencyKey: `scheduled_sms:${row.id}`,
        rcsAgentId: await resolveRcsAgentId(supabase, row.business_id, tier),
        ...(opts.fetchFn ? { fetchImpl: opts.fetchFn } : {})
      });
    } catch (sendErr) {
      await release();
      return await fail(sendErr instanceof Error ? sendErr.message : String(sendErr));
    }
    if (!send.ok) {
      await release();
      return await fail(`telnyx_${send.status}`);
    }

    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(send.body) as { data?: { id?: string } })?.data?.id ?? null;
    } catch {
      messageId = null;
    }

    // Best-effort thread visibility — a failed log insert must not mark the
    // (already delivered) send as failed.
    const { error: logErr } = await supabase.from("sms_outbound_log").insert({
      business_id: row.business_id,
      to_e164: row.to_e164,
      from_e164: fromE164 || null,
      body: row.body,
      source: "owner_scheduled",
      run_id: null,
      flow_id: null,
      telnyx_message_id: messageId,
      channel: send.channel
    });
    if (logErr) console.error("scheduled_sms outbound log failed", row.id, logErr.message);

    await markRow(supabase, row.id, {
      status: "sent",
      sent_at: new Date().toISOString(),
      telnyx_message_id: messageId,
      error: null
    });
    return { id: row.id, status: "sent" };
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }
}
