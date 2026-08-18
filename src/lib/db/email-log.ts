/**
 * Email activity reads/writes for the owner dashboard Emails page.
 *
 * `email_log` is the append-only record of coworker email activity:
 *   - outbound `ai_flow` rows: flow `send_email` steps sent via Resend
 *     (written by the ai-flow-worker Edge function)
 *   - outbound `owner_mailbox` rows: flow sends through the owner's
 *     connected Gmail/Outlook (also written by the worker)
 *   - outbound `dashboard_chat` / `sms_assistant` / `voice_assistant` rows:
 *     owner-mailbox sends the assistant made from those surfaces (written
 *     by the tool adapters via recordOutboundAssistantEmail)
 *   - inbound `email_trigger` rows: emails that triggered a flow run
 *     (written by the email-trigger poller in this app)
 *
 * Every helper scopes by `business_id` so one business can never read
 * another's mail.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { escapeLikeLiteral, isVpsReadMode, readMovedRows } from "@/lib/residency/read";
import type { DataApiFilter } from "@/lib/residency/contract";
import { softDeleteContentRows } from "@/lib/residency/row-delete";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

// Column projection for residency (box) reads, mirrors EMAIL_LOG_SELECT.
const EMAIL_LOG_COLUMNS = [
  "id",
  "business_id",
  "direction",
  "to_email",
  "from_email",
  "subject",
  "body_preview",
  "cc_email",
  "bcc_email",
  "source",
  "run_id",
  "flow_id",
  "provider_message_id",
  "created_at",
  "is_read",
  "archived_at",
  "folder",
  "labels",
  "importance"
];

export type EmailLogSource =
  | "ai_flow"
  | "owner_mailbox"
  | "email_trigger"
  | "dashboard_chat"
  | "sms_assistant"
  | "voice_assistant"
  // The verified owner asked from the Slack surface (EMAIL_SEND block
  // fulfilled by src/lib/slack/worker.ts).
  | "slack_assistant"
  | "tenant_mailbox_inbound"
  | "tenant_mailbox_outbound"
  // Owner typed + sent this email by hand from the dashboard Emails page
  // (reply-in-thread or compose-new), sent from their connected mailbox.
  | "owner_manual"
  // The email coworker answered a correspondent inside a thread the
  // assistant itself started (src/lib/email-coworker/turn.ts).
  | "email_coworker"
  // Booking confirmation or reminder for a public-page booking
  // (src/lib/booking-page/reminders.ts).
  | "booking_reminder";

/**
 * Attachment metadata as stored inline on email_log.attachments. `storage_path`
 * is the object key the bytes live under; it stays server-side (the dashboard
 * fetches signed URLs, never the raw path).
 *
 * `bucket` names the private Storage bucket holding the bytes. Inbound mail omits
 * it (the bytes live in `email-attachments`, which the reader treats as the
 * default). Outbound flow mail sets it to `aiflow-screenshots`, since the
 * coworker's only sent attachment is the optional lead screenshot, which already
 * lives in that bucket, we reference it in place rather than copying bytes.
 */
export type StoredAttachment = {
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  bucket?: string;
};

export type EmailLogRow = {
  id: string;
  business_id: string;
  direction: "outbound" | "inbound";
  to_email: string | null;
  from_email: string | null;
  subject: string | null;
  body_preview: string | null;
  /** Comma-separated cc recipients, or null when none. */
  cc_email: string | null;
  /** Comma-separated bcc recipients, or null when none. */
  bcc_email: string | null;
  source: EmailLogSource;
  run_id: string | null;
  flow_id: string | null;
  provider_message_id: string | null;
  created_at: string;
  /** False until the owner or an organize step marks it read. */
  is_read: boolean;
  /** Set when archived; null means Inbox (when not deleted). */
  archived_at: string | null;
  /** In-app folder name; null means Inbox. */
  folder: string | null;
  /** In-app labels (Gmail-like multi-label). */
  labels: string[];
  /**
   * Model-assigned 1-10 relative importance, written by an `email_organize`
   * step. Null when nothing ever scored this message.
   *
   * DISPLAY AND SORT ONLY. Never branch alerting, routing, or digest behavior
   * on it: the value comes from a language model, and models cluster and drift
   * on unanchored numeric scales, which is good enough to order a list and not
   * good enough to decide whether to wake someone. Routing lives on the named
   * `classify` categories, which are prose a human can edit when they misfire.
   */
  importance: number | null;
};

// The list query intentionally omits `body_full`: it loads up to 200 rows and
// the list only renders `body_preview`. Full bodies (potentially large) are
// fetched on demand via getEmailBody when a message is opened in the reading
// pane, see /api/dashboard/emails/[id].
const EMAIL_LOG_SELECT =
  "id, business_id, direction, to_email, from_email, subject, body_preview, cc_email, bcc_email, source, run_id, flow_id, provider_message_id, created_at, is_read, archived_at, folder, labels, importance";

/** Join a recipient list into the stored CSV form, or null when empty. */
function recipientsToCsv(recipients?: string[] | null): string | null {
  if (!recipients || recipients.length === 0) return null;
  return recipients.join(", ");
}

export const EMAIL_LOG_DEFAULT_LIMIT = 50;
export const EMAIL_LOG_MAX_LIMIT = 200;

export type ListEmailLogFilters = {
  limit?: number;
  /** inbound | outbound */
  direction?: "inbound" | "outbound";
  /**
   * When true: Inbox view (inbound, not archived, folder null).
   * When false: only archived rows.
   */
  inbox?: boolean;
  unreadOnly?: boolean;
  folder?: string | null;
  /** Match rows whose labels array contains this value. */
  label?: string | null;
  /** Restrict to these email_log.source values. */
  sources?: EmailLogSource[];
};

function normalizeEmailLogRow(row: EmailLogRow): EmailLogRow {
  return {
    ...row,
    is_read: row.is_read === true,
    archived_at: row.archived_at ?? null,
    folder: row.folder ?? null,
    labels: Array.isArray(row.labels) ? row.labels : [],
    importance: typeof row.importance === "number" ? row.importance : null
  };
}

/** Most-recent-first email activity for a business. */
export async function listEmailLog(
  businessId: string,
  options: ListEmailLogFilters = {},
  client?: SupabaseClient
): Promise<EmailLogRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const raw = options.limit;
  const limit = Math.max(
    1,
    Math.min(
      typeof raw === "number" && Number.isFinite(raw) ? raw : EMAIL_LOG_DEFAULT_LIMIT,
      EMAIL_LOG_MAX_LIMIT
    )
  );
  const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const filters: DataApiFilter[] = [
      { column: "business_id", op: "eq", value: businessId },
      { column: "deleted_at", op: "is", value: null }
    ];
    if (options.inbox === true) {
      filters.push({ column: "direction", op: "eq", value: "inbound" });
      filters.push({ column: "archived_at", op: "is", value: null });
      filters.push({ column: "folder", op: "is", value: null });
    } else if (options.direction) {
      filters.push({ column: "direction", op: "eq", value: options.direction });
    }
    if (options.inbox === false) {
      // Data API has no "is not null"; any real timestamp beats null in gte.
      filters.push({
        column: "archived_at",
        op: "gte",
        value: "1970-01-01T00:00:00.000Z"
      });
    }
    if (options.unreadOnly) {
      filters.push({ column: "is_read", op: "eq", value: false });
    }
    if (options.folder) {
      filters.push({ column: "folder", op: "eq", value: options.folder });
    }
    if (options.sources?.length) {
      filters.push({ column: "source", op: "in", value: options.sources });
    }
    // Box path has no contains-array filter; filter labels in JS after fetch.
    const rows = await readMovedRows<EmailLogRow>(businessId, {
      table: "email_log",
      columns: EMAIL_LOG_COLUMNS,
      filters,
      order: [{ column: "created_at", ascending: false }],
      limit: options.label ? Math.min(limit * 4, EMAIL_LOG_MAX_LIMIT) : limit
    });
    let out = rows.map(normalizeEmailLogRow);
    if (options.label) {
      const wanted = options.label.toLowerCase();
      out = out.filter((r) => r.labels.some((l) => l.toLowerCase() === wanted)).slice(0, limit);
    }
    return out.slice(0, limit);
  }
  let q = db
    .from("email_log")
    .select(EMAIL_LOG_SELECT)
    .eq("business_id", businessId)
    .is("deleted_at", null);
  if (options.inbox === true) {
    q = q.eq("direction", "inbound").is("archived_at", null).is("folder", null);
  } else if (options.direction) {
    q = q.eq("direction", options.direction);
  }
  if (options.inbox === false) q = q.not("archived_at", "is", null);
  if (options.unreadOnly) q = q.eq("is_read", false);
  if (options.folder) q = q.eq("folder", options.folder);
  if (options.sources?.length) q = q.in("source", options.sources);
  if (options.label) q = q.contains("labels", [options.label]);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`listEmailLog: ${error.message}`);
  return ((data as EmailLogRow[] | null) ?? []).map(normalizeEmailLogRow);
}

/**
 * Of these conversations, which has an AiFlow already answered?
 *
 * The discriminator is `run_id`: the flow worker stamps its own run on every
 * email it logs, while the coworker (`recordOutboundAssistantEmail`) and the
 * outreach sweep both write `run_id: null`. So this asks precisely "did a
 * GATED flow reply here", not "did anything of ours reply here".
 *
 * That distinction is the whole point. A flow reply means Brian approved it at
 * a gate, and every later message on that conversation should go back through
 * the same gate rather than out unseen: he did not gate the first email to a
 * stranger and then mean "send whatever you like after that". But a thread the
 * COWORKER owns (an outreach pitch, a booking follow-up) is its job to carry,
 * and blocking on any outbound row would have stopped it after its own first
 * reply, breaking the multi-turn budget it is built around.
 *
 * Best-effort and fails OPEN: a read error costs at most one duplicate reply,
 * while failing closed would silence the coworker on every thread it owns.
 */
export async function threadsAnsweredByFlow(
  businessId: string,
  threadIds: string[],
  client?: SupabaseClient
): Promise<Set<string>> {
  const wanted = [...new Set(threadIds.map((t) => t.trim()).filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const db = client ?? (await createSupabaseServiceClient());
  const out = new Set<string>();
  try {
    const { data, error } = await db
      .from("email_log")
      .select("thread_id")
      .eq("business_id", businessId)
      .eq("direction", "outbound")
      .not("run_id", "is", null)
      .in("thread_id", wanted);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ thread_id?: string | null }>) {
      if (row.thread_id) out.add(row.thread_id);
    }
  } catch (e) {
    console.error("threadsAnsweredByFlow", e instanceof Error ? e.message : String(e));
  }
  return out;
}

/**
 * One email_log row by id, scoped by business so a guessed uuid can never read
 * another tenant's mail. Returns null when the id does not belong to the
 * business, is soft-deleted, or does not exist.
 *
 * Why this exists: the Emails page renders only the newest 100 rows, and the
 * reading pane resolves its selection against that array. An owner tapping a
 * deep link from an SMS alert days later, or on a busy mailbox, would open the
 * page to nothing. This fetches the one row the link names so it can be merged
 * into the list regardless of age.
 */
export async function getEmailLogRow(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<EmailLogRow | null> {
  const rowId = id.trim();
  if (!rowId) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const rows = await readMovedRows<EmailLogRow>(businessId, {
      table: "email_log",
      columns: EMAIL_LOG_COLUMNS,
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "deleted_at", op: "is", value: null },
        { column: "id", op: "eq", value: rowId }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 1
    });
    const row = rows[0];
    return row ? normalizeEmailLogRow(row) : null;
  }
  const { data, error } = await db
    .from("email_log")
    .select(EMAIL_LOG_SELECT)
    .eq("business_id", businessId)
    .eq("id", rowId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`getEmailLogRow: ${error.message}`);
  return data ? normalizeEmailLogRow(data as unknown as EmailLogRow) : null;
}

/**
 * Email activity to/from a specific address, newest-first. Powers the
 * "Email history" rollup on a customer/contact profile: a profile carries an
 * optional `email`, and this returns every logged message that came FROM that
 * address (inbound) or was sent TO it (outbound), unifying email with the
 * SMS/voice history already shown there.
 *
 * Matching is case-insensitive. The address is wrapped as an anchored,
 * literal `ilike` value, `%`/`_` (legal in local-parts like `joe_smith`) are
 * escaped so they don't act as wildcards, and the PostgREST double-quote +
 * backslash dance mirrors listCustomerMemories so reserved chars (`.`, `,`)
 * inside the address can't split the filter string.
 */
export async function listEmailLogForAddress(
  businessId: string,
  email: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<EmailLogRow[]> {
  const normalized = email.trim();
  if (!normalized) return [];
  const db = client ?? (await createSupabaseServiceClient());
  const raw = options.limit;
  const limit = Math.max(
    1,
    Math.min(
      typeof raw === "number" && Number.isFinite(raw) ? raw : EMAIL_LOG_DEFAULT_LIMIT,
      EMAIL_LOG_MAX_LIMIT
    )
  );
    const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    // The generic data-api contract has no OR filter groups, so the
    // from/to disjunction becomes two selects merged + deduped by id.
    // Two tunnel round-trips for a profile rollup is acceptable; adding
    // OR to the wire contract for one call site is not.
    const likeValue = escapeLikeLiteral(normalized);
    const base = {
      table: "email_log" as const,
      columns: EMAIL_LOG_COLUMNS,
      order: [{ column: "created_at", ascending: false }],
      limit
    };
    const [fromRows, toRows] = await Promise.all([
      readMovedRows<EmailLogRow>(businessId, {
        ...base,
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "deleted_at", op: "is", value: null },
          { column: "from_email", op: "ilike", value: likeValue }
        ]
      }),
      readMovedRows<EmailLogRow>(businessId, {
        ...base,
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "deleted_at", op: "is", value: null },
          { column: "to_email", op: "ilike", value: likeValue }
        ]
      })
    ]);
    const byId = new Map<string, EmailLogRow>();
    for (const row of [...fromRows, ...toRows]) byId.set(row.id, row);
    // Belt-and-braces exact match (case-insensitive): the escaped ILIKE is
    // already literal under PostgreSQL's default backslash escape, but the
    // rollup must never show someone else's mail if a server setting ever
    // changes LIKE escape semantics, mirror findCustomerByEmail's JS
    // re-check.
    const wanted = normalized.toLowerCase();
    return [...byId.values()]
      .filter(
        (row) =>
          row.from_email?.toLowerCase() === wanted || row.to_email?.toLowerCase() === wanted
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }
  // See listCustomerMemories for the full rationale on this two-step escape.
  const escapedForLike = normalized.replace(/[%_]/g, (m) => `\\${m}`);
  const escapedForPostgrest = escapedForLike.replace(/["\\]/g, "\\$&");
  const pattern = `"${escapedForPostgrest}"`;
  const { data, error } = await db
    .from("email_log")
    .select(EMAIL_LOG_SELECT)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .or(`from_email.ilike.${pattern},to_email.ilike.${pattern}`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listEmailLogForAddress: ${error.message}`);
  return (data ?? []) as unknown as EmailLogRow[];
}

export type EmailLogBody = {
  body_preview: string | null;
  /** Full plain-text body; null on rows predating full-body capture. */
  body_full: string | null;
  /** Raw HTML alternative; null for text-only mail and rows predating capture. */
  body_html: string | null;
  /** Stored attachment metadata (storage paths resolved to signed URLs upstream). */
  attachments: StoredAttachment[];
};

/**
 * Full body + attachment metadata for a single email, scoped by business so one
 * tenant can never read another's mail. Loaded on demand when the reading pane
 * opens (the list query omits these). Returns null when the id doesn't belong
 * to the business.
 */
export async function getEmailBody(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<EmailLogBody | null> {
  const db = client ?? (await createSupabaseServiceClient());
  type BodyRow = {
    body_preview: string | null;
    body_full: string | null;
    body_html?: string | null;
    attachments: StoredAttachment[] | null;
  };
    const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const rows = await readMovedRows<BodyRow>(businessId, {
      table: "email_log",
      columns: ["body_preview", "body_full", "body_html", "attachments"],
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "id", op: "eq", value: id },
        { column: "deleted_at", op: "is", value: null }
      ],
      limit: 1
    });
    const boxRow = rows[0];
    if (!boxRow) return null;
    return {
      body_preview: boxRow.body_preview,
      body_full: boxRow.body_full,
      body_html: boxRow.body_html ?? null,
      attachments: boxRow.attachments ?? []
    };
  }
  const { data, error } = await db
    .from("email_log")
    .select("body_preview, body_full, body_html, attachments")
    .eq("business_id", businessId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`getEmailBody: ${error.message}`);
  if (!data) return null;
  const row = data as BodyRow;
  return {
    body_preview: row.body_preview,
    body_full: row.body_full,
    body_html: row.body_html ?? null,
    attachments: row.attachments ?? []
  };
}

/**
 * Owner-facing delete of one logged email: SOFT (deleted_at stamp,
 * residency-aware, admin-restorable) but indistinguishable from a hard
 * delete in the dashboard, every reader above filters the stamp. Returns
 * the stamped-row count (0 when unknown/already deleted; idempotent).
 */
export async function softDeleteEmailLogEntry(
  businessId: string,
  id: string,
  deletedBy: string | null,
  client?: SupabaseClient
): Promise<number> {
  const result = await softDeleteContentRows(
    businessId,
    "email_log",
    [{ column: "id", op: "eq", value: id }],
    deletedBy,
    client ? { client } : {}
  );
  return Math.max(result.central, result.box ?? 0);
}

export type RecordInboundTriggerEmailInput = {
  businessId: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  flowId: string;
  runId: string | null;
  providerMessageId: string;
  /** Provider conversation id (Gmail threadId), when the provider has one. */
  threadId?: string;
  /** RFC Message-Id header, what In-Reply-To/References carry on a reply. */
  messageRef?: string;
  /** Raw To / Cc headers, so a reply can reach everyone who was on it. */
  toRecipients?: string;
  ccRecipients?: string;
};

/**
 * Record an inbound email that triggered a flow run. Best-effort by design,
 * the run is already enqueued, so a logging failure only logs to console.
 */
export async function recordInboundTriggerEmail(
  input: RecordInboundTriggerEmailInput,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("email_log").insert({
    business_id: input.businessId,
    direction: "inbound",
    to_email: input.toRecipients?.trim() || null,
    cc_email: input.ccRecipients?.trim() || null,
    from_email: input.fromEmail,
    subject: input.subject,
    body_preview: input.bodyText.slice(0, 500),
    body_full: input.bodyText,
    source: "email_trigger",
    run_id: input.runId,
    flow_id: input.flowId,
    provider_message_id: input.providerMessageId,
    // Normalized to null, never "": a blank identifier reads as real and
    // would thread a reply against nothing.
    thread_id: input.threadId?.trim() || null,
    message_ref: input.messageRef?.trim() || null,
    is_read: true
  })
    .select("id")
    .single();
  if (error) {
    console.error("recordInboundTriggerEmail", error.message);
    return null;
  }
  // The row id, so the poller can put it in the trigger scope as
  // {{trigger.email_log_id}}. A send_email step answering this conversation
  // resolves the thread off this row, so a null here degrades to a reply that
  // opens its own thread rather than one that fails.
  return (data as { id?: string } | null)?.id ?? null;
}

export type RecordTenantMailboxInboundInput = {
  businessId: string;
  /** The tenant address the mail was sent TO (e.g. amy@newcoworker.com). */
  toEmail: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  /** Raw HTML alternative for reading-pane rendering (sanitized at display). */
  bodyHtml?: string | null;
  /** Flow run this inbound mail enqueued, when it matched a tenant_email flow. */
  flowId?: string | null;
  runId?: string | null;
  providerMessageId?: string | null;
  /** Attachment metadata (bytes already uploaded to the bucket by the worker). */
  attachments?: StoredAttachment[];
};

/**
 * Record an inbound email delivered to the tenant's AI mailbox so it shows on
 * the dashboard Emails page. Best-effort: a logging failure never blocks the
 * webhook's 200 (mail is already accepted by Cloudflare at that point).
 *
 * Returns the inserted row id (null on failure) so the caller can backfill
 * the flow/run linkage AFTER enqueueing, the row must exist BEFORE any run
 * does, because doc_extract's tenant-ownership gate reads this row's
 * attachment paths (a run racing ahead of the log row would fail its
 * document read).
 */
export async function recordTenantMailboxInbound(
  input: RecordTenantMailboxInboundInput,
  client?: SupabaseClient
): Promise<string | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("email_log")
      .insert({
        business_id: input.businessId,
        direction: "inbound",
        to_email: input.toEmail,
        from_email: input.fromEmail,
        subject: input.subject,
        body_preview: input.bodyText.slice(0, 500),
        body_full: input.bodyText,
        body_html: input.bodyHtml ?? null,
        attachments: input.attachments ?? [],
        source: "tenant_mailbox_inbound",
        run_id: input.runId ?? null,
        flow_id: input.flowId ?? null,
        provider_message_id: input.providerMessageId ?? null,
        is_read: false,
        folder: null,
        labels: []
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("recordTenantMailboxInbound", error.message);
      return null;
    }
    return (data as { id?: string } | null)?.id ?? null;
  } catch (err) {
    console.error("recordTenantMailboxInbound", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Backfill the flow/run linkage on an inbound mailbox row once runs exist
 * (the row itself is written BEFORE enqueueing, see above). Best-effort.
 */
export async function linkTenantMailboxInboundRun(
  businessId: string,
  emailLogId: string,
  linkage: { flowId: string; runId: string },
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db
      .from("email_log")
      .update({ flow_id: linkage.flowId, run_id: linkage.runId })
      .eq("business_id", businessId)
      .eq("id", emailLogId);
    if (error) console.error("linkTenantMailboxInboundRun", error.message);
  } catch (err) {
    console.error("linkTenantMailboxInboundRun", err instanceof Error ? err.message : err);
  }
}

export type RecordOutboundAssistantEmailInput = {
  businessId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  /**
   * Conversation id this reply went out on (Gmail threadId / Graph
   * conversationId), when the send was threaded. Without it the row cannot
   * answer "have we already replied on this thread", which is what
   * threadsWeHaveRepliedOn asks: every outbound row in production carried
   * NULL until Aug 10 2026, so that signal could never fire.
   */
  threadId?: string;
  /** Surface the assistant sent from. */
  source:
    | "dashboard_chat"
    | "sms_assistant"
    | "voice_assistant"
    | "slack_assistant"
    | "email_coworker"
    | "booking_reminder";
  /**
   * The mailbox address the mail went out from, as reported by the
   * owner-mailbox send result (`fromEmail`). Required so no surface can
   * silently fall back to a dash on the Emails page; null only when the
   * connection's metadata carries no address.
   */
  fromEmail: string | null;
  providerMessageId?: string | null;
  /** Optional cc recipients (already normalized to valid addresses). */
  ccEmails?: string[];
  /** Optional bcc recipients (already normalized to valid addresses). */
  bccEmails?: string[];
};

/**
 * Record an owner-mailbox email the assistant sent from chat/SMS/voice so it
 * shows on the dashboard Emails page. Best-effort by design, the email is
 * already out, so a logging failure only logs to console.
 */
export async function recordOutboundAssistantEmail(
  input: RecordOutboundAssistantEmailInput,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db.from("email_log").insert({
      business_id: input.businessId,
      direction: "outbound",
      to_email: input.toEmail,
      from_email: input.fromEmail,
      subject: input.subject,
      body_preview: input.bodyText.slice(0, 500),
      body_full: input.bodyText,
      cc_email: recipientsToCsv(input.ccEmails),
      bcc_email: recipientsToCsv(input.bccEmails),
      source: input.source,
      run_id: null,
      flow_id: null,
      provider_message_id: input.providerMessageId ?? null,
      // The conversation this went out on, when the caller threaded it.
      // Without this an outbound row is invisible to any "have we already
      // replied here" question: threadsWeHaveRepliedOn matches on thread_id,
      // and every outbound row in production carried NULL until Aug 10 2026,
      // so the signal it feeds could never fire.
      thread_id: input.threadId?.trim() || null,
      is_read: true
    });
    if (error) console.error("recordOutboundAssistantEmail", error.message);
  } catch (err) {
    console.error("recordOutboundAssistantEmail", err instanceof Error ? err.message : err);
  }
}

export type OrganizeTenantEmailInput = {
  businessId: string;
  emailLogId?: string | null;
  providerMessageId?: string | null;
  markRead?: boolean;
  markUnread?: boolean;
  archive?: boolean;
  unarchive?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
  /** null or "" clears folder back to Inbox. */
  moveToFolder?: string | null;
};

/**
 * Apply in-app organization to one email_log row (AI mailbox). Returns true
 * when a row was updated.
 */
export async function organizeTenantEmailLog(
  input: OrganizeTenantEmailInput,
  client?: SupabaseClient
): Promise<boolean> {
  if (!input.emailLogId && !input.providerMessageId) return false;
  const db = client ?? (await createSupabaseServiceClient());
  let q = db
    .from("email_log")
    .select("id, is_read, archived_at, folder, labels")
    .eq("business_id", input.businessId)
    .is("deleted_at", null);
  if (input.emailLogId) q = q.eq("id", input.emailLogId);
  else q = q.eq("provider_message_id", input.providerMessageId!);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`organizeTenantEmailLog: ${error.message}`);
  if (!data) return false;
  const row = data as {
    id: string;
    is_read: boolean | null;
    archived_at: string | null;
    folder: string | null;
    labels: string[] | null;
  };

  const patch: Record<string, unknown> = {};
  if (input.markRead) patch.is_read = true;
  if (input.markUnread) patch.is_read = false;
  if (input.archive) {
    patch.archived_at = new Date().toISOString();
  }
  if (input.unarchive) {
    patch.archived_at = null;
  }
  if (input.moveToFolder !== undefined) {
    const folder = (input.moveToFolder ?? "").trim();
    patch.folder = folder.length > 0 ? folder.slice(0, 120) : null;
  }
  const labels = (Array.isArray(row.labels) ? row.labels : []).filter(
    (l): l is string => typeof l === "string" && l.length > 0
  );
  let labelsChanged = false;
  for (const add of input.addLabels ?? []) {
    const t = add.trim().slice(0, 120);
    if (!t) continue;
    if (!labels.some((l) => l.toLowerCase() === t.toLowerCase())) {
      labels.push(t);
      labelsChanged = true;
    }
  }
  for (const rem of input.removeLabels ?? []) {
    const t = rem.trim().toLowerCase();
    if (!t) continue;
    const next = labels.filter((l) => l.toLowerCase() !== t);
    if (next.length !== labels.length) {
      labels.length = 0;
      labels.push(...next);
      labelsChanged = true;
    }
  }
  if (labelsChanged) patch.labels = labels.slice(0, 50);
  if (Object.keys(patch).length === 0) return true;

  const { error: updErr } = await db
    .from("email_log")
    .update(patch)
    .eq("business_id", input.businessId)
    .eq("id", row.id);
  if (updErr) throw new Error(`organizeTenantEmailLog update: ${updErr.message}`);
  return true;
}

/** Valid range for {@link setEmailLogImportance}, mirroring the DB check. */
export const EMAIL_IMPORTANCE_MIN = 1;
export const EMAIL_IMPORTANCE_MAX = 10;

/**
 * Coerce a model-produced importance score to a storable 1-10 integer, or null.
 *
 * Deliberately lenient about SHAPE and strict about RANGE. The value arrives as
 * a rendered template string ("6", " 6 ", "6/10", ""), because it comes from a
 * language model asked for a number, and asking is not the same as receiving.
 * A leading integer is taken; anything with no leading integer is null, which
 * reads as "never scored" rather than a wrong score.
 *
 * Out-of-range values are CLAMPED, not rejected. A model that answers 0 or 11
 * has still expressed "least" or "most", and the DB check constraint would
 * otherwise turn that into a failed step over a display field.
 */
export function coerceEmailImportance(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const match = /^-?\d+/.exec(text);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(EMAIL_IMPORTANCE_MAX, Math.max(EMAIL_IMPORTANCE_MIN, n));
}

/**
 * Write the display-only importance score onto one email_log row, found by row
 * id or provider message id. Returns true when a row was updated.
 *
 * Separate from organizeTenantEmailLog because importance is an APP-SIDE
 * annotation with no provider counterpart: a connected Gmail or Outlook message
 * gets its labels at the provider and its score here, so this has to run on
 * every path, not just the AI-mailbox one.
 */
export async function setEmailLogImportance(
  businessId: string,
  target: { emailLogId?: string | null; providerMessageId?: string | null },
  importance: number | null,
  client?: SupabaseClient
): Promise<boolean> {
  const emailLogId = target.emailLogId?.trim() || null;
  const providerMessageId = target.providerMessageId?.trim() || null;
  if (!emailLogId && !providerMessageId) return false;
  const db = client ?? (await createSupabaseServiceClient());
  let q = db
    .from("email_log")
    .update({ importance })
    .eq("business_id", businessId)
    .is("deleted_at", null);
  q = emailLogId ? q.eq("id", emailLogId) : q.eq("provider_message_id", providerMessageId!);
  // .select() so a write matching ZERO rows is visible: PostgREST reports no
  // error for an update that matched nothing, and a silent miss here would
  // read as "scored" while the Emails page shows a blank forever.
  const { data, error } = await q.select("id");
  if (error) throw new Error(`setEmailLogImportance: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * The identity needed to answer INSIDE an existing conversation, or null when
 * this row cannot be replied into.
 *
 * Shaped to drop straight into `sendFromMailboxConnection`'s `thread`
 * argument. Null (rather than a partial object) when the row predates the
 * reply feature, came from a provider that exposes no conversation id, or
 * does not exist: the caller then sends unthreaded, which still delivers the
 * mail instead of failing the step over a missing header.
 *
 * `thread_id` is the load-bearing one. Gmail files by it, and without it a
 * `References` header alone will not put the reply in the right conversation,
 * so a row holding only a message_ref is treated as unthreadable.
 */
export async function getEmailLogThreadIdentity(
  businessId: string,
  emailLogId: string,
  client?: SupabaseClient
): Promise<{
  threadId: string;
  inReplyToMessageRef?: string;
  providerMessageId?: string;
  /**
   * Everyone else who was on the original, so a reply reaches them too, kept
   * in the SLOT they arrived in. An introduction names the PROSPECT here while
   * the introducer sits in From, and answering only From reaches the person
   * doing the favor.
   *
   * Split rather than flattened because a reply should read like the thread it
   * is on: someone the sender put on To is a participant, and demoting them to
   * Cc says they are a bystander. Live, Aug 8 2026, the referral put the
   * prospect on To with no Cc at all, and the reply invented one.
   */
  replyToRecipients: string[];
  replyCcRecipients: string[];
} | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_log")
    .select("id, thread_id, message_ref, provider_message_id, to_email, cc_email")
    .eq("business_id", businessId)
    .eq("id", emailLogId)
    .maybeSingle();
  if (error) {
    console.error("getEmailLogThreadIdentity", error.message);
    return null;
  }
  const row = data as {
    thread_id?: string | null;
    message_ref?: string | null;
    provider_message_id?: string | null;
    to_email?: string | null;
    cc_email?: string | null;
  } | null;
  const threadId = row?.thread_id?.trim();
  if (!threadId) return null;
  const messageRef = row?.message_ref?.trim();
  const providerMessageId = row?.provider_message_id?.trim();
  // Split the raw headers into addresses. Display names are dropped: the
  // send path wants bare addresses, and "Name <a@b.c>" would fail its
  // validation.
  const addresses = (header: string | null | undefined): string[] => [
    ...new Set(
      (header ?? "")
        .split(",")
        .map((raw) => {
          const m = /<([^<>]+)>/.exec(raw);
          return (m ? m[1] : raw).trim().toLowerCase();
        })
        .filter((a) => a.includes("@"))
    )
  ];
  const replyToRecipients = addresses(row?.to_email);
  const ccSet = new Set(replyToRecipients);
  return {
    threadId,
    ...(messageRef ? { inReplyToMessageRef: messageRef } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    replyToRecipients,
    // Never repeat an address across both slots: some clients show the
    // duplicate, and it reads as sloppy on a reply going to a prospect.
    replyCcRecipients: addresses(row?.cc_email).filter((a) => !ccSet.has(a))
  };
}
