import { z } from "zod";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { logger } from "@/lib/logger";

/**
 * `send_follow_up_email` — sends a short email from the owner's connected
 * Google or Microsoft account. We deliberately only allow plain text here so
 * a runaway model can't inject markup/scripts; the voice agent is expected
 * to dictate a 1-3 sentence follow-up, not a newsletter.
 *
 * Per product decision: if no Nango email connection exists we return
 * `email_not_connected` so Gemini Live switches to an SMS follow-up path.
 */

const argsSchema = z.object({
  toEmail: z.string().email(),
  subject: z.string().min(1).max(150),
  bodyText: z.string().min(1).max(4000)
});

function encodeRfc2822(to: string, subject: string, text: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text
  ];
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;

  try {
    const conn = await resolveEmailConnection(envelope.businessId);
    if (!conn) {
      return voiceToolResponse({ ok: false, detail: "email_not_connected" });
    }

    if (conn.provider === "google") {
      const raw = encodeRfc2822(args.toEmail, args.subject, args.bodyText);
      const res = await nangoProxyForBusiness(
        envelope.businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/gmail/v1/users/me/messages/send",
          method: "POST",
          data: { raw }
        }
      );
      if (!res) return voiceToolResponse({ ok: false, detail: "email_not_connected" });
      const data = res.data as { id?: string };
      return voiceToolResponse({
        ok: true,
        data: { messageId: data?.id ?? null, provider: "google" }
      });
    }

    const res = await nangoProxyForBusiness(
      envelope.businessId,
      { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
      {
        endpoint: "/v1.0/me/sendMail",
        method: "POST",
        data: {
          message: {
            subject: args.subject,
            body: { contentType: "Text", content: args.bodyText },
            toRecipients: [{ emailAddress: { address: args.toEmail } }]
          },
          saveToSentItems: true
        }
      }
    );
    if (!res) return voiceToolResponse({ ok: false, detail: "email_not_connected" });
    return voiceToolResponse({
      ok: true,
      data: { messageId: null, provider: "microsoft" }
    });
  } catch (err) {
    logger.warn("voice-tools/email failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "email_send_failed" }, 500);
  }
}
