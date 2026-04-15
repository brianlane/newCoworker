import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { checkLimitReached, incrementUsage } from "@/lib/db/usage";
import type { PlanTier } from "@/lib/plans/tier";

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
   * When set, checks monthly SMS quota for this business before send and increments `daily_usage.sms_sent` after success.
   */
  meterBusinessId?: string;
};

type TelnyxMessageResponse = { data?: { id?: string } };

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

  if (options?.meterBusinessId) {
    meterClient = await createSupabaseServiceClient();
    const { data: biz, error: bizErr } = await meterClient
      .from("businesses")
      .select("tier, enterprise_limits")
      .eq("id", options.meterBusinessId)
      .single();
    if (bizErr || !biz) {
      throw new Error(`sendTelnyxSms: business not found (${bizErr?.message ?? "unknown"})`);
    }
    const tier = (String(biz.tier ?? "starter") || "starter") as PlanTier;
    const entRaw = tier === "enterprise" ? biz.enterprise_limits : undefined;
    const gate = await checkLimitReached(options.meterBusinessId, tier, meterClient, entRaw);
    if (!gate.allowed) {
      throw new Error(gate.reason ?? "Monthly SMS limit reached");
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

  if (options?.meterBusinessId) {
    const db = meterClient ?? (await createSupabaseServiceClient());
    await incrementUsage(options.meterBusinessId, "sms_sent", 1, db);
  }

  return id;
}
