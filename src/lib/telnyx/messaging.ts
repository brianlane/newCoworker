import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendCapAlertOnce, smsCapPeriodKey } from "../../../supabase/functions/_shared/cap_alerts";

export type TelnyxMessagingConfig = {
  apiKey: string;
  messagingProfileId: string;
  fromE164?: string;
  /**
   * Tenant's approved Telnyx RCS agent id. Set only by
   * `getTelnyxMessagingForBusiness(..., { resolveRcs: true })` when the tenant
   * is RCS-eligible (standard/enterprise tier + rcs_enabled + agent approved).
   * When present, `sendTelnyxSms` goes RCS-first with automatic SMS fallback.
   */
  rcsAgentId?: string | null;
};

/** Tiers entitled to the RCS channel (mirror of _shared/channel_settings.ts). */
export function rcsTierAllowed(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

export function readTelnyxMessagingConfig(
  env: Record<string, string | undefined> = process.env
): TelnyxMessagingConfig {
  const apiKey = env.TELNYX_API_KEY;
  const messagingProfileId = env.TELNYX_MESSAGING_PROFILE_ID;
  if (!apiKey || !messagingProfileId) {
    throw new Error("Missing Telnyx messaging configuration (TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID)");
  }
  return {
    apiKey,
    messagingProfileId,
    fromE164: env.TELNYX_SMS_FROM_E164
  };
}

/**
 * Merge platform Telnyx credentials with per-business messaging profile / from-number when set (§1).
 *
 * Pass `opts.resolveRcs: true` for CUSTOMER-FACING sends (dashboard composer,
 * assistant tool-calls, voice follow-up SMS) to also resolve the tenant's RCS
 * channel eligibility. Platform-operational sends (owner alerts, provisioning
 * notifications) omit it and stay plain SMS. The RCS gate is a three-way AND —
 * tier allows ∧ rcs_enabled ∧ agent id set — and any lookup error resolves to
 * no-RCS (fail-safe: SMS always works).
 */
export async function getTelnyxMessagingForBusiness(
  businessId: string | null | undefined,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  opts?: { resolveRcs?: boolean }
): Promise<TelnyxMessagingConfig> {
  const base = readTelnyxMessagingConfig();
  if (!businessId) return base;
  const db = client ?? (await createSupabaseServiceClient());
  const { data } = await db
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const profile = data?.telnyx_messaging_profile_id as string | null | undefined;
  const from = data?.telnyx_sms_from_e164 as string | null | undefined;
  const config: TelnyxMessagingConfig = {
    apiKey: base.apiKey,
    messagingProfileId: profile && profile.length > 0 ? profile : base.messagingProfileId,
    fromE164: from && from.length > 0 ? from : base.fromE164
  };
  if (opts?.resolveRcs) {
    config.rcsAgentId = await resolveRcsAgentIdForBusiness(db, businessId);
  }
  return config;
}

/**
 * Resolve the tenant's RCS agent id, or null when sends must stay plain SMS.
 * Node-side mirror of supabase/functions/_shared/channel_settings.ts.
 */
export async function resolveRcsAgentIdForBusiness(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string
): Promise<string | null> {
  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr || !rcsTierAllowed((biz as { tier?: string | null } | null)?.tier)) return null;

  const { data, error } = await db
    .from("business_channel_settings")
    .select("rcs_agent_id, rcs_enabled")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) return null;
  const row = data as { rcs_agent_id?: string | null; rcs_enabled?: boolean } | null;
  if (!row?.rcs_enabled) return null;
  const agentId = (row.rcs_agent_id ?? "").trim();
  return agentId.length > 0 ? agentId : null;
}

/**
 * Whether composer sends for this business will actually go RCS-first.
 * Mirrors the exact precondition in `sendTelnyxSms` — an approved agent id
 * AND a concrete from-number for the SMS fallback — so UI hints (channel
 * badge, segment warnings) never claim RCS while sends fall through to plain
 * SMS. Any config/lookup error resolves to false (plain-SMS hints are the
 * safe default).
 */
export async function rcsChannelActiveForBusiness(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string
): Promise<boolean> {
  try {
    const cfg = await getTelnyxMessagingForBusiness(businessId, db, { resolveRcs: true });
    return Boolean((cfg.rcsAgentId ?? "").trim() && cfg.fromE164);
  } catch {
    return false;
  }
}

export type SendTelnyxSmsOptions = {
  fetchImpl?: typeof fetch;
  /** Telnyx supports Idempotency-Key for at-most-once sends (§10). */
  idempotencyKey?: string;
  /**
   * When set, atomically reserves one outbound SMS against this business's monthly cap (Postgres row lock + pre-increment)
   * before calling Telnyx. Omit for platform-operational messages (e.g. owner alerts) so they do not consume the customer's pool.
   * If the HTTP request fails after a reserve, the slot is released so quota is not consumed.
   */
  meterBusinessId?: string;
  /**
   * Per-business outbound throttle (application-level MPS cap, §16). Call sms_outbound_
   * rate_check before the send. Defaults to 10 messages / second per business (aligns
   * with Telnyx long-code throughput). Set to 0 to disable. Only consulted when
   * meterBusinessId is set (platform-operational messages bypass throttling).
   */
  throttleMaxPerSecond?: number;
};

type TelnyxMessageResponse = { data?: { id?: string } };

export type SendTelnyxSmsResult = {
  /** Telnyx message id. */
  id: string;
  /**
   * Channel the accepted send went out on: "rcs" = RCS-first with Telnyx-side
   * SMS fallback; "sms" = plain SMS (including when an RCS API rejection made
   * us re-send plain). Persist this on message logs so threads can badge it.
   */
  channel: "sms" | "rcs";
};

type ReserveSlotResult = { ok?: boolean; reason?: string; source?: string };

const DEFAULT_THROTTLE_MAX_PER_SECOND = 10;

/** Maps try_reserve_sms_outbound_slot JSON to a user-facing error (tests assert stable reasons). */
export function reserveSlotFailureMessage(result: ReserveSlotResult | null): string {
  const r = result?.reason;
  if (r === "monthly_sms_limit") return "Monthly SMS limit reached";
  if (r === "no_business") return "Business not found";
  if (r === "throttled") return "SMS throughput throttled (please retry in a moment)";
  if (r && r.length > 0) return `SMS quota blocked: ${r}`;
  return "SMS quota blocked";
}

/**
 * Send a customer message via Telnyx Messaging API v2.
 *
 * When `config.rcsAgentId` is set (tenant is RCS-eligible) AND the config has
 * a concrete from-number for the SMS fallback, the message goes out RCS-first
 * (`POST /v2/messages/rcs`: verified-brand sender, read receipts on
 * Android/iOS 18+) with Telnyx-side automatic SMS fallback to non-RCS
 * handsets. If the RCS endpoint itself rejects the request (agent revoked,
 * destination not RCS-routable, etc.) we re-send as plain SMS in the same
 * call so the customer never loses a message to channel plumbing. Metering
 * (`try_reserve_sms_outbound_slot`) is identical on both channels — one
 * monthly pool regardless of channel, per the plan.
 *
 * @returns Telnyx message id + the channel that accepted the send
 */
export async function sendTelnyxSms(
  config: TelnyxMessagingConfig,
  toE164: string,
  text: string,
  options?: SendTelnyxSmsOptions
): Promise<SendTelnyxSmsResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  let meterClient: Awaited<ReturnType<typeof createSupabaseServiceClient>> | undefined;
  let reservedSlot = false;
  let reservedFromBonus = false;
  const businessId = options?.meterBusinessId;

  if (businessId) {
    meterClient = await createSupabaseServiceClient();

    // Throughput throttle first: refuses fast when a runaway notification loop would
    // otherwise burn through the monthly reserve before we learn anything is wrong.
    const throttleMax = options?.throttleMaxPerSecond ?? DEFAULT_THROTTLE_MAX_PER_SECOND;
    if (throttleMax > 0) {
      const { data: tRaw, error: tErr } = await meterClient.rpc("sms_outbound_rate_check", {
        p_business_id: businessId,
        p_max_per_window: throttleMax,
        p_window_seconds: 1
      });
      if (tErr) {
        // Fail open on throttle-check DB errors: quota reservation below still enforces
        // the monthly cap, and a throttle outage is strictly preferable to dropping
        // legitimate customer traffic. Surface in logs for operators.
        console.warn("sendTelnyxSms: sms_outbound_rate_check failed (fail-open)", tErr.message);
      } else {
        const tRes = tRaw as ReserveSlotResult | null;
        if (tRes && tRes.ok === false) {
          throw new Error(reserveSlotFailureMessage(tRes));
        }
      }
    }

    const { data: res, error } = await meterClient.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: businessId
    });
    if (error) {
      throw new Error(`sendTelnyxSms: quota reserve failed: ${error.message}`);
    }
    const gate = res as ReserveSlotResult | null;
    if (!gate?.ok) {
      if (gate?.reason === "monthly_sms_limit") {
        // One urgent owner alert per month when the cap first blocks a send,
        // so the owner learns about it before customers report silence.
        await sendCapAlertOnce(meterClient, {
          businessId,
          kind: "sms_monthly",
          periodKey: smsCapPeriodKey(),
          notifyUrl: `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/notifications`,
          bearer: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          payload: { surface: "app_send_sms" },
          fetchFn: fetchImpl
        });
      }
      throw new Error(reserveSlotFailureMessage(gate));
    }
    reservedSlot = true;
    reservedFromBonus = gate.source === "bonus";
  }

  const releaseIfNeeded = async (): Promise<void> => {
    if (!reservedSlot || !businessId || !meterClient) return;
    const { error: relErr } = await meterClient.rpc("release_sms_outbound_slot", {
      p_business_id: businessId,
      // Bonus-sourced reserves consumed a purchased text; refund it to the grant.
      p_refund_bonus: reservedFromBonus
    });
    if (relErr) {
      // Leave reservedSlot=true so any retry on this path (or an upstream wrapper calling
      // releaseIfNeeded again) re-attempts the release. Silently flipping it to false on
      // error would strand the monthly-quota slot on the `businesses` row in the DB with
      // no client-side retry path — a long-lived quota leak until manual reconciliation.
      console.error("sendTelnyxSms: release_sms_outbound_slot failed (will keep slot flagged)", relErr.message);
      return;
    }
    reservedSlot = false;
  };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    };
    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    const rcsAgentId = (config.rcsAgentId ?? "").trim();
    if (rcsAgentId && config.fromE164) {
      const rcsRes = await fetchImpl("https://api.telnyx.com/v2/messages/rcs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent_id: rcsAgentId,
          to: toE164,
          messaging_profile_id: config.messagingProfileId,
          type: "RCS",
          agent_message: { content_message: { text } },
          // Telnyx delivers this as plain SMS from the tenant's existing
          // number when the handset/carrier has no RCS (3072-char cap).
          sms_fallback: { from: config.fromE164, text: text.slice(0, 3072) }
        })
      });
      if (rcsRes.ok) {
        const json = (await rcsRes.json()) as TelnyxMessageResponse;
        const id = json.data?.id;
        if (id) {
          return { id, channel: "rcs" };
        }
        // 2xx without a message id: Telnyx did not durably create the message
        // (nothing to track or reconcile). Treat it like a rejection and
        // deliver over plain SMS — same behavior as the inbound worker.
        console.warn("sendTelnyxSms: RCS 2xx with no message id, falling back to SMS");
      } else {
        // RCS API rejection (agent revoked, destination not routable, …): fall
        // through to plain SMS so channel plumbing never drops a customer
        // message. Warn so operators see misconfigured agents.
        const errText = await rcsRes.text();
        console.warn(
          `sendTelnyxSms: RCS send rejected (${rcsRes.status}), falling back to SMS: ${errText.slice(0, 300)}`
        );
      }
    }

    const body: Record<string, string> = {
      to: toE164,
      text,
      messaging_profile_id: config.messagingProfileId
    };
    if (config.fromE164) {
      body.from = config.fromE164;
    }

    const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Telnyx SMS error: ${res.status} ${errText.slice(0, 500)}`);
    }

    const json = (await res.json()) as TelnyxMessageResponse;
    const id = json.data?.id;
    if (!id) {
      throw new Error("Telnyx SMS: missing message id in response");
    }

    return { id, channel: "sms" };
  } catch (err) {
    await releaseIfNeeded();
    throw err;
  }
}
