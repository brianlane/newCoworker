/**
 * Cloudflare Email Worker: per-tenant AI mailbox inbound forwarder.
 *
 * Wired as the Email Routing catch-all destination. For every message to
 * `<anything>@newcoworker.com` that isn't matched by an explicit routing rule
 * (contact@/team@ -> Gmail still take precedence), this parses the MIME and
 * POSTs a compact JSON payload to the app's /api/email/inbound webhook, which
 * resolves the tenant and triggers any matching `tenant_email` flows.
 *
 * Loop guard: mail FROM the platform domain is dropped, the AI mailbox sends
 * via Resend from that same domain, so its own bounces/replies must never
 * re-enter the pipeline.
 *
 * Reliability: a non-2xx from the webhook throws, which tells Cloudflare the
 * delivery temporarily failed so the sending server retries later (better than
 * silently dropping the lead).
 */
import PostalMime from "postal-mime";
import { htmlToText, looksLikeStrippedTemplate } from "./html-text";
import { recipientWasUnmatched } from "./unmatched";

interface Env {
  APP_INBOUND_URL: string;
  PLATFORM_EMAIL_DOMAIN: string;
  EMAIL_INBOUND_SECRET: string;
  /**
   * Verified Email Routing destination that receives mail no tenant claimed.
   * Unset means keep the old behavior and drop it, so a deploy that predates
   * the routing config still behaves predictably.
   */
  FALLBACK_FORWARD_ADDRESS?: string;
  // Optional: when both are set the worker uploads attachments to Storage.
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ATTACHMENTS_BUCKET?: string;
}

// Skip individual attachments larger than this (Cloudflare caps the whole
// message around 25 MB anyway) and cap the count to bound work per message.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 25;

// HTML body forwarded for dashboard rendering. Must stay at or below the
// webhook's zod cap; an over-long body is dropped (text still flows) rather
// than truncated, since truncated HTML renders as visibly broken markup.
const MAX_HTML_CHARS = 500_000;

type UploadedAttachment = { filename: string; mimeType: string; size: number; path: string };

/** Bytes for a postal-mime attachment, regardless of decode mode. */
function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Upload one attachment to the private bucket; returns metadata or null on skip/failure. */
async function uploadAttachment(
  env: Env,
  att: { filename?: string | null; mimeType?: string; content: ArrayBuffer | Uint8Array | string },
  messageId: string,
  index: number
): Promise<UploadedAttachment | null> {
  const bytes = attachmentBytes(att.content);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;

  const safeName = (att.filename || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  // Deterministic per-message path + upsert: a retried delivery (same messageId)
  // overwrites the same object instead of orphaning a fresh random copy.
  const safeMsg = messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "msg";
  const path = `inbound/${safeMsg}/${index}-${safeName}`;
  const bucket = env.ATTACHMENTS_BUCKET || "email-attachments";
  // Cap the MIME type to the webhook's 255-char limit so a malformed/over-long
  // Content-Type can't fail Zod validation and make the message retry forever.
  const mimeType = (att.mimeType || "application/octet-stream").slice(0, 255);

  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": mimeType,
      "x-upsert": "true"
    },
    body: bytes
  });

  if (!res.ok) {
    // One bad upload must not fail the whole delivery, log and drop it.
    console.error(`attachment upload failed (${res.status}) for ${safeName}`);
    return null;
  }
  // Cap the display filename to the webhook's 255-char limit (same reason).
  return {
    filename: (att.filename || safeName).slice(0, 255),
    mimeType,
    size: bytes.byteLength,
    path
  };
}

/**
 * Local, hand-written subset of the runtime's ForwardableEmailMessage.
 *
 * It SHADOWS the global from `@cloudflare/workers-types` (this file is a
 * module, so the declaration is file-scoped), which means a member missing
 * here reads as "the runtime cannot do this" even when it can. `forward` was
 * the case in point: it exists at runtime and is typed in workers-types, but
 * omitting it here made the compiler reject a call that works in production.
 * Add members as they are used rather than assuming absence means unsupported.
 */
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  /** Forward to a VERIFIED Email Routing destination address. */
  forward(rcptTo: string, headers?: Headers): Promise<void>;
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

    // Prefer the text/plain part, UNLESS it is itself tag-stripped template
    // source (some senders build it by naively flattening the HTML, leaving
    // stylesheets and `*|MC:SUBJECT|*` merge tags in the "text"). In that
    // case, and when there is no text part at all, collapse the HTML part
    // properly instead: htmlToText drops <style>/<script>/<title>/comment
    // CONTENTS too, so template CSS never masquerades as body text.
    const plain = (email.text ?? "").trim();
    const text =
      plain.length > 0 && !(email.html && looksLikeStrippedTemplate(plain))
        ? email.text!
        : htmlToText(email.html ?? "") || plain;

    const messageId =
      message.headers.get("message-id") ||
      email.messageId ||
      `cf-${Date.now()}-${crypto.randomUUID()}`;

    // Upload attachments to Storage (best-effort). Only runs when the Supabase
    // secrets are configured, so an un-migrated deploy still forwards mail.
    const attachments: UploadedAttachment[] = [];
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      const atts = email.attachments ?? [];
      // Indexed loop so each attachment keeps a stable path across retries.
      for (let i = 0; i < atts.length && attachments.length < MAX_ATTACHMENTS; i++) {
        const meta = await uploadAttachment(env, atts[i], messageId, i);
        if (meta) attachments.push(meta);
      }
    }

    // Forward the HTML alternative too (sanitized at display time) so the
    // dashboard can render the real email with styling and clickable links.
    const html = (email.html ?? "").trim();

    const payload = {
      // Envelope recipient is the authoritative tenant address to route on.
      to: message.to,
      from: email.from?.address || message.from,
      subject: email.subject ?? "",
      text,
      ...(html && html.length <= MAX_HTML_CHARS ? { html } : {}),
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

    // Mail addressed to something that is not a tenant (a typo, a plus-alias
    // like team+vendor@, a signup confirmation) used to stop here and vanish:
    // the app accepts-and-ignores unknown recipients, and Email Routing has
    // only one catch-all, which this worker already occupies. Hand those to a
    // human instead of dropping them.
    //
    // NOTE this forwards EVERY unmatched message, spam included, so the
    // destination should be an address whose owner expects that.
    //
    // forward() after PostalMime consumed message.raw is safe: verified in
    // production on 2026-08-05 with a throwaway worker. The second read of
    // message.raw failed ("ReadableStream is disturbed") while forward()
    // succeeded and the mail arrived, so forward() does not use the JS stream.
    if (env.FALLBACK_FORWARD_ADDRESS) {
      const body = await res.json().catch(() => null);
      if (recipientWasUnmatched(body)) {
        try {
          await message.forward(env.FALLBACK_FORWARD_ADDRESS);
        } catch (err) {
          // Last step, after delivery already succeeded. Losing the safety net
          // must never turn into a retry of mail a tenant has already received.
          console.error(
            `fallback forward to ${env.FALLBACK_FORWARD_ADDRESS} failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }
};
