/**
 * Internal AiFlow adapter: send a plain-text email from a SPECIFIC connected
 * owner mailbox (workspace_oauth_connections.id → Nango Gmail/Outlook).
 *
 * Called by the ai-flow-worker when a `send_email` step (or a send_sms
 * quiet-hours email fallback) carries `fromConnectionId`, the owner picked
 * "send as me" in the flow editor instead of the platform Resend sender.
 *
 * Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN), like the other VPS/worker
 * adapters under /api/voice/tools and /api/integrations/custom. The connection
 * is looked up BY ID and must belong to the businessId in the body, so the
 * worker can never send through another tenant's mailbox.
 *
 * Response contract mirrors the voice-tool adapters: `{ ok, detail?, data? }`
 * with HTTP 200 for "configured wrong" outcomes (the worker maps those to a
 * permanent step failure) and 500 only for provider/transport faults (the
 * worker retries those).
 */
import { z } from "zod";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { tenantEmailDomain } from "@/lib/email/tenant-mailbox";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
import { PLATFORM_SIGNATURE_TEXT, escapeHtml, platformSignatureHtml } from "@/lib/email/branded-html";
import { SITE_URL } from "@/lib/marketing/site-url";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";
import { getEmailLogThreadIdentity } from "@/lib/db/email-log";
import { rememberSentThread } from "@/lib/email-coworker/threads";

const recipientList = z.union([z.string(), z.array(z.string())]).optional();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toEmail: z.string().email(),
  subject: z.string().min(1).max(300),
  bodyText: z.string().min(1).max(8000),
  cc: recipientList,
  bcc: recipientList,
  /**
   * email_log row to answer INSIDE, from a send_email step's
   * replyToEmailLogId. Absent (or a row with no stored thread) sends a new
   * conversation, exactly as before.
   */
  replyToEmailLogId: z.string().uuid().optional(),
  /**
   * Reply-all is the default on a threaded send. False threads WITHOUT
   * mirroring, for a flow writing separate, tailored notes to each party:
   * mirroring would put both of them back on both messages.
   */
  replyAll: z.boolean().optional(),
  /**
   * Sign the mail with the branded platform signature (logo, founder, phone).
   * Honoured ONLY for the platform's own business: the block carries New
   * Coworker's identity and must never render under a tenant's From header.
   */
  brandedSignature: z.boolean().optional()
});

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid args" : "invalid body";
    return voiceToolValidationError(detail);
  }

  const bindGuard = await gatewayBusinessGuard(request, body.businessId);
  if (bindGuard) return bindGuard;

  try {
    const row = await getWorkspaceOAuthConnection(body.businessId, body.connectionId);
    if (!row) return voiceToolResponse({ ok: false, detail: "connection_not_found" });
    if (!isEmailProviderConfigKey(row.provider_config_key)) {
      return voiceToolResponse({ ok: false, detail: "not_email_connection" });
    }

    // A reply target whose row never stored a thread id resolves to null and
    // sends unthreaded: the mail is still worth delivering, it just opens its
    // own conversation rather than failing the step over a missing header.
    const thread = body.replyToEmailLogId
      ? await getEmailLogThreadIdentity(body.businessId, body.replyToEmailLogId)
      : null;

    // Reply-all, minus ourselves and the person already in To. An
    // introduction puts the PROSPECT on the original's To/Cc while the
    // INTRODUCER sits in From, so answering only From reaches the person who
    // did the favor and never the lead. Deliberately additive to any cc the
    // step declared, and only on a threaded reply: a fresh send has no
    // conversation to include.
    const ownAddresses = new Set(
      [row.metadata?.provider_account_email, body.toEmail]
        .map((a) => (typeof a === "string" ? a.trim().toLowerCase() : ""))
        .filter(Boolean)
    );
    // Our OWN alias domain has to go too, or the reply cc's us and comes
    // straight back in. Live, Aug 7 2026: the original was addressed to
    // team@newcoworker.com, the Cloudflare catch-all forwards that into the
    // connected mailbox, and the account behind the grant is
    // newcoworkerteam@gmail.com. So `provider_account_email` did not match
    // team@ and we cc'd ourselves, the reply arrived as genuinely received
    // mail, and the flow answered it six times.
    //
    // The poller now refuses self-sent mail as well, which is what actually
    // stops a loop. This is the other half: not generating the copy at all,
    // so the owner's inbox stays clean rather than quietly filtered.
    const ownDomain = tenantEmailDomain();
    const isOurs = (a: string): boolean => {
      const at = a.lastIndexOf("@");
      return ownAddresses.has(a) || (at !== -1 && a.slice(at + 1) === ownDomain);
    };
    // MIRROR the original's slots. Whoever the sender put on To stays on To
    // beside them; whoever was on Cc stays on Cc. Live, Aug 8 2026: a referral
    // arrived addressed to us and the prospect on To with no Cc at all, and
    // the reply moved the prospect to Cc, which reads as though they are
    // copied on someone else's conversation rather than being in it.
    //
    // Our own addresses drop out of both, and so does the person already in
    // To, so nobody is listed twice.
    const alreadyAddressed = new Set([body.toEmail.trim().toLowerCase()]);
    const keep = (a: string): boolean => !isOurs(a) && !alreadyAddressed.has(a);
    // replyAll:false threads the send but addresses ONLY what the caller
    // asked for. A flow writing separate notes to the introducer and the
    // prospect needs that: mirroring would put both of them on both messages,
    // which is the confusion the tailored split exists to remove.
    const mirror = body.replyAll !== false;
    const replyAllTo = mirror ? (thread?.replyToRecipients ?? []).filter(keep) : [];
    const replyAllCc = [
      ...normalizeRecipients(body.cc),
      ...(mirror
        ? (thread?.replyCcRecipients ?? []).filter((a) => keep(a) && !replyAllTo.includes(a))
        : [])
    ];

    // The branded signature turns this into a multipart send: the draft stays
    // the text/plain part so a client that will not render HTML still reads
    // prose, and the HTML part carries the signature table with the logo.
    //
    // Gated on the platform's own business id, not on the caller asking
    // nicely. The block names Brian, his title and his phone number, so a
    // tenant flag alone would be one authoring mistake away from putting them
    // under someone else's From header.
    const branded = body.brandedSignature === true && body.businessId === HQ_BUSINESS_ID;
    const bodyText = branded
      ? `${body.bodyText}\n\n${PLATFORM_SIGNATURE_TEXT}`
      : body.bodyText;
    const bodyHtml = branded
      ? [
          `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0B1520;white-space:pre-wrap;">${escapeHtml(body.bodyText)}</div>`,
          '<div style="margin-top:24px;">',
          // A reply renders on the client's own white canvas, not the dark
          // template shell, so the sign-off needs the light palette or it is
          // near-invisible.
          platformSignatureHtml(`${SITE_URL}/logo.png`, { background: "light" }),
          "</div>"
        ].join("\n")
      : undefined;

    const result = await sendFromMailboxConnection(
      body.businessId,
      {
        provider: providerFromKey(row.provider_config_key),
        providerConfigKey: row.provider_config_key,
        connectionId: row.connection_id
      },
      {
        toEmail: body.toEmail,
        ...(replyAllTo.length ? { additionalToEmails: replyAllTo } : {}),
        subject: body.subject,
        bodyText,
        ...(bodyHtml ? { bodyHtml } : {}),
        ccEmails: replyAllCc,
        bccEmails: normalizeRecipients(body.bcc),
        ...(thread ? { thread } : {})
      }
    );
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }

    // Claim the conversation for the autonomous email coworker. This is the
    // hinge of the whole feature: its poll filters strictly to threads the
    // assistant owns, so without this the reply goes out and turn two is
    // back to paging a human. Best-effort, exactly like the other three
    // callers of rememberSentThread: a failed claim costs autonomy on later
    // messages, never the send that already succeeded.
    // Graph's /reply returns no ids at all (owner-mailbox.ts), so a Microsoft
    // reply would register no ownership and its follow-ups would go back to
    // paging a human. But when we THREADED the send we already know the
    // conversation, because we just read it off the email_log row: prefer the
    // provider's echo, fall back to the id we replied into.
    const ownedThreadId = result.threadId ?? thread?.threadId ?? null;
    if (ownedThreadId) {
      try {
        await rememberSentThread({
          businessId: body.businessId,
          provider: providerFromKey(row.provider_config_key) === "microsoft" ? "microsoft" : "google",
          threadId: ownedThreadId,
          subject: body.subject,
          correspondentEmail: body.toEmail,
          sentMessageRef: result.messageId ?? null
        });
      } catch (claimErr) {
        logger.warn("aiflows/send-owner-email: thread claim failed", {
          businessId: body.businessId,
          error: claimErr instanceof Error ? claimErr.message : String(claimErr)
        });
      }
    }
    return voiceToolResponse({
      ok: true,
      // fromEmail rides along so the worker can log the REAL sending address
      // on email_log instead of the provider name. threadId rides along for
      // the same reason: the worker writes the row, and an outbound row with
      // no conversation id cannot answer "have we already replied here".
      // Graph's /reply echoes nothing, so fall back to the thread we replied
      // into, which we just read off the email_log row.
      data: {
        messageId: result.messageId,
        provider: result.provider,
        fromEmail: result.fromEmail,
        threadId: result.threadId ?? thread?.threadId ?? null
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/send-owner-email failed", {
      businessId: body.businessId,
      error: message
    });
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "error",
      event: "ai_flow_owner_email_failed",
      message: `Owner-mailbox email send failed: ${message}`,
      payload: { to: body.toEmail, connection_id: body.connectionId }
    });
    return voiceToolResponse({ ok: false, detail: "email_send_failed" }, 500);
  }
}
