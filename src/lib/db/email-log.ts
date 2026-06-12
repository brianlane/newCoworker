/**
 * Email activity reads/writes for the owner dashboard Emails page.
 *
 * `email_log` is the append-only record of coworker email activity:
 *   - outbound `ai_flow` rows: flow `send_email` steps sent via Resend
 *     (written by the ai-flow-worker Edge function)
 *   - outbound `owner_mailbox` rows: flow sends through the owner's
 *     connected Gmail/Outlook (also written by the worker)
 *   - inbound `email_trigger` rows: emails that triggered a flow run
 *     (written by the email-trigger poller in this app)
 *
 * Every helper scopes by `business_id` so one business can never read
 * another's mail.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailLogSource = "ai_flow" | "owner_mailbox" | "email_trigger";

export type EmailLogRow = {
  id: string;
  business_id: string;
  direction: "outbound" | "inbound";
  to_email: string | null;
  from_email: string | null;
  subject: string | null;
  body_preview: string | null;
  source: EmailLogSource;
  run_id: string | null;
  flow_id: string | null;
  provider_message_id: string | null;
  created_at: string;
};

const EMAIL_LOG_SELECT =
  "id, business_id, direction, to_email, from_email, subject, body_preview, source, run_id, flow_id, provider_message_id, created_at";

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
