/**
 * Inbox reads for the email coworker.
 *
 * Separate from the AiFlow trigger poller (src/lib/ai-flows/email-poll.ts)
 * because this surface needs what that one deliberately drops: the
 * provider CONVERSATION id and the RFC Message-Id. Ownership matching and
 * threaded replies are impossible without both. Parsing helpers are shared
 * with the trigger poller so body extraction cannot drift between them.
 */

import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { gmailBodyText, gmailHeader, parseFromAddress } from "@/lib/ai-flows/email-poll";
import { htmlToText } from "@/lib/ai-flows/trigger-eval";

export type MailboxLink = { connectionId: string; providerConfigKey: string };

export type InboxMessage = {
  /** Provider message id (Gmail id / Graph id). */
  id: string;
  /** Gmail threadId / Graph conversationId. */
  threadId: string;
  /** Sender, always lower cased: callers compare it against stored addresses. */
  fromEmail: string;
  subject: string;
  bodyText: string;
  /** RFC Message-Id header, for In-Reply-To on the answer. */
  messageRef: string | null;
  receivedAt?: string;
};

/** How far back a poll looks. Wider than the tick interval so a skipped
 * tick never loses mail (the seen ledger absorbs the re-reads). */
export const INBOX_LOOKBACK_MINUTES = 30;

/** Per-poll read ceiling for one mailbox. */
export const INBOX_MAX_MESSAGES = 25;

/**
 * Recent inbox messages with conversation ids attached. Gmail needs a
 * list-then-get (ids only come back from the list); Graph returns
 * everything in one select.
 */
export async function fetchInboxWithThreads(
  businessId: string,
  provider: "google" | "microsoft",
  link: MailboxLink,
  sinceMs: number,
  limit = INBOX_MAX_MESSAGES
): Promise<InboxMessage[]> {
  return provider === "google"
    ? fetchGmail(businessId, link, sinceMs, limit)
    : fetchGraph(businessId, link, sinceMs, limit);
}

async function fetchGmail(
  businessId: string,
  link: MailboxLink,
  sinceMs: number,
  limit: number
): Promise<InboxMessage[]> {
  const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceMs / 1000)}`);
  const list = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/gmail/v1/users/me/messages?maxResults=${limit}&q=${q}`,
    method: "GET"
  });
  if (!list) throw new Error("email_not_connected");
  const ids: string[] = [];
  for (const m of (list.data as { messages?: Array<{ id?: string }> })?.messages ?? []) {
    if (typeof m.id === "string") ids.push(m.id);
  }

  const out: InboxMessage[] = [];
  for (const id of ids.slice(0, limit)) {
    const res = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${id}?format=full`,
      method: "GET"
    });
    /* c8 ignore next -- link verified above; a mid-loop revoke just skips it */
    if (!res) continue;
    const msg = res.data as {
      threadId?: string;
      internalDate?: string;
      payload?: Parameters<typeof gmailBodyText>[0] & {
        headers?: Parameters<typeof gmailHeader>[0];
      };
    };
    const headers = msg.payload?.headers;
    const internalMs = Number(msg.internalDate);
    out.push({
      id,
      threadId: typeof msg.threadId === "string" ? msg.threadId : "",
      fromEmail: parseFromAddress(gmailHeader(headers, "From")).toLowerCase(),
      subject: gmailHeader(headers, "Subject"),
      bodyText: gmailBodyText(msg.payload),
      messageRef: gmailHeader(headers, "Message-Id") || null,
      receivedAt:
        msg.internalDate && Number.isFinite(internalMs)
          ? new Date(internalMs).toISOString()
          : undefined
    });
  }
  return out;
}

async function fetchGraph(
  businessId: string,
  link: MailboxLink,
  sinceMs: number,
  limit: number
): Promise<InboxMessage[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const params =
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${limit}` +
    "&$select=id,conversationId,internetMessageId,subject,from,body,receivedDateTime";
  // mailFolders/inbox only: /me/messages spans Sent, and answering our own
  // sent mail is exactly the loop this surface must never enter.
  const res = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/v1.0/me/mailFolders/inbox/messages?${params}`,
    method: "GET"
  });
  if (!res) throw new Error("email_not_connected");
  const rows =
    (
      res.data as {
        value?: Array<{
          id?: string;
          conversationId?: string;
          internetMessageId?: string;
          subject?: string;
          from?: { emailAddress?: { address?: string } };
          body?: { contentType?: string; content?: string };
          receivedDateTime?: string;
        }>;
      }
    )?.value ?? [];
  const out: InboxMessage[] = [];
  for (const r of rows) {
    if (typeof r.id !== "string") continue;
    out.push({
      id: r.id,
      threadId: typeof r.conversationId === "string" ? r.conversationId : "",
      fromEmail: (r.from?.emailAddress?.address ?? "").toLowerCase(),
      subject: r.subject ?? "",
      bodyText:
        r.body?.contentType?.toLowerCase() === "html"
          ? htmlToText(r.body?.content ?? "")
          : (r.body?.content ?? ""),
      messageRef: r.internetMessageId ?? null,
      receivedAt: r.receivedDateTime
    });
  }
  return out;
}
