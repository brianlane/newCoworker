/**
 * Cloudflare Email Worker: per-tenant AI mailbox inbound forwarder.
 *
 * Wired as the Email Routing catch-all destination. For every message to
 * `<anything>@newcoworker.com` that isn't matched by an explicit routing rule
 * (contact@/team@ -> Gmail still take precedence), this parses the MIME and
 * POSTs a compact JSON payload to the app's /api/email/inbound webhook, which
 * resolves the tenant and triggers any matching `tenant_email` flows.
 *
 * Loop guard: mail FROM the platform domain is dropped — the AI mailbox sends
 * via Resend from that same domain, so its own bounces/replies must never
 * re-enter the pipeline.
 *
 * Reliability: a non-2xx from the webhook throws, which tells Cloudflare the
 * delivery temporarily failed so the sending server retries later (better than
 * silently dropping the lead).
 */
import PostalMime from "postal-mime";

interface Env {
  APP_INBOUND_URL: string;
  PLATFORM_EMAIL_DOMAIN: string;
  EMAIL_INBOUND_SECRET: string;
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const platformDomain = (env.PLATFORM_EMAIL_DOMAIN || "newcoworker.com").toLowerCase();

    // Loop guard: never forward mail the platform itself originated.
    if (domainOf(message.from) === platformDomain) return;

    const email = await PostalMime.parse(message.raw);

    const text =
      (email.text && email.text.trim().length > 0
        ? email.text
        : (email.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) ?? "";

    const messageId =
      message.headers.get("message-id") ||
      email.messageId ||
      `cf-${Date.now()}-${crypto.randomUUID()}`;

    const payload = {
      // Envelope recipient is the authoritative tenant address to route on.
      to: message.to,
      from: email.from?.address || message.from,
      subject: email.subject ?? "",
      text,
      messageId
    };

    const res = await fetch(env.APP_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.EMAIL_INBOUND_SECRET}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      // Surface a temporary failure so the sender retries; the app webhook is
      // idempotent (dedupe_key on messageId), so a retry can't double-trigger.
      throw new Error(`inbound webhook returned ${res.status}`);
    }
  }
};
