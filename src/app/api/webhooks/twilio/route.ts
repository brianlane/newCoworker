import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import twilio from "twilio";

function validateTwilioSignature(request: Request, body: string): boolean {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";

  if (!accountSid || !authToken) {
    if (process.env.NODE_ENV === "development" || process.env.CI === "true") return true;
    return false;
  }

  const signature = request.headers.get("x-twilio-signature") ?? "";
  const url = request.url;
  const params = Object.fromEntries(new URLSearchParams(body));

  return twilio.validateRequest(authToken, signature, url, params);
}

const KEYWORD_RESPONSES: Record<string, string> = {
  HELP: "Reply STOP to opt out of SMS alerts from New Coworker. Reply START to re-subscribe.",
  STOP: "You have been unsubscribed from New Coworker SMS alerts. Reply START to re-subscribe.",
  START: "You have been re-subscribed to New Coworker SMS alerts. Reply STOP to opt out."
};

export async function POST(request: Request) {
  const body = await request.text();

  if (!validateTwilioSignature(request, body)) {
    logger.warn("Invalid Twilio webhook signature");
    return errorResponse("FORBIDDEN", "Invalid signature", 403);
  }

  const params = Object.fromEntries(new URLSearchParams(body));
  const from: string = params["From"] ?? "";
  const messageBody: string = (params["Body"] ?? "").trim().toUpperCase();
  const messageSid: string = params["MessageSid"] ?? "";

  logger.info("Twilio inbound SMS", { from, keyword: messageBody, messageSid });

  // Handle opt-in/opt-out keywords
  const keywordReply = KEYWORD_RESPONSES[messageBody];
  if (keywordReply) {
    // Respond with TwiML so Twilio sends the reply
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${keywordReply}</Message></Response>`,
      { headers: { "Content-Type": "text/xml" } }
    );
  }

  // For all other inbound messages: log and acknowledge
  logger.info("Inbound SMS logged", { from, preview: (params["Body"] ?? "").slice(0, 50) });

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
    { headers: { "Content-Type": "text/xml" } }
  );
}
