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

type TelnyxMessageResponse = { data?: { id?: string } };

/**
 * Send SMS via Telnyx Messaging API v2.
 * @returns Telnyx message id
 */
export async function sendTelnyxSms(
  config: TelnyxMessagingConfig,
  toE164: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
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
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
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
}
