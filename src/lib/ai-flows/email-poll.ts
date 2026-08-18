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
 *
 * Mark-handled: when a Gmail message starts a run of a flow that can itself
 * answer the email (the flow has a send_email step), the message is marked
 * read in the owner's mailbox (best-effort, once per message even if several
 * flows matched), so the inbox reflects that the AI coworker handled it.
 * This is the write half of the gmail.modify grant the Google OAuth
 * verification declares: read, reply from the owner's address, mark handled.
 * Notify-only flows (e.g. inbox triage that texts the owner) leave read
 * state alone: the owner still has to read those emails, and a triage flow
 * silently marking them read makes the inbox lie about what needs attention.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { connectionEmail } from "@/lib/email/mailbox-options";
import { tenantEmailDomain } from "@/lib/email/tenant-mailbox";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import {
  emailTriggerScope,
  evaluateTriggerConditions,
  htmlToText,
  looksLikeStrippedTemplate,
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
  /**
   * One condition list per email trigger the flow has ON THIS MAILBOX (OR
   * semantics): a message matches the flow when any list matches. A flow
   * watching two different mailboxes appears once per mailbox group.
   */
  conditionSets: TriggerCondition[][];
  /**
   * Whether the flow can answer the email itself (a send_email step anywhere
   * in its step tree, branch arms included). Only such flows mark the
   * triggering Gmail message read; notify-only flows must leave the owner's
   * unread state alone.
   */
  handlesEmail: boolean;
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
 * text/plain part — UNLESS it is itself tag-stripped template source (some
 * senders flatten their HTML naively, leaving stylesheets and `*|MC:...|*`
 * merge tags in the "text"; same detection as the tenant-mailbox worker) —
 * falling back to the text/html part collapsed properly. Pure + exported for
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
  const html = flat.find((p) => p.mimeType === "text/html" && p.body?.data);
  const plainText = plain ? b64UrlDecode(plain.body!.data!) : "";
  if (plainText.trim() && !(html && looksLikeStrippedTemplate(plainText))) return plainText;
  if (html) return htmlToText(b64UrlDecode(html.body!.data!)) || plainText;
  return plainText;
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
  // `-from:me` is the loop breaker, and it has to be the PROVIDER's idea of
  // "me", not ours. Live, Aug 7 2026: the sales arm replied-all, which cc'd
  // team@newcoworker.com (our own alias, since the Cloudflare catch-all
  // forwards it into this very mailbox). The reply came straight back as
  // genuinely RECEIVED mail, matched the flow again, drafted another reply,
  // and went round six times before Brian stopped it.
  //
  // `in:inbox` does not help: a self-addressed message really is delivered to
  // the inbox. Nor does an address list of ours, because the send went out as
  // a send-as ALIAS (team@) rather than the account (newcoworkerteam@). Gmail
  // resolves `me` to the account AND every configured send-as alias, which is
  // exactly the set we cannot enumerate ourselves. Verified against the live
  // HQ mailbox: it drops all seven self-sent copies and keeps the real lead.
  const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceMs / 1000)} -from:me`);
  // List the whole lookback window first (id-only pages are cheap) — Gmail's
  // list order is NOT guaranteed, so capping mid-listing could repeatedly
  // keep the same arbitrary subset and starve the rest across ticks.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await workspaceProxyForBusiness(businessId, link, {
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
    // faster than it can possibly be evaluated, flagged as overflow below.
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
    const res = await workspaceProxyForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${id}?format=full`,
      method: "GET"
    });
    /* c8 ignore next -- the link verified above; a mid-loop revoke just skips the message */
    if (!res) continue;
    const msg = res.data as {
      payload?: GmailPart & { headers?: GmailHeader[] };
      internalDate?: string;
      threadId?: string;
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
      // Gmail groups a conversation under one threadId, which every reply
      // shares. Carried through to {{trigger.thread_id}} so a notify step can
      // cool down per CONVERSATION instead of texting once per reply.
      ...(typeof msg.threadId === "string" && msg.threadId.trim()
        ? { threadId: msg.threadId.trim() }
        : {}),
      // The RFC Message-Id, which In-Reply-To and References carry. Same
      // header read the email coworker's own fetcher does
      // (src/lib/email-coworker/mailbox.ts); a reply into this thread needs
      // it alongside the threadId.
      ...(gmailHeader(headers, "Message-Id").trim()
        ? { messageRef: gmailHeader(headers, "Message-Id").trim() }
        : {}),
      // Who else was on the message. An introduction puts the PROSPECT here
      // and the introducer in From, so a reply addressed only to From reaches
      // the person doing the favor and never the lead.
      ...(gmailHeader(headers, "To").trim() ? { toRecipients: gmailHeader(headers, "To") } : {}),
      ...(gmailHeader(headers, "Cc").trim() ? { ccRecipients: gmailHeader(headers, "Cc") } : {}),
      receivedAt:
        msg.internalDate && Number.isFinite(internalMs)
          ? new Date(internalMs).toISOString()
          : undefined
    });
  }
  return { messages: out, overflowed };
}

/**
 * Mark a Gmail message read once a run has been enqueued for it (remove the
 * UNREAD label via users.messages.modify). Only called for flows that can
 * answer the email themselves (send_email step); see the header comment.
 * Best-effort by design: the run is already durably enqueued, so a failure
 * here only logs a warning; it must never fail the poll or the run.
 * Microsoft mailboxes are untouched (their granted scope set has no
 * equivalent commitment).
 */
export async function markGmailMessageHandled(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  messageId: string
): Promise<void> {
  try {
    const res = await workspaceProxyForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${messageId}/modify`,
      method: "POST",
      data: { removeLabelIds: ["UNREAD"] }
    });
    if (!res) throw new Error("email_not_connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSystemLog({
      businessId,
      source: "aiflow",
      level: "warn",
      event: "ai_flow_email_mark_read_failed",
      message: `Could not mark triggering email read: ${message}`,
      payload: { message_id: messageId }
    });
  }
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
    const res = await workspaceProxyForBusiness(businessId, link, { endpoint, method: "GET" });
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

/**
 * Whether a stored step tree ALWAYS answers the email: an unconditional
 * `send_email` on the trunk.
 *
 * This used to accept a send_email ANYWHERE, including inside a branch arm or
 * behind a `when` guard. That held while a flow was either a responder or a
 * notifier, and broke the moment one flow became both: the HQ inbox triage
 * grew a reply arm for sales leads, flipped to "answers email", and started
 * marking Zapier newsletters read on the way past. The header comment on this
 * module already warned that "a triage flow silently marking them read makes
 * the inbox lie about what needs attention" — the predicate was just too
 * generous to honor it.
 *
 * Deliberately conservative. A `when`, a branch arm, or an approval gate all
 * mean the send MIGHT not happen, and the poll cannot know at enqueue time
 * whether it will. Guessing wrong in this direction leaves a message unread
 * that we answered, which the owner notices and shrugs at; guessing wrong the
 * other way hides mail nobody has looked at.
 *
 * A flow that wants a conditionally-answered message marked read should say
 * so where it knows the answer: an `email_organize` step with
 * `markRead: true` on the arm that did the replying.
 *
 * Schema-tolerant like collectRawWorkspaceConnectionRefs: stored definitions
 * can predate the current schema, and unknown shapes contribute nothing.
 */
function rawStepsSendEmail(steps: unknown[]): boolean {
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as { type?: unknown; when?: unknown };
    // Trunk only, and unguarded: nested arms are conditional by construction.
    if (step.type === "send_email" && step.when === undefined) return true;
  }
  return false;
}

function emailFlowsFrom(
  rows: Array<{ id: string; business_id: string; definition: unknown }>
): EmailFlow[] {
  const out: EmailFlow[] = [];
  for (const row of rows) {
    const def = row.definition as {
      trigger?: { channel?: string; connectionId?: unknown; conditions?: unknown };
      triggers?: Array<{ channel?: string; connectionId?: unknown; conditions?: unknown }>;
      steps?: unknown[];
    } | null;
    const handlesEmail = Array.isArray(def?.steps) && rawStepsSendEmail(def.steps);
    // Collect every email trigger in the flow's set, merging the ones that
    // watch the same mailbox into one entry (OR across condition lists) so a
    // flow never appears twice in a mailbox group (the seen-marker math and
    // the per-flow ref cache both key on flow id).
    const byConnection = new Map<string, TriggerCondition[][]>();
    for (const trig of [def?.trigger, ...(def?.triggers ?? [])]) {
      if (trig?.channel !== "email" || typeof trig.connectionId !== "string") continue;
      const sets = byConnection.get(trig.connectionId) ?? [];
      sets.push(Array.isArray(trig.conditions) ? (trig.conditions as TriggerCondition[]) : []);
      byConnection.set(trig.connectionId, sets);
    }
    for (const [connectionId, conditionSets] of byConnection) {
      out.push({ id: row.id, business_id: row.business_id, connectionId, conditionSets, handlesEmail });
    }
  }
  return out;
}

/**
 * Is this message one of OURS coming back at us?
 *
 * The second layer of the self-reply guard. `-from:me` handles Gmail using the
 * provider's own alias list, but Outlook has no equivalent in its filter and a
 * forwarded self-send lands in the inbox there too. This catches what we can
 * name without the provider's help: the account behind the OAuth grant, and
 * anything on the tenant email domain, which is where the AI mailbox and the
 * catch-all aliases (team@, contact@) live.
 *
 * It is deliberately not the only guard. It cannot know a send-as alias on an
 * unrelated domain, which is why the Gmail query carries `-from:me` as well.
 */
export function isOwnOutboundSender(
  fromEmail: string,
  accountEmail: string | null | undefined,
  tenantDomain: string
): boolean {
  const from = fromEmail.trim().toLowerCase();
  if (!from) return false;
  const account = (accountEmail ?? "").trim().toLowerCase();
  if (account && from === account) return true;
  const at = from.lastIndexOf("@");
  return at !== -1 && from.slice(at + 1) === tenantDomain.trim().toLowerCase();
}

/**
 * Of these conversation ids, which has this business already SENT on?
 *
 * The signal behind {{trigger.thread_has_our_reply}}. A message on a thread we
 * are already part of is the next turn of a correspondence, never a broadcast,
 * and that holds regardless of how the sender words the subject. Live, Aug 9
 * 2026: Google acknowledged our own OAuth verification request on a thread
 * Brian had replied to on Jul 30, and it was filed as routine and binned.
 *
 * Best-effort by design. A read failure returns an empty set, which is exactly
 * the behaviour before this existed, so a database blip degrades the triage
 * rather than stopping the poll.
 */
export async function threadsWeHaveRepliedOn(
  businessId: string,
  threadIds: string[],
  db: SupabaseClient
): Promise<Set<string>> {
  const wanted = [...new Set(threadIds.filter((t) => t.trim()))];
  if (wanted.length === 0) return new Set();
  try {
    const { data, error } = await db
      .from("email_log")
      .select("thread_id")
      .eq("business_id", businessId)
      .eq("direction", "outbound")
      .in("thread_id", wanted);
    if (error) throw new Error(error.message);
    return new Set(
      ((data ?? []) as Array<{ thread_id?: string | null }>)
        .map((r) => r.thread_id ?? "")
        .filter(Boolean)
    );
  } catch (e) {
    console.error("threadsWeHaveRepliedOn", e instanceof Error ? e.message : String(e));
    return new Set();
  }
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
      .is("deleted_at", null)
      .or("definition->trigger->>channel.eq.email,definition->triggers.not.is.null")
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
        // The email coworker reads the SAME inbox for replies on threads the
        // assistant started, and a message it has claimed must not also fire
        // a flow: the tenant would get two uncoordinated answers to one
        // email. Its claim is written before its turn, so this is
        // best-effort ordering (both polls run each tick); the common case,
        // a reply arriving while the coworker already holds the thread, is
        // covered. Failure here is non-fatal: flows behave as before.
        try {
          for (let i = 0; i < messageIds.length; i += 100) {
            const chunk = messageIds.slice(i, i + 100);
            const { data, error } = await db
              .from("email_coworker_seen")
              .select("message_id")
              .eq("business_id", businessId)
              .in("message_id", chunk);
            if (error) throw new Error(error.message);
            for (const row of (data ?? []) as Array<{ message_id: string }>) {
              handled.add(row.message_id);
            }
          }
        } catch (e) {
          console.error("email coworker claim lookup", e);
        }
        return handled;
      };
      const isGoogleMailbox = providerFromKey(conn.provider_config_key) === "google";
      const { messages, overflowed } = isGoogleMailbox
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
      // Drop anything we sent before it can match a flow. See
      // isOwnOutboundSender: this is the provider-agnostic half of the guard.
      const accountEmail = connectionEmail(conn.metadata ?? {});
      const tenantDomain = tenantEmailDomain();
      const ownSent = messages.filter((m) =>
        isOwnOutboundSender(m.fromEmail, accountEmail, tenantDomain)
      );
      if (ownSent.length > 0) {
        // Loud, because reaching here means the query-level guard let one
        // through and something is cc'ing us onto our own conversations.
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_email_poll_self_sent_skipped",
          message: "Skipped inbound mail sent from one of our own addresses",
          payload: {
            connection_id: connectionId,
            count: ownSent.length,
            from: [...new Set(ownSent.map((m) => m.fromEmail))].slice(0, 5)
          }
        });
      }
      const inbound = messages.filter(
        (m) => !isOwnOutboundSender(m.fromEmail, accountEmail, tenantDomain)
      );
      result.messages += inbound.length;
      // Pre-resolve each flow's from_matches saved-contact refs ONCE for this
      // poll (not per message) to live identity values (phones + emails). A
      // resolution failure fails CLOSED for that flow only.
      const refValuesByFlow = new Map<string, Map<string, string[]> | undefined>();
      for (const flow of group) {
        try {
          // Cast: the full supabase-js builder type recurses too deep for TS
          // to check structurally against the resolver's minimal chain type.
          // Refs are resolved over ALL the flow's condition lists at once (the
          // resolver returns a ref->values map keyed per condition ref).
          refValuesByFlow.set(
            flow.id,
            await resolveFromMatchesRefValues(
              db as unknown as ContactRefSupabase,
              businessId,
              flow.conditionSets.flat()
            )
          );
        } catch (e) {
          console.error("email from_matches ref resolution", e);
          refValuesByFlow.set(flow.id, undefined);
        }
      }
      const seenRows: Array<{ flow_id: string; message_id: string }> = [];
      // Messages already marked read this poll: several flows can match the
      // same message, but the mailbox write should happen once.
      const markedHandled = new Set<string>();
      // Which of these conversations have we already SENT on? Batched once
      // per poll rather than per message: this is a small IN over the
      // thread ids in hand, and the answer is the same for every flow on the
      // mailbox. A failure here degrades to "we have not replied", which is
      // the pre-existing behaviour, never a thrown poll.
      const repliedThreads = await threadsWeHaveRepliedOn(
        businessId,
        inbound.map((m) => m.threadId).filter((t): t is string => Boolean(t)),
        db
      );
      for (const msg of inbound) {
        const scope = emailTriggerScope(
          { ...msg, weRepliedOnThread: Boolean(msg.threadId && repliedThreads.has(msg.threadId)) },
          // accountEmail so the connected mailbox drops out of others_*: the
          // prospect is whoever is left after us and the sender.
          { connectionId, ...(accountEmail ? { selfEmail: accountEmail } : {}) }
        );
        for (const flow of group) {
          seenRows.push({ flow_id: flow.id, message_id: msg.id });
          if (
            !flow.conditionSets.some((conditions) =>
              evaluateTriggerConditions(
                conditions,
                scope.windowText,
                scope.from,
                refValuesByFlow.get(flow.id)
              )
            )
          )
            continue;
          // Log the email BEFORE enqueuing, so its row id can ride in the
          // trigger scope. A send_email step answering this conversation
          // resolves the thread off that row, and a scope built before the
          // row existed carried an empty {{trigger.email_log_id}}: the reply
          // went out as a NEW conversation with a "Re:" subject, un-cc'd and
          // unclaimed, while looking correct in the sent folder.
          //
          // run_id is stamped after the enqueue below. An enqueue that then
          // no-ops (an earlier tick already claimed this message) leaves one
          // run-less row on the Emails page, which is the honest record: the
          // mail did arrive.
          const emailLogId = await recordInboundTriggerEmail(
            {
              businessId,
              fromEmail: msg.fromEmail,
              subject: msg.subject,
              bodyText: msg.bodyText,
              flowId: flow.id,
              runId: null,
              providerMessageId: msg.id,
              ...(msg.threadId ? { threadId: msg.threadId } : {}),
              ...(msg.messageRef ? { messageRef: msg.messageRef } : {}),
              ...(msg.toRecipients ? { toRecipients: msg.toRecipients } : {}),
              ...(msg.ccRecipients ? { ccRecipients: msg.ccRecipients } : {})
            },
            db
          );
          const run = await enqueueAiFlowRun(
            {
              businessId,
              flowId: flow.id,
              trigger: emailLogId ? { ...scope, email_log_id: emailLogId } : scope,
              dedupeKey: `email:${msg.id}`
            },
            db
          );
          if (!run) {
            // Another tick claimed this message first and logged its own row.
            // Drop ours rather than leaving a duplicate on the Emails page:
            // logging moved ahead of the enqueue for the scope's sake, and a
            // lost race must not become visible clutter.
            if (emailLogId) {
              const { error: delErr } = await db
                .from("email_log")
                .delete()
                .eq("business_id", businessId)
                .eq("id", emailLogId);
              if (delErr) console.error("email_log dedupe cleanup", delErr.message);
            }
            continue;
          }
          result.enqueued += 1;
          if (emailLogId) {
            const { error: linkErr } = await db
              .from("email_log")
              .update({ run_id: run.id })
              .eq("business_id", businessId)
              .eq("id", emailLogId);
            if (linkErr) console.error("email_log run link", linkErr.message);
          }
          // Only a flow that answers the email itself may mark it read; a
          // notify-only run leaves the message for the owner to read.
          if (isGoogleMailbox && flow.handlesEmail && !markedHandled.has(msg.id)) {
            markedHandled.add(msg.id);
            await markGmailMessageHandled(businessId, link, msg.id);
          }
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
