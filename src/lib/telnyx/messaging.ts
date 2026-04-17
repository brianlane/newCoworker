import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type TelnyxMessagingConfig = {
  apiKey: string;
  messagingProfileId: string;
  fromE164?: string;
};

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
 */
export async function getTelnyxMessagingForBusiness(
  businessId: string | null | undefined,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<TelnyxMessagingConfig> {
  const base = readTelnyxMessagingConfig();
  if (!businessId) return base;
  const db = client ?? (await createSupabaseServiceClient());
  const { data } = await db
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!data) return base;
  const profile = data.telnyx_messaging_profile_id as string | null | undefined;
  const from = data.telnyx_sms_from_e164 as string | null | undefined;
  return {
    apiKey: base.apiKey,
    messagingProfileId: profile && profile.length > 0 ? profile : base.messagingProfileId,
    fromE164: from && from.length > 0 ? from : base.fromE164
  };
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

type ReserveSlotResult = { ok?: boolean; reason?: string };

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
 * Send SMS via Telnyx Messaging API v2.
 * @returns Telnyx message id
 */
export async function sendTelnyxSms(
  config: TelnyxMessagingConfig,
  toE164: string,
  text: string,
  options?: SendTelnyxSmsOptions
): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  let meterClient: Awaited<ReturnType<typeof createSupabaseServiceClient>> | undefined;
  let reservedSlot = false;
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
      throw new Error(reserveSlotFailureMessage(gate));
    }
    reservedSlot = true;
  }

  const releaseIfNeeded = async (): Promise<void> => {
    if (!reservedSlot || !businessId || !meterClient) return;
    const { error: relErr } = await meterClient.rpc("release_sms_outbound_slot", {
      p_business_id: businessId
    });
    if (relErr) {
      console.error("sendTelnyxSms: release_sms_outbound_slot failed", relErr.message);
    }
    reservedSlot = false;
  };

  try {
    const body: Record<string, string> = {
      to: toE164,
      text,
      messaging_profile_id: config.messagingProfileId
    };
    if (config.fromE164) {
      body.from = config.fromE164;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    };
    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
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

    return id;
  } catch (err) {
    await releaseIfNeeded();
    throw err;
  }
}
