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

/** Max messages fetched per mailbox per poll. */
export const EMAIL_POLL_MAX_MESSAGES = 20;

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

async function fetchGmailMessages(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  sinceMs: number
): Promise<InboundEmailMessage[]> {
  const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceMs / 1000)}`);
  const list = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/gmail/v1/users/me/messages?maxResults=${EMAIL_POLL_MAX_MESSAGES}&q=${q}`,
    method: "GET"
  });
  if (!list) throw new Error("email_not_connected");
  const ids = ((list.data as { messages?: Array<{ id?: string }> })?.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  const out: InboundEmailMessage[] = [];
  for (const id of ids) {
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
  return out;
}

async function fetchMicrosoftMessages(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  sinceMs: number
): Promise<InboundEmailMessage[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const params =
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${EMAIL_POLL_MAX_MESSAGES}` +
    `&$select=id,subject,from,body,receivedDateTime`;
  // mailFolders/inbox only — /me/messages spans Sent/Drafts too, and a flow
  // must never trigger on mail the owner sent.
  const res = await nangoProxyForBusiness(businessId, link, {
    endpoint: `/v1.0/me/mailFolders/inbox/messages?${params}`,
    method: "GET"
  });
  if (!res) throw new Error("email_not_connected");
  const rows = (res.data as {
    value?: Array<{
      id?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string } };
      body?: { contentType?: string; content?: string };
      receivedDateTime?: string;
    }>;
  })?.value ?? [];
  return rows
    .filter((r): r is typeof r & { id: string } => typeof r.id === "string")
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

/** Poll every watched mailbox once and enqueue runs for matching messages. */
export async function pollEmailTriggers(client?: SupabaseClient): Promise<EmailPollResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flows")
    .select("id, business_id, definition")
    .eq("enabled", true)
    .eq("definition->trigger->>channel", "email")
    .limit(100);
  if (error) throw new Error(`pollEmailTriggers: ${error.message}`);

  const flows = emailFlowsFrom(
    (data ?? []) as Array<{ id: string; business_id: string; definition: unknown }>
  );
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
      const messages =
        providerFromKey(conn.provider_config_key) === "google"
          ? await fetchGmailMessages(businessId, link, sinceMs)
          : await fetchMicrosoftMessages(businessId, link, sinceMs);
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
