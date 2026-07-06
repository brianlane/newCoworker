/**
 * Auto-text on missed calls (Standard/Enterprise perk, tier relaunch).
 *
 * When telnyx-voice-inbound refuses a call (all concurrent slots busy or
 * voice minutes exhausted), this helper follows up with ONE SMS from the
 * business's own number so the caller can continue over text — the reply
 * flows through the normal inbound-SMS AI pipeline.
 *
 * Gate chain (each independently skips, fail-safe — a refused call must
 * never error because of the follow-up text):
 *   1. caller is a real E.164 number (not anonymous / not the business DID)
 *   2. tier allows (standard/enterprise)
 *   3. per-tenant kill switch (business_channel_settings, default ON)
 *   4. CTIA opt-out (sms_is_opted_out)
 *   5. once-per-window dedup (try_mark_missed_call_autotext, 1h default)
 *   6. Telnyx messaging is configured for the tenant
 *   7. monthly SMS cap (try_reserve_sms_outbound_slot — customer-facing
 *      sends are metered like any other outbound)
 *
 * Dependency-injected (structural supabase type + fetchFn) so this is
 * unit-tested from vitest under the shared 100% coverage gate, mirroring
 * cap_alerts.ts / channel_settings.ts.
 */

type Row = { data: unknown; error: { message: string } | null };

export interface AutotextSupabase {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<Row>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<Row>;
    };
    delete(): {
      eq(column: string, value: string): PromiseLike<Row>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Row>;
}

export type MissedCallReason =
  | "concurrent_limit"
  | "quota_exhausted"
  // A call the routing layer forwarded/transferred to a human that rang out
  // unanswered. Same follow-up as a refused call: text the caller so the
  // conversation can continue over SMS (telnyx-voice-call-end fires this).
  | "forwarded_no_answer";

export type MissedCallAutotextOutcome = {
  status: "sent" | "skipped" | "failed";
  /**
   * Machine-readable detail: no_caller | tier | disabled | opt_out | deduped |
   * no_messaging | sms_cap:<reason> | telnyx_<status> | <error>. Unset on
   * "sent".
   */
  reason?: string;
  telnyxMessageId?: string;
};

/** One auto-text per (business, caller) per hour. */
export const MISSED_CALL_AUTOTEXT_WINDOW_SECONDS = 3600;

/** Tiers entitled to the missed-call auto-text perk. */
export function missedCallAutotextTierAllowed(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/** Follow-up copy; keeps under one SMS segment-ish and invites a reply. */
export function buildMissedCallAutotextMessage(businessName: string | null | undefined): string {
  const name = (businessName ?? "").trim();
  const intro = name.length > 0 ? `Sorry we missed your call! This is ${name}.` : "Sorry we missed your call!";
  return `${intro} Reply here and we'll help you by text.`;
}

export async function sendMissedCallAutotext(
  supabase: AutotextSupabase,
  opts: {
    businessId: string;
    /** Caller's number from the inbound call webhook; null/garbage skips. */
    callerE164: string | null;
    reason: MissedCallReason;
    telnyxApiKey: string;
    /** Env fallbacks (TELNYX_MESSAGING_PROFILE_ID / TELNYX_SMS_FROM_E164). */
    defaultMessagingProfileId: string;
    defaultFromE164: string;
    fetchFn?: typeof fetch;
  }
): Promise<MissedCallAutotextOutcome> {
  try {
    const caller = (opts.callerE164 ?? "").trim();
    if (!/^\+\d{7,15}$/.test(caller)) {
      return { status: "skipped", reason: "no_caller" };
    }

    const { data: bizData, error: bizErr } = await supabase
      .from("businesses")
      .select("tier, name")
      .eq("id", opts.businessId)
      .maybeSingle();
    if (bizErr) return { status: "failed", reason: `business_lookup:${bizErr.message}` };
    const biz = bizData as { tier?: string | null; name?: string | null } | null;
    if (!missedCallAutotextTierAllowed(biz?.tier)) {
      return { status: "skipped", reason: "tier" };
    }

    // Kill switch: a missing row (or read error) means default-on — the perk
    // ships enabled for every entitled tenant.
    const { data: chData } = await supabase
      .from("business_channel_settings")
      .select("missed_call_autotext_enabled")
      .eq("business_id", opts.businessId)
      .maybeSingle();
    const ch = chData as { missed_call_autotext_enabled?: boolean } | null;
    if (ch?.missed_call_autotext_enabled === false) {
      return { status: "skipped", reason: "disabled" };
    }

    const { data: optedRaw, error: optErr } = await supabase.rpc("sms_is_opted_out", {
      p_business_id: opts.businessId,
      p_sender_e164: caller
    });
    // Opt-out lookup errors fail toward NOT sending: an auto-text is
    // marketing-adjacent, so unlike the AI reply path we don't risk texting
    // an opted-out number.
    if (optErr) return { status: "skipped", reason: "opt_out_lookup_failed" };
    if (optedRaw === true) return { status: "skipped", reason: "opt_out" };

    const { data: claimRaw, error: claimErr } = await supabase.rpc(
      "try_mark_missed_call_autotext",
      {
        p_business_id: opts.businessId,
        p_caller_e164: caller,
        p_reason: opts.reason,
        p_window_seconds: MISSED_CALL_AUTOTEXT_WINDOW_SECONDS
      }
    );
    if (claimErr) return { status: "failed", reason: `dedup:${claimErr.message}` };
    const ledgerId = typeof claimRaw === "string" && claimRaw.length > 0 ? claimRaw : null;
    if (!ledgerId) return { status: "skipped", reason: "deduped" };

    // If we bail before a send is actually attempted (missing config, SMS cap,
    // reserve error), give the dedup claim back so a later missed call in the
    // window can still trigger the text once the blocker clears.
    const releaseLedger = async () => {
      await supabase.from("missed_call_autotexts").delete().eq("id", ledgerId);
    };

    const { data: tsetData } = await supabase
      .from("business_telnyx_settings")
      .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
      .eq("business_id", opts.businessId)
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
    if (!opts.telnyxApiKey || !messagingProfileId || !fromE164 || fromE164 === caller) {
      await releaseLedger();
      return { status: "skipped", reason: "no_messaging" };
    }

    // Customer-facing send → metered against the monthly SMS pool like every
    // other outbound (see README "SMS hard stop" policy).
    const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
      "try_reserve_sms_outbound_slot",
      { p_business_id: opts.businessId }
    );
    if (reserveErr) {
      await releaseLedger();
      return { status: "failed", reason: `sms_reserve:${reserveErr.message}` };
    }
    const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
    if (!reserve?.ok) {
      await releaseLedger();
      return { status: "skipped", reason: `sms_cap:${reserve?.reason ?? "monthly_sms_limit"}` };
    }

    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      const doFetch = opts.fetchFn ?? fetch;
      res = await doFetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.telnyxApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          to: caller,
          from: fromE164,
          text: buildMissedCallAutotextMessage(biz?.name ?? null),
          messaging_profile_id: messagingProfileId
        })
      });
    } catch (fetchErr) {
      // Network-level failure: nothing left Telnyx, so give the metered slot
      // back before surfacing the error.
      await supabase.rpc("release_sms_outbound_slot", {
        p_business_id: opts.businessId,
        p_refund_bonus: reserve.source === "bonus"
      });
      return {
        status: "failed",
        reason: fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      };
    }
    if (!res.ok) {
      // Give the metered slot back — the send never left Telnyx. The dedup
      // ledger row intentionally stays: retrying a rejected send on the next
      // missed call within the window would just fail again and spam logs.
      await supabase.rpc("release_sms_outbound_slot", {
        p_business_id: opts.businessId,
        p_refund_bonus: reserve.source === "bonus"
      });
      return { status: "failed", reason: `telnyx_${res.status}` };
    }
    const json = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
    const mid = json?.data?.id ?? "";
    if (mid) {
      await supabase
        .from("missed_call_autotexts")
        .update({ telnyx_message_id: mid })
        .eq("id", ledgerId);
    }
    return { status: "sent", ...(mid ? { telnyxMessageId: mid } : {}) };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err)
    };
  }
}
