/**
 * Inbound-email trigger poller.
 *
 * Driven by /api/internal/aiflow-email-poll (which the ai-flow-worker's cron
 * tick kicks ~1/min): finds every ENABLED flow whose trigger channel is
 * "email", reads the watched mailbox's recent inbox messages through the same
 * Nango connection the send path uses, evaluates the flow's conditions over
 * subject + body, and enqueues a queued ai_flow_run per match.
 *
 * Exactly-once: the run's dedupe_key is `email:<provider message id>` and
 * ai_flow_runs has a unique (flow_id, dedupe_key) index, so the fixed
 * LOOKBACK window re-reading the same messages on every tick never
 * double-enqueues — no cursor state to persist or lose.
 *
 * Failure isolation: one mailbox failing (revoked grant, missing read scope,
 * provider 5xx) logs to system_logs and moves on; it can never block other
 * tenants' flows or the worker tick that kicked the poll.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import {
  emailTriggerScope,
  evaluateTriggerConditions,
  htmlToText,
  type InboundEmailMessage
} from "@/lib/ai-flows/trigger-eval";
import { recordSystemLog } from "@/lib/db/system-logs";
import type { TriggerCondition } from "@/lib/ai-flows/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How far back each poll looks. Must exceed the poll interval (~1 min). */
export const EMAIL_POLL_LOOKBACK_MINUTES = 15;

/** Provider page size per list request. */
export const EMAIL_POLL_PAGE_SIZE = 25;

/**
 * Hard cap on messages READ (bodies fetched + conditions evaluated) per
 * mailbox per poll. Messages that already have a run (dedupe key) are
 * filtered out BEFORE the cap is applied — neither provider guarantees list
 * order, so the cap must never be allowed to repeatedly select the same
 * already-handled subset and starve the rest. With the handled filter, each
 * poll reads up to 100 new messages, so a burst drains at ~100/minute and
 * only a burst that outruns that for the whole lookback window loses mail
 * (the poller logs an overflow warning whenever a poll can't cover the
 * remainder, so that is visible instead of silent).
 */
export const EMAIL_POLL_MAX_MESSAGES = 100;

/** Runaway-chain guard on provider list pagination per mailbox per poll. */
export const EMAIL_POLL_MAX_LIST_PAGES = 20;

/** Resolves which of these provider message ids already have a run enqueued. */
type HandledLookup = (messageIds: string[]) => Promise<Set<string>>;

type EmailFlow = {
  id: string;
  business_id: string;
  connectionId: string;
  conditions: TriggerCondition[];
};

export type EmailPollResult = {
  flows: number;
  mailboxes: number;
  messages: number;
  enqueued: number;
};

/** "Display Name <user@host>" → "user@host" (already-bare addresses pass through). */
export function parseFromAddress(raw: string): string {
  const m = /<([^<>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

/** Base64url → utf8 (Node's base64 decoder is tolerant and never throws). */
function b64UrlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/**
 * Pull readable text out of a Gmail `payload` part tree: prefer the first
 * text/plain part, fall back to text/html (stripped). Pure + exported for
 * tests.
 */
export function gmailBodyText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const flat: GmailPart[] = [];
  const walk = (p: GmailPart) => {
    flat.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  const plain = flat.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return b64UrlDecode(plain.body!.data!);
  const html = flat.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html) return htmlToText(b64UrlDecode(html.body!.data!));
  return "";
}

type GmailHeader = { name?: string; value?: string };

/** Case-insensitive Gmail header lookup. */
export function gmailHeader(headers: GmailHeader[] | undefined, name: string): string {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

type MailboxFetch = { messages: InboundEmailMessage[]; overflowed: boolean };

async function fetchGmailMessages(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  sinceMs: number,
  alreadyHandled: HandledLookup
): Promise<MailboxFetch> {
  const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceMs / 1000)}`);
  // List the whole lookback window first (id-only pages are cheap) — Gmail's
  // list order is NOT guaranteed, so capping mid-listing could repeatedly
  // keep the same arbitrary subset and starve the rest across ticks.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await nangoProxyForBusiness(businessId, link, {
      endpoint:
        `/gmail/v1/users/me/messages?maxResults=${EMAIL_POLL_PAGE_SIZE}&q=${q}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      method: "GET"
    });
    if (!page) throw new Error("email_not_connected");
    const d = page.data as { messages?: Array<{ id?: string }>; nextPageToken?: string };
    for (const m of d?.messages ?? []) {
      if (typeof m.id === "string") ids.push(m.id);
    }
    pageToken = d?.nextPageToken;
    pages += 1;
  } while (pageToken && pages < EMAIL_POLL_MAX_LIST_PAGES);
  let overflowed = pageToken !== undefined;
  // Already-enqueued messages must not consume the read budget, so a burst
  // larger than one poll's cap still drains across subsequent ticks.
  const handled = await alreadyHandled(ids);
  const pending = ids.filter((id) => !handled.has(id));
  if (pending.length > EMAIL_POLL_MAX_MESSAGES) {
    overflowed = true;
    pending.length = EMAIL_POLL_MAX_MESSAGES;
  }
  const out: InboundEmailMessage[] = [];
  for (const id of pending) {
    const res = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${id}?format=full`,
      method: "GET"
    });
    /* c8 ignore next -- the link verified above; a mid-loop revoke just skips the message */
    if (!res) continue;
    const msg = res.data as {
      payload?: GmailPart & { headers?: GmailHeader[] };
      internalDate?: string;
    };
    const headers = msg.payload?.headers;
    out.push({
      id,
      fromEmail: parseFromAddress(gmailHeader(headers, "From")),
      subject: gmailHeader(headers, "Subject"),
      bodyText: gmailBodyText(msg.payload),
      receivedAt: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : undefined
    });
  }
  return { messages: out, overflowed };
}

type GraphMessage = {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
};

async function fetchMicrosoftMessages(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  sinceMs: number,
  alreadyHandled: HandledLookup
): Promise<MailboxFetch> {
  const sinceIso = new Date(sinceMs).toISOString();
  const params =
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${EMAIL_POLL_PAGE_SIZE}` +
    `&$select=id,subject,from,body,receivedDateTime`;
  // mailFolders/inbox only — /me/messages spans Sent/Drafts too, and a flow
  // must never trigger on mail the owner sent.
  let endpoint = `/v1.0/me/mailFolders/inbox/messages?${params}`;
  const rows: Array<GraphMessage & { id: string }> = [];
  let overflowed = false;
  let pages = 0;
  for (;;) {
    const res = await nangoProxyForBusiness(businessId, link, { endpoint, method: "GET" });
    if (!res) throw new Error("email_not_connected");
    const d = res.data as { value?: GraphMessage[]; "@odata.nextLink"?: string };
    // Graph pages carry full bodies, so the budget is enforced while paging —
    // but only NEW messages count against it, letting later ticks page past
    // the already-handled head of a burst down to the unprocessed remainder.
    const pageRows = (d?.value ?? []).filter(
      (r): r is GraphMessage & { id: string } => typeof r.id === "string"
    );
    const handled = await alreadyHandled(pageRows.map((r) => r.id));
    rows.push(...pageRows.filter((r) => !handled.has(r.id)));
    pages += 1;
    const next = d?.["@odata.nextLink"];
    if (!next) break;
    if (rows.length >= EMAIL_POLL_MAX_MESSAGES || pages >= EMAIL_POLL_MAX_LIST_PAGES) {
      overflowed = true;
      break;
    }
    // nextLink is an absolute Graph URL; the proxy wants the path + query.
    const u = new URL(next);
    endpoint = u.pathname + u.search;
  }
  // A partial last page can overshoot the cap; enforce it exactly.
  if (rows.length > EMAIL_POLL_MAX_MESSAGES) {
    rows.length = EMAIL_POLL_MAX_MESSAGES;
    overflowed = true;
  }
  const messages = rows.map((r) => ({
      id: r.id,
      fromEmail: r.from?.emailAddress?.address ?? "",
      subject: r.subject ?? "",
      bodyText:
        r.body?.contentType?.toLowerCase() === "html"
          ? htmlToText(r.body?.content ?? "")
          : (r.body?.content ?? ""),
      receivedAt: r.receivedDateTime
    }));
  return { messages, overflowed };
}

function emailFlowsFrom(
  rows: Array<{ id: string; business_id: string; definition: unknown }>
): EmailFlow[] {
  const out: EmailFlow[] = [];
  for (const row of rows) {
    const def = row.definition as
      | { trigger?: { channel?: string; connectionId?: unknown; conditions?: unknown } }
      | null;
    const trig = def?.trigger;
    if (trig?.channel !== "email" || typeof trig.connectionId !== "string") continue;
    out.push({
      id: row.id,
      business_id: row.business_id,
      connectionId: trig.connectionId,
      conditions: Array.isArray(trig.conditions) ? (trig.conditions as TriggerCondition[]) : []
    });
  }
  return out;
}

/** Page size for the flow listing — paged so no flow is silently skipped. */
export const EMAIL_POLL_FLOW_PAGE = 100;

/** Poll every watched mailbox once and enqueue runs for matching messages. */
export async function pollEmailTriggers(client?: SupabaseClient): Promise<EmailPollResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const flowRows: Array<{ id: string; business_id: string; definition: unknown }> = [];
  for (let offset = 0; ; offset += EMAIL_POLL_FLOW_PAGE) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, business_id, definition")
      .eq("enabled", true)
      .eq("definition->trigger->>channel", "email")
      .order("id", { ascending: true })
      .range(offset, offset + EMAIL_POLL_FLOW_PAGE - 1);
    if (error) {
      // Nothing listed yet → surface the failure. A LATER page failing must
      // not discard the flows already in hand — poll those mailboxes this
      // tick and let the next tick retry the full listing.
      if (flowRows.length === 0) throw new Error(`pollEmailTriggers: ${error.message}`);
      console.error("pollEmailTriggers flow listing page", error.message);
      break;
    }
    const batch = (data ?? []) as typeof flowRows;
    flowRows.push(...batch);
    if (batch.length < EMAIL_POLL_FLOW_PAGE) break;
  }

  const flows = emailFlowsFrom(flowRows);
  const result: EmailPollResult = { flows: flows.length, mailboxes: 0, messages: 0, enqueued: 0 };
  if (flows.length === 0) return result;

  const byMailbox = new Map<string, EmailFlow[]>();
  for (const f of flows) {
    const key = `${f.business_id}:${f.connectionId}`;
    byMailbox.set(key, [...(byMailbox.get(key) ?? []), f]);
  }

  const sinceMs = Date.now() - EMAIL_POLL_LOOKBACK_MINUTES * 60_000;
  for (const group of byMailbox.values()) {
    const { business_id: businessId, connectionId } = group[0];
    result.mailboxes += 1;
    try {
      const conn = await getWorkspaceOAuthConnection(businessId, connectionId, db);
      if (!conn || !isEmailProviderConfigKey(conn.provider_config_key)) {
        throw new Error(conn ? "not_email_connection" : "connection_not_found");
      }
      const link = {
        connectionId: conn.connection_id,
        providerConfigKey: conn.provider_config_key
      };
      // A message counts as handled once ANY flow on this mailbox has a run
      // for it: the tick that enqueued that run evaluated every flow in the
      // group against the message (conditions are deterministic), so nothing
      // is left to do. This is what lets a >cap burst drain across ticks —
      // handled messages stop consuming the per-poll read budget.
      const flowIds = group.map((f) => f.id);
      const alreadyHandled: HandledLookup = async (messageIds) => {
        const handled = new Set<string>();
        for (let i = 0; i < messageIds.length; i += 100) {
          const keys = messageIds.slice(i, i + 100).map((id) => `email:${id}`);
          const { data, error } = await db
            .from("ai_flow_runs")
            .select("dedupe_key")
            .in("flow_id", flowIds)
            .in("dedupe_key", keys);
          if (error) throw new Error(`run lookup: ${error.message}`);
          for (const row of (data ?? []) as Array<{ dedupe_key: string | null }>) {
            if (row.dedupe_key?.startsWith("email:")) handled.add(row.dedupe_key.slice(6));
          }
        }
        return handled;
      };
      const { messages, overflowed } =
        providerFromKey(conn.provider_config_key) === "google"
          ? await fetchGmailMessages(businessId, link, sinceMs, alreadyHandled)
          : await fetchMicrosoftMessages(businessId, link, sinceMs, alreadyHandled);
      if (overflowed) {
        // More unprocessed mail in the lookback window than one poll may
        // read. Later ticks keep draining it (handled messages don't count
        // against the budget), but a burst that outruns ~cap/minute for the
        // whole window loses mail — surface it rather than dropping silently.
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_email_poll_overflow",
          message: `Mailbox has more than ${EMAIL_POLL_MAX_MESSAGES} unprocessed messages in one poll; remainder deferred to the next tick`,
          payload: { connection_id: connectionId }
        });
      }
      result.messages += messages.length;
      for (const msg of messages) {
        const scope = emailTriggerScope(msg);
        for (const flow of group) {
          if (!evaluateTriggerConditions(flow.conditions, scope.windowText, scope.from)) continue;
          const run = await enqueueAiFlowRun(
            {
              businessId,
              flowId: flow.id,
              trigger: scope,
              dedupeKey: `email:${msg.id}`
            },
            db
          );
          if (!run) continue; // already enqueued by an earlier tick
          result.enqueued += 1;
          await recordSystemLog({
            businessId,
            source: "aiflow",
            level: "info",
            event: "ai_flow_run_enqueued_email",
            message: `Inbound email from ${scope.from} triggered a run`,
            payload: { flow_id: flow.id, message_id: msg.id, subject: scope.subject }
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordSystemLog({
        businessId,
        source: "aiflow",
        level: "error",
        event: "ai_flow_email_poll_failed",
        message: `Email-trigger poll failed: ${message}`,
        payload: { connection_id: connectionId }
      });
    }
  }
  return result;
}
