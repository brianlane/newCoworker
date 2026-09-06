/**
 * Send a plain-text email from the owner's connected mailbox (Nango Workspace
 * connection, Gmail or Microsoft 365/Outlook).
 *
 * Extracted from /api/voice/tools/email so the dashboard-chat email adapter
 * (/api/voice/tools/dashboard-email, called by the VPS chat-worker) and the
 * voice follow-up tool share one implementation. Plain text only by design:
 * a runaway model must not be able to inject markup/scripts.
 */

import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { getWorkspaceOAuthConnectionByNangoIds } from "@/lib/db/workspace-oauth-connections";
import { connectionEmail } from "@/lib/email/mailbox-options";

export type OwnerMailboxSendArgs = {
  toEmail: string;
  /**
   * Extra To recipients, beside the primary one. Needed so a reply can MIRROR
   * the original's To line instead of demoting everyone on it to Cc: someone
   * the sender addressed directly is a participant, not a bystander.
   */
  additionalToEmails?: string[];
  /**
   * Optional HTML alternative. When set the message goes out as
   * multipart/alternative: `bodyText` stays the text/plain part, so a client
   * that will not render HTML still gets a readable email rather than markup.
   * Needed because the branded signature is a table with a logo, which cannot
   * survive as plain text.
   */
  bodyHtml?: string;
  subject: string;
  bodyText: string;
  /** Optional cc recipients (already normalized to valid addresses). */
  ccEmails?: string[];
  /** Optional bcc recipients (already normalized to valid addresses). */
  bccEmails?: string[];
  /**
   * Reply INTO an existing conversation instead of starting a new one.
   * Without this a reply arrives as a fresh thread, which reads as a
   * different person answering (the email coworker's whole value is
   * continuing the thread it started).
   *
   *  - `threadId`: Gmail threadId / Graph conversationId.
   *  - `inReplyToMessageRef`: the RFC Message-Id of the message being
   *    answered, for the In-Reply-To/References headers Gmail threads on.
   *  - `providerMessageId`: the PROVIDER's id for that message. Microsoft
   *    Graph has no raw-MIME send, so its threading rides the message's own
   *    reply action, which needs this id.
   */
  thread?: {
    threadId?: string | null;
    inReplyToMessageRef?: string | null;
    providerMessageId?: string | null;
  };
  /**
   * Send AS this address instead of whatever the mailbox defaults to.
   *
   * Without it the raw MIME carries no From header and Gmail stamps the
   * account's default identity (the OAuth primary, or the mailbox's default
   * send-as alias), and Graph uses the signed-in account. A tenant whose
   * mailbox signs in as one account but corresponds from a verified alias on
   * their own domain needs the alias on the wire: it is the address the
   * recipient sees and, as Reply-To, the one their answer goes to.
   *
   * The address must already be one the mailbox may send as (Gmail "Send mail
   * as", verified; Exchange "Send As"). Nothing here checks that: Gmail
   * silently rewrites an unrecognised From back to the primary, and Graph
   * refuses the send, and both are the provider's call to make. Replies still
   * have to reach the connected mailbox for thread ownership to work, which is
   * a routing fact about the alias, not something this flag can arrange.
   */
  sendAs?: string | null;
};

export type OwnerMailboxSendResult =
  | {
      ok: true;
      provider: "google" | "microsoft";
      messageId: string | null;
      /**
       * Provider conversation the sent message landed in. Gmail returns it
       * on the send; Graph's sendMail/reply return no body, so it is null
       * there (see the thread-ownership note in the email coworker docs).
       */
      threadId: string | null;
      /**
       * The address the mail went out from: the `sendAs` override when one was
       * given (that is the From on the wire), else the connection's own
       * address from its metadata (see connectionEmail). Null for legacy
       * connections whose metadata carries no address. Callers logging to
       * email_log must store this so the dashboard can show WHO sent the mail
       * instead of a dash.
       */
      fromEmail: string | null;
    }
  | { ok: false; detail: "email_not_connected" };

/**
 * The send-as override, normalised for the wire: trimmed, or null when blank.
 * One place, so the MIME encoder, the Graph payloads, and the reported
 * `fromEmail` cannot disagree about whether an override was in force.
 */
function sendAsAddress(args: OwnerMailboxSendArgs): string | null {
  const address = args.sendAs?.trim();
  return address ? address : null;
}

function encodeRfc2822(args: OwnerMailboxSendArgs): string {
  const allTo = [args.toEmail, ...(args.additionalToEmails ?? [])];
  const lines: string[] = [];
  const sendAs = sendAsAddress(args);
  if (sendAs) {
    // Gmail sends as whichever verified alias the From header names, and
    // stamps its default identity when the header is absent. The bare address
    // rather than "Name <address>": Gmail applies the alias's own configured
    // display name, so the owner's Gmail settings stay the one place that
    // name is decided. Reply-To carries the same address so a client that
    // ignores From for replies still answers the alias.
    lines.push(`From: ${sendAs}`, `Reply-To: ${sendAs}`);
  }
  lines.push(`To: ${allTo.join(", ")}`);
  // Gmail's send API honors Cc and Bcc headers in the raw MIME and strips the
  // Bcc header from the delivered/stored message, so bcc stays hidden.
  if (args.ccEmails && args.ccEmails.length > 0) {
    lines.push(`Cc: ${args.ccEmails.join(", ")}`);
  }
  if (args.bccEmails && args.bccEmails.length > 0) {
    lines.push(`Bcc: ${args.bccEmails.join(", ")}`);
  }
  const inReplyTo = args.thread?.inReplyToMessageRef?.trim();
  if (inReplyTo) {
    // Both headers: clients thread on References, and In-Reply-To is what
    // marks this as a direct answer.
    lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }
  lines.push(`Subject: ${args.subject}`, "MIME-Version: 1.0");
  const html = args.bodyHtml?.trim();
  if (html) {
    // multipart/alternative: the SAME message in two forms, text first so a
    // client that picks the first part it understands still gets prose. The
    // boundary is fixed rather than random because these bodies are ours and
    // a stable one keeps the encoder deterministic for tests; it is prefixed
    // so it cannot collide with ordinary content.
    const boundary = "----=_NewCoworker_alt_boundary";
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      args.bodyText,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      html,
      "",
      `--${boundary}--`
    );
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8", "", args.bodyText);
  }
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Microsoft Graph recipient array shape from a list of addresses. */
function toGraphRecipients(addresses: string[]) {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/**
 * Graph's half of the send-as override: `from` is the address the message is
 * sent as (Exchange enforces Send As permission on it), `replyTo` where answers
 * go. Empty when there is no override, so an untouched payload stays
 * byte-identical to before the option existed.
 */
function graphSenderOverride(sendAs: string | null) {
  if (!sendAs) return {};
  return {
    from: { emailAddress: { address: sendAs } },
    replyTo: toGraphRecipients([sendAs])
  };
}

/**
 * Returns `email_not_connected` when there is no usable Nango email
 * connection. Upstream provider failures THROW (callers map them to their
 * own error contract, the tool adapters return `email_send_failed`).
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
 * connection to use, e.g. an AiFlow step pinned to one of several accounts).
 * `workspaceProxyForBusiness` re-verifies the connection belongs to the business,
 * so a stale/foreign id degrades to `email_not_connected` rather than sending.
 */
export async function sendFromMailboxConnection(
  businessId: string,
  conn: MailboxConnectionRef,
  args: OwnerMailboxSendArgs
): Promise<OwnerMailboxSendResult> {
  // Resolve the stored row up front for its metadata: the send result carries
  // the address the mail leaves from, so every logging caller can record it.
  // A missing row would make workspaceProxyForBusiness refuse anyway; failing
  // here just skips the provider round-trip.
  const row = await getWorkspaceOAuthConnectionByNangoIds(
    businessId,
    conn.providerConfigKey,
    conn.connectionId
  );
  if (!row) return { ok: false, detail: "email_not_connected" };
  // The override IS the wire From when present, so it is what gets reported
  // and logged; the connection's account address is the answer otherwise.
  const sendAs = sendAsAddress(args);
  const fromEmail = sendAs ?? connectionEmail(row.metadata);

  if (conn.provider === "google") {
    const raw = encodeRfc2822(args);
    const threadId = args.thread?.threadId?.trim();
    const res = await workspaceProxyForBusiness(
      businessId,
      { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
      {
        endpoint: "/gmail/v1/users/me/messages/send",
        method: "POST",
        // threadId alongside the raw MIME is what actually files the message
        // in the conversation; the headers alone leave Gmail free to split it.
        data: { raw, ...(threadId ? { threadId } : {}) }
      }
    );
    if (!res) return { ok: false, detail: "email_not_connected" };
    const data = res.data as { id?: string; threadId?: string };
    return {
      ok: true,
      provider: "google",
      messageId: data?.id ?? null,
      threadId: data?.threadId ?? null,
      fromEmail
    };
  }

  // Graph has no raw-MIME send, so a threaded answer must ride the original
  // message's reply action (which sets the conversation headers itself).
  const replyToId = args.thread?.providerMessageId?.trim();
  if (replyToId) {
    const replied = await workspaceProxyForBusiness(
      businessId,
      { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
      {
        endpoint: `/v1.0/me/messages/${encodeURIComponent(replyToId)}/reply`,
        method: "POST",
        data: (() => {
          const cc = args.ccEmails ?? [];
          const extraTo = args.additionalToEmails ?? [];
          const html = args.bodyHtml?.trim();
          // `comment` is plain text and Graph escapes it, so HTML has to ride
          // message.body instead or the signature markup arrives as literal
          // angle brackets. With a body set, comment must be empty or Graph
          // renders both.
          const message = {
            // /reply addresses the original sender on its own, but everyone
            // else has to be restated or they are dropped. Both slots, so the
            // answer mirrors the original instead of demoting its To line.
            ...(cc.length > 0 ? { ccRecipients: toGraphRecipients(cc) } : {}),
            ...(extraTo.length > 0
              ? { toRecipients: toGraphRecipients([args.toEmail, ...extraTo]) }
              : {}),
            ...(html ? { body: { contentType: "HTML", content: html } } : {}),
            ...graphSenderOverride(sendAs)
          };
          return {
            comment: html ? "" : args.bodyText,
            ...(Object.keys(message).length > 0 ? { message } : {})
          };
        })()
      }
    );
    if (!replied) return { ok: false, detail: "email_not_connected" };
    return { ok: true, provider: "microsoft", messageId: null, threadId: null, fromEmail };
  }

  const res = await workspaceProxyForBusiness(
    businessId,
    { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
    {
      endpoint: "/v1.0/me/sendMail",
      method: "POST",
      data: {
        message: {
          subject: args.subject,
          body: args.bodyHtml?.trim()
            ? { contentType: "HTML", content: args.bodyHtml.trim() }
            : { contentType: "Text", content: args.bodyText },
          toRecipients: [args.toEmail, ...(args.additionalToEmails ?? [])].map((address) => ({
            emailAddress: { address }
          })),
          ...(args.ccEmails && args.ccEmails.length > 0
            ? { ccRecipients: toGraphRecipients(args.ccEmails) }
            : {}),
          ...(args.bccEmails && args.bccEmails.length > 0
            ? { bccRecipients: toGraphRecipients(args.bccEmails) }
            : {}),
          ...graphSenderOverride(sendAs)
        },
        saveToSentItems: true
      }
    }
  );
  if (!res) return { ok: false, detail: "email_not_connected" };
  return { ok: true, provider: "microsoft", messageId: null, threadId: null, fromEmail };
}
