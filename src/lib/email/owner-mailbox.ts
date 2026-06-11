/**
 * Send a plain-text email from the owner's connected mailbox (Nango Workspace
 * connection — Gmail or Microsoft 365/Outlook).
 *
 * Extracted from /api/voice/tools/email so the dashboard-chat email adapter
 * (/api/voice/tools/dashboard-email, called by the VPS chat-worker) and the
 * voice follow-up tool share one implementation. Plain text only by design:
 * a runaway model must not be able to inject markup/scripts.
 */

import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";

export type OwnerMailboxSendArgs = {
  toEmail: string;
  subject: string;
  bodyText: string;
};

export type OwnerMailboxSendResult =
  | { ok: true; provider: "google" | "microsoft"; messageId: string | null }
  | { ok: false; detail: "email_not_connected" };

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

/**
 * Returns `email_not_connected` when there is no usable Nango email
 * connection. Upstream provider failures THROW (callers map them to their
 * own error contract — the tool adapters return `email_send_failed`).
 */
export async function sendFromOwnerMailbox(
  businessId: string,
  args: OwnerMailboxSendArgs
): Promise<OwnerMailboxSendResult> {
  const conn = await resolveEmailConnection(businessId);
  if (!conn) return { ok: false, detail: "email_not_connected" };
  return sendFromMailboxConnection(businessId, conn, args);
}

export type MailboxConnectionRef = {
  provider: "google" | "microsoft";
  providerConfigKey: string;
  connectionId: string;
};

/**
 * Send from a SPECIFIC connected mailbox (caller already resolved which
 * connection to use — e.g. an AiFlow step pinned to one of several accounts).
 * `nangoProxyForBusiness` re-verifies the connection belongs to the business,
 * so a stale/foreign id degrades to `email_not_connected` rather than sending.
 */
export async function sendFromMailboxConnection(
  businessId: string,
  conn: MailboxConnectionRef,
  args: OwnerMailboxSendArgs
): Promise<OwnerMailboxSendResult> {
  if (conn.provider === "google") {
    const raw = encodeRfc2822(args.toEmail, args.subject, args.bodyText);
    const res = await nangoProxyForBusiness(
      businessId,
      { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
      {
        endpoint: "/gmail/v1/users/me/messages/send",
        method: "POST",
        data: { raw }
      }
    );
    if (!res) return { ok: false, detail: "email_not_connected" };
    const data = res.data as { id?: string };
    return { ok: true, provider: "google", messageId: data?.id ?? null };
  }

  const res = await nangoProxyForBusiness(
    businessId,
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
  if (!res) return { ok: false, detail: "email_not_connected" };
  return { ok: true, provider: "microsoft", messageId: null };
}
