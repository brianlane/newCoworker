/**
 * On-demand single-mailbox reader for the `email_extract` flow step.
 *
 * Unlike the email-TRIGGER poller (email-poll.ts), which sweeps every watched
 * mailbox on a cron tick, this reads ONE connected mailbox right now and returns
 * the single best-matching recent inbound message, so a running flow can pull
 * lead details out of an alert email mid-run (e.g. HomeLight's "Client Details"
 * email when the portal contact card is delayed).
 *
 * The ai-flow-worker (Deno) can't reach Nango, so it calls the gateway-guarded
 * /api/internal/aiflow-email-fetch route, which invokes this. Matching: the most
 * recent inbox message (within `lookbackMinutes`) whose sender contains
 * `fromContains` AND whose subject+body contains EVERY `bodyContains` term (all
 * case-insensitive; an empty list/term matches everything). Requiring multiple
 * terms (e.g. first name AND city) disambiguates two leads who share a first
 * name within the same window.
 *
 * Read-only and best-effort: a miss returns `{ found: false }` (the step simply
 * backfills nothing), and a provider/connection error throws (the worker retries).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { htmlToText, type InboundEmailMessage } from "@/lib/ai-flows/trigger-eval";
import { parseFromAddress, gmailBodyText, gmailHeader } from "@/lib/ai-flows/email-poll";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Most recent inbox messages to read+scan per call (one page is plenty). */
export const EMAIL_FETCH_MAX_MESSAGES = 25;

export type EmailFetchQuery = {
  businessId: string;
  connectionId: string;
  /** Sender substring filter (case-insensitive); "" → any sender. */
  fromContains?: string;
  /** Body/subject substring filters (case-insensitive); ALL required; []/blank → any message. */
  bodyContains?: string[];
  /** How far back to look (minutes). */
  lookbackMinutes: number;
};

export type EmailFetchResult =
  | { found: true; subject: string; from: string; bodyText: string; receivedAt?: string }
  | { found: false };

type MailboxLink = { connectionId: string; providerConfigKey: string };

/**
 * Pick the most recent message that passes the from filter AND contains EVERY
 * body term. Pure + exported for unit tests. `receivedAt` (ISO) drives recency;
 * messages without one sort last (treated as oldest) so a dated match always
 * wins. Blank terms are ignored; an empty term list means "no body filter".
 */
export function pickBestMatch(
  messages: InboundEmailMessage[],
  fromContains: string,
  bodyContains: string[]
): InboundEmailMessage | null {
  const from = fromContains.trim().toLowerCase();
  const terms = bodyContains.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  let best: InboundEmailMessage | null = null;
  let bestMs = -Infinity;
  for (const m of messages) {
    if (from && !m.fromEmail.toLowerCase().includes(from)) continue;
    const hay = `${m.subject}\n${m.bodyText}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const ms = m.receivedAt ? Date.parse(m.receivedAt) : Number.NaN;
    const sortMs = Number.isFinite(ms) ? ms : -Infinity;
    if (best === null || sortMs > bestMs) {
      best = m;
      bestMs = sortMs;
    }
  }
  return best;
}

async function readGmailInbox(
  businessId: string,
  link: MailboxLink,
  sinceMs: number
): Promise<InboundEmailMessage[]> {
  const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceMs / 1000)}`);
  const page = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/gmail/v1/users/me/messages?maxResults=${EMAIL_FETCH_MAX_MESSAGES}&q=${q}`,
    method: "GET"
  });
  if (!page) throw new Error("email_not_connected");
  const d = page.data as { messages?: Array<{ id?: string }> };
  const ids = (d?.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .slice(0, EMAIL_FETCH_MAX_MESSAGES);
  const out: InboundEmailMessage[] = [];
  for (const id of ids) {
    const res = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${id}?format=full`,
      method: "GET"
    });
    if (!res) continue;
    const msg = res.data as {
      payload?: (Parameters<typeof gmailBodyText>[0]) & { headers?: Array<{ name?: string; value?: string }> };
      internalDate?: string;
    };
    const headers = msg.payload?.headers;
    const internalMs = Number(msg.internalDate);
    out.push({
      id,
      fromEmail: parseFromAddress(gmailHeader(headers, "From")),
      subject: gmailHeader(headers, "Subject"),
      bodyText: gmailBodyText(msg.payload),
      receivedAt:
        msg.internalDate && Number.isFinite(internalMs)
          ? new Date(internalMs).toISOString()
          : undefined
    });
  }
  return out;
}

type GraphMessage = {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
};

async function readMicrosoftInbox(
  businessId: string,
  link: MailboxLink,
  sinceMs: number
): Promise<InboundEmailMessage[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const params =
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${EMAIL_FETCH_MAX_MESSAGES}` +
    `&$select=id,subject,from,body,receivedDateTime`;
  const res = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/v1.0/me/mailFolders/inbox/messages?${params}`,
    method: "GET"
  });
  if (!res) throw new Error("email_not_connected");
  const d = res.data as { value?: GraphMessage[] };
  return (d?.value ?? [])
    .filter((r): r is GraphMessage & { id: string } => typeof r.id === "string")
    .map((r) => ({
      id: r.id,
      fromEmail: r.from?.emailAddress?.address ?? "",
      subject: r.subject ?? "",
      bodyText:
        r.body?.contentType?.toLowerCase() === "html"
          ? htmlToText(r.body?.content ?? "")
          : (r.body?.content ?? ""),
      receivedAt: r.receivedDateTime
    }));
}

/**
 * Read the connected mailbox and return the best-matching recent inbound
 * message, or `{ found: false }` on no match. Throws when the connection is
 * missing / not an email connection (permanent: the worker maps to step fail)
 * or the provider read errors (transient: the worker retries).
 */
export async function findMatchingInboundEmail(
  query: EmailFetchQuery,
  client?: SupabaseClient
): Promise<EmailFetchResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const conn = await getWorkspaceOAuthConnection(query.businessId, query.connectionId, db);
  if (!conn) throw new Error("connection_not_found");
  if (!isEmailProviderConfigKey(conn.provider_config_key)) {
    throw new Error("not_email_connection");
  }
  const link: MailboxLink = {
    connectionId: conn.connection_id,
    providerConfigKey: conn.provider_config_key
  };
  const sinceMs = Date.now() - query.lookbackMinutes * 60_000;
  const messages =
    providerFromKey(conn.provider_config_key) === "google"
      ? await readGmailInbox(query.businessId, link, sinceMs)
      : await readMicrosoftInbox(query.businessId, link, sinceMs);
  const best = pickBestMatch(messages, query.fromContains ?? "", query.bodyContains ?? []);
  if (!best) return { found: false };
  return {
    found: true,
    subject: best.subject,
    from: best.fromEmail,
    bodyText: best.bodyText,
    ...(best.receivedAt ? { receivedAt: best.receivedAt } : {})
  };
}
