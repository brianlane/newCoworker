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

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailLogSource =
  | "ai_flow"
  | "owner_mailbox"
  | "email_trigger"
  | "dashboard_chat"
  | "sms_assistant"
  | "voice_assistant"
  | "tenant_mailbox_inbound"
  | "tenant_mailbox_outbound";

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
  const { data, error } = await db
    .from("email_log")
    .select(EMAIL_LOG_SELECT)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listEmailLog: ${error.message}`);
  return (data as EmailLogRow[] | null) ?? [];
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
