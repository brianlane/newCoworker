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
 * ai_flow_runs has a unique (flow_id, dedupe_key) index, so re-reading the
 * same messages never double-enqueues. Read efficiency: ai_flow_email_seen
 * markers record every (flow, message) evaluation — match or not — so the
 * per-poll read cap is only spent on unevaluated mail; the markers are an
 * optimization, not a correctness dependency (losing them just re-reads, and
 * the dedupe keys absorb that).
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
import { recordInboundTriggerEmail } from "@/lib/db/email-log";
import type { TriggerCondition } from "@/lib/ai-flows/schema";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How far back each poll looks. Must exceed the poll interval (~1 min). */
export const EMAIL_POLL_LOOKBACK_MINUTES = 15;

/** Provider page size per list request. */
export const EMAIL_POLL_PAGE_SIZE = 25;

/**
 * Hard cap on messages READ (bodies fetched + conditions evaluated) per
 * mailbox per poll. Messages every flow on the mailbox has already evaluated
 * (per ai_flow_email_seen markers, written for matches AND non-matches) are
 * filtered out BEFORE the cap is applied — neither provider guarantees list
 * order, so the cap must never be allowed to repeatedly select the same
 * already-read subset and starve the rest. With that filter, each poll reads
 * up to 100 unevaluated messages, so a burst drains at ~100/minute and only
 * a burst that outruns that for the whole lookback window loses mail (the
 * poller logs an overflow warning whenever a poll can't cover the remainder,
 * so that is visible instead of silent).
 */
export const EMAIL_POLL_MAX_MESSAGES = 100;

/**
 * Runaway-chain guard on provider list pagination per mailbox per poll.
 * Sized so it never binds before read throughput does: mail stays in the
 * lookback window for LOOKBACK minutes and the poller evaluates up to
 * MAX_MESSAGES per minute-tick, so LOOKBACK × MAX_MESSAGES is the most a
 * mailbox can ever drain before mail ages out — and this many pages lists
 * exactly that volume. It therefore only stops buggy or looping pagination
 * chains, never a drainable backlog.
 */
export const EMAIL_POLL_MAX_LIST_PAGES =
  (EMAIL_POLL_LOOKBACK_MINUTES * EMAIL_POLL_MAX_MESSAGES) / EMAIL_POLL_PAGE_SIZE;

/** How long evaluation markers are kept (≫ lookback, so never re-read). */
export const EMAIL_SEEN_RETENTION_MINUTES = 24 * 60;

/** Resolves which message ids every flow on the mailbox has already evaluated. */
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
    // The page guard lists more ids than the lookback window can ever drain
    // (see EMAIL_POLL_MAX_LIST_PAGES), so hitting it means mail is arriving
    // faster than it can possibly be evaluated — flagged as overflow below.
  } while (pageToken && pages < EMAIL_POLL_MAX_LIST_PAGES);
  let overflowed = pageToken !== undefined;
  // Already-evaluated messages must not consume the read budget, so a burst
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
    // internalDate is epoch-ms-as-string; a malformed value must degrade to
    // "no timestamp", not throw and abort the whole mailbox poll.
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
    // The page guard spans more mail than the lookback window can ever
    // drain (see EMAIL_POLL_MAX_LIST_PAGES), so even an all-handled backlog
    // (e.g. right after adding a new flow) never hides reachable mail —
    // hitting either bound means the remainder genuinely can't be read yet.
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

  // Evaluation markers only matter inside the lookback window; prune old
  // ones so the table can't grow unboundedly (best-effort — a failed prune
  // just leaves rows for the next tick).
  const cutoff = new Date(Date.now() - EMAIL_SEEN_RETENTION_MINUTES * 60_000).toISOString();
  const { error: pruneErr } = await db.from("ai_flow_email_seen").delete().lt("seen_at", cutoff);
  if (pruneErr) console.error("ai_flow_email_seen prune", pruneErr.message);

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
      // A message counts as handled once EVERY flow on this mailbox has an
      // evaluation marker for it (markers are written for matches and
      // non-matches alike, below). This is what lets a >cap burst drain
      // across ticks — already-read messages stop consuming the per-poll
      // read budget — while a freshly added flow (no markers yet) still gets
      // the in-window backlog re-read and evaluated for it; existing flows'
      // re-evaluations are absorbed by the run dedupe keys.
      const flowIds = group.map((f) => f.id);
      const alreadyHandled: HandledLookup = async (messageIds) => {
        const counts = new Map<string, number>();
        for (let i = 0; i < messageIds.length; i += 100) {
          const chunk = messageIds.slice(i, i + 100);
          const { data, error } = await db
            .from("ai_flow_email_seen")
            .select("message_id")
            .in("flow_id", flowIds)
            .in("message_id", chunk);
          if (error) throw new Error(`seen lookup: ${error.message}`);
          for (const row of (data ?? []) as Array<{ message_id: string }>) {
            counts.set(row.message_id, (counts.get(row.message_id) ?? 0) + 1);
          }
        }
        const handled = new Set<string>();
        for (const [id, n] of counts) {
          if (n >= flowIds.length) handled.add(id);
        }
        return handled;
      };
      const { messages, overflowed } =
        providerFromKey(conn.provider_config_key) === "google"
          ? await fetchGmailMessages(businessId, link, sinceMs, alreadyHandled)
          : await fetchMicrosoftMessages(businessId, link, sinceMs, alreadyHandled);
      if (overflowed) {
        // This poll could not cover every in-window message (read cap hit,
        // or the listing guard cut a pathological page chain). Later ticks
        // keep draining (evaluated messages don't count against the budget),
        // but a burst that outruns ~cap/minute for the whole lookback window
        // loses mail — surface it rather than dropping silently.
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_email_poll_overflow",
          message:
            "Email poll could not cover every in-window message this tick; remainder deferred to later polls",
          payload: { connection_id: connectionId, messages_read: messages.length }
        });
      }
      result.messages += messages.length;
      // Pre-resolve each flow's from_matches saved-contact refs ONCE for this
      // poll (not per message) to live identity values (phones + emails). A
      // resolution failure fails CLOSED for that flow only.
      const refValuesByFlow = new Map<string, Map<string, string[]> | undefined>();
      for (const flow of group) {
        try {
          // Cast: the full supabase-js builder type recurses too deep for TS
          // to check structurally against the resolver's minimal chain type.
          refValuesByFlow.set(
            flow.id,
            await resolveFromMatchesRefValues(
              db as unknown as ContactRefSupabase,
              businessId,
              flow.conditions
            )
          );
        } catch (e) {
          console.error("email from_matches ref resolution", e);
          refValuesByFlow.set(flow.id, undefined);
        }
      }
      const seenRows: Array<{ flow_id: string; message_id: string }> = [];
      for (const msg of messages) {
        const scope = emailTriggerScope(msg);
        for (const flow of group) {
          seenRows.push({ flow_id: flow.id, message_id: msg.id });
          if (
            !evaluateTriggerConditions(
              flow.conditions,
              scope.windowText,
              scope.from,
              refValuesByFlow.get(flow.id)
            )
          )
            continue;
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
          // Surface the triggering email on the dashboard Emails page.
          await recordInboundTriggerEmail(
            {
              businessId,
              fromEmail: msg.fromEmail,
              subject: msg.subject,
              bodyText: msg.bodyText,
              flowId: flow.id,
              runId: run.id,
              providerMessageId: msg.id
            },
            db
          );
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
      if (seenRows.length > 0) {
        // Mark every (flow, message) pair evaluated — match or not — so the
        // next poll's read budget only goes to genuinely new mail. Written
        // after the whole batch: a crash mid-batch re-reads it next tick and
        // the run dedupe keys absorb the repeat enqueues.
        const { error: seenErr } = await db
          .from("ai_flow_email_seen")
          .upsert(seenRows, { onConflict: "flow_id,message_id", ignoreDuplicates: true });
        if (seenErr) throw new Error(`seen record: ${seenErr.message}`);
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
