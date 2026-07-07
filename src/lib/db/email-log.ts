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

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

// Column projection for residency (box) reads — mirrors EMAIL_LOG_SELECT.
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
  "created_at"
];

export type EmailLogSource =
  | "ai_flow"
  | "owner_mailbox"
  | "email_trigger"
  | "dashboard_chat"
  | "sms_assistant"
  | "voice_assistant"
  | "tenant_mailbox_inbound"
  | "tenant_mailbox_outbound"
  // Owner typed + sent this email by hand from the dashboard Emails page
  // (reply-in-thread or compose-new), sent from their connected mailbox.
  | "owner_manual";

/**
 * Attachment metadata as stored inline on email_log.attachments. `storage_path`
 * is the object key the bytes live under; it stays server-side (the dashboard
 * fetches signed URLs, never the raw path).
 *
 * `bucket` names the private Storage bucket holding the bytes. Inbound mail omits
 * it (the bytes live in `email-attachments`, which the reader treats as the
 * default). Outbound flow mail sets it to `aiflow-screenshots`, since the
 * coworker's only sent attachment is the optional lead screenshot, which already
 * lives in that bucket — we reference it in place rather than copying bytes.
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
};

// The list query intentionally omits `body_full`: it loads up to 200 rows and
// the list only renders `body_preview`. Full bodies (potentially large) are
// fetched on demand via getEmailBody when a message is opened in the reading
// pane — see /api/dashboard/emails/[id].
const EMAIL_LOG_SELECT =
  "id, business_id, direction, to_email, from_email, subject, body_preview, cc_email, bcc_email, source, run_id, flow_id, provider_message_id, created_at";

/** Join a recipient list into the stored CSV form, or null when empty. */
function recipientsToCsv(recipients?: string[] | null): string | null {
  if (!recipients || recipients.length === 0) return null;
  return recipients.join(", ");
}

export const EMAIL_LOG_DEFAULT_LIMIT = 50;
export const EMAIL_LOG_MAX_LIMIT = 200;

/** Most-recent-first email activity for a business. */
export async function listEmailLog(
  businessId: string,
  options: { limit?: number } = {},
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
    return await readMovedRows<EmailLogRow>(businessId, {
      table: "email_log",
      columns: EMAIL_LOG_COLUMNS,
      filters: [{ column: "business_id", op: "eq", value: businessId }],
      order: [{ column: "created_at", ascending: false }],
      limit
    });
  }
  const { data, error } = await db
    .from("email_log")
    .select(EMAIL_LOG_SELECT)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listEmailLog: ${error.message}`);
  return (data as EmailLogRow[] | null) ?? [];
}

/**
 * Email activity to/from a specific address, newest-first. Powers the
 * "Email history" rollup on a customer/contact profile: a profile carries an
 * optional `email`, and this returns every logged message that came FROM that
 * address (inbound) or was sent TO it (outbound), unifying email with the
 * SMS/voice history already shown there.
 *
 * Matching is case-insensitive. The address is wrapped as an anchored,
 * literal `ilike` value — `%`/`_` (legal in local-parts like `joe_smith`) are
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
          { column: "from_email", op: "ilike", value: likeValue }
        ]
      }),
      readMovedRows<EmailLogRow>(businessId, {
        ...base,
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "to_email", op: "ilike", value: likeValue }
        ]
      })
    ]);
    const byId = new Map<string, EmailLogRow>();
    for (const row of [...fromRows, ...toRows]) byId.set(row.id, row);
    return [...byId.values()]
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
    attachments: StoredAttachment[] | null;
  };
    const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const rows = await readMovedRows<BodyRow>(businessId, {
      table: "email_log",
      columns: ["body_preview", "body_full", "attachments"],
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "id", op: "eq", value: id }
      ],
      limit: 1
    });
    const boxRow = rows[0];
    if (!boxRow) return null;
    return {
      body_preview: boxRow.body_preview,
      body_full: boxRow.body_full,
      attachments: boxRow.attachments ?? []
    };
  }
  const { data, error } = await db
    .from("email_log")
    .select("body_preview, body_full, attachments")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getEmailBody: ${error.message}`);
  if (!data) return null;
  const row = data as BodyRow;
  return {
    body_preview: row.body_preview,
    body_full: row.body_full,
    attachments: row.attachments ?? []
  };
}

export type RecordInboundTriggerEmailInput = {
  businessId: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  flowId: string;
  runId: string | null;
  providerMessageId: string;
};

/**
 * Record an inbound email that triggered a flow run. Best-effort by design —
 * the run is already enqueued, so a logging failure only logs to console.
 */
export async function recordInboundTriggerEmail(
  input: RecordInboundTriggerEmailInput,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("email_log").insert({
    business_id: input.businessId,
    direction: "inbound",
    to_email: null,
    from_email: input.fromEmail,
    subject: input.subject,
    body_preview: input.bodyText.slice(0, 500),
    body_full: input.bodyText,
    source: "email_trigger",
    run_id: input.runId,
    flow_id: input.flowId,
    provider_message_id: input.providerMessageId
  });
  if (error) console.error("recordInboundTriggerEmail", error.message);
}

export type RecordTenantMailboxInboundInput = {
  businessId: string;
  /** The tenant address the mail was sent TO (e.g. amy@newcoworker.com). */
  toEmail: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
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
 */
export async function recordTenantMailboxInbound(
  input: RecordTenantMailboxInboundInput,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db.from("email_log").insert({
      business_id: input.businessId,
      direction: "inbound",
      to_email: input.toEmail,
      from_email: input.fromEmail,
      subject: input.subject,
      body_preview: input.bodyText.slice(0, 500),
      body_full: input.bodyText,
      attachments: input.attachments ?? [],
      source: "tenant_mailbox_inbound",
      run_id: input.runId ?? null,
      flow_id: input.flowId ?? null,
      provider_message_id: input.providerMessageId ?? null
    });
    if (error) console.error("recordTenantMailboxInbound", error.message);
  } catch (err) {
    console.error("recordTenantMailboxInbound", err instanceof Error ? err.message : err);
  }
}

export type RecordOutboundAssistantEmailInput = {
  businessId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  /** Surface the assistant sent from. */
  source: "dashboard_chat" | "sms_assistant" | "voice_assistant";
  providerMessageId?: string | null;
  /** Optional cc recipients (already normalized to valid addresses). */
  ccEmails?: string[];
  /** Optional bcc recipients (already normalized to valid addresses). */
  bccEmails?: string[];
};

/**
 * Record an owner-mailbox email the assistant sent from chat/SMS/voice so it
 * shows on the dashboard Emails page. Best-effort by design — the email is
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
      from_email: null,
      subject: input.subject,
      body_preview: input.bodyText.slice(0, 500),
      body_full: input.bodyText,
      cc_email: recipientsToCsv(input.ccEmails),
      bcc_email: recipientsToCsv(input.bccEmails),
      source: input.source,
      run_id: null,
      flow_id: null,
      provider_message_id: input.providerMessageId ?? null
    });
    if (error) console.error("recordOutboundAssistantEmail", error.message);
  } catch (err) {
    console.error("recordOutboundAssistantEmail", err instanceof Error ? err.message : err);
  }
}
