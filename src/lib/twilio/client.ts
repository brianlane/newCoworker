import twilio from "twilio";

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
};

export function readTwilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !messagingServiceSid) {
    throw new Error("Missing Twilio configuration");
  }

  return { accountSid, authToken, messagingServiceSid };
}

export async function sendOwnerSms(
  config: TwilioConfig,
  to: string,
  body: string,
  clientFactory: typeof twilio = twilio
): Promise<string> {
  const client = clientFactory(config.accountSid, config.authToken);
  const message = await client.messages.create({
    messagingServiceSid: config.messagingServiceSid,
    to,
    body
  });

  return message.sid;
}
