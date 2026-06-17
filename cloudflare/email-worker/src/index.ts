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
  // Optional: when both are set the worker uploads attachments to Storage.
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ATTACHMENTS_BUCKET?: string;
}

// Skip individual attachments larger than this (Cloudflare caps the whole
// message around 25 MB anyway) and cap the count to bound work per message.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 25;

type UploadedAttachment = { filename: string; mimeType: string; size: number; path: string };

/** Bytes for a postal-mime attachment, regardless of decode mode. */
function attachmentBytes(content: ArrayBuffer | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content);
}

/** Upload one attachment to the private bucket; returns metadata or null on skip/failure. */
async function uploadAttachment(
  env: Env,
  att: { filename?: string | null; mimeType?: string; content: ArrayBuffer | string }
): Promise<UploadedAttachment | null> {
  const bytes = attachmentBytes(att.content);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;

  const safeName = (att.filename || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  const path = `inbound/${crypto.randomUUID()}/${safeName}`;
  const bucket = env.ATTACHMENTS_BUCKET || "email-attachments";
  const mimeType = att.mimeType || "application/octet-stream";

  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": mimeType
    },
    body: bytes
  });

  if (!res.ok) {
    // One bad upload must not fail the whole delivery — log and drop it.
    console.error(`attachment upload failed (${res.status}) for ${safeName}`);
    return null;
  }
  return { filename: att.filename || safeName, mimeType, size: bytes.byteLength, path };
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

    // Upload attachments to Storage (best-effort). Only runs when the Supabase
    // secrets are configured, so an un-migrated deploy still forwards mail.
    const attachments: UploadedAttachment[] = [];
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      for (const att of email.attachments ?? []) {
        if (attachments.length >= MAX_ATTACHMENTS) break;
        const meta = await uploadAttachment(env, att);
        if (meta) attachments.push(meta);
      }
    }

    const payload = {
      // Envelope recipient is the authoritative tenant address to route on.
      to: message.to,
      from: email.from?.address || message.from,
      subject: email.subject ?? "",
      text,
      messageId,
      attachments
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
