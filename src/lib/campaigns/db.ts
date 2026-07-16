/**
 * Email campaigns — DB access.
 *
 * `email_campaigns` holds the campaign lifecycle (draft → scheduled →
 * sending → sent, or cancelled); `email_campaign_recipients` holds the
 * audience snapshot taken when sending starts. Both tables are
 * service-role-only (RLS on, no policies) — every access flows through the
 * Next.js server after its own auth checks, matching business_documents.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailCampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

export type EmailCampaignRow = {
  id: string;
  business_id: string;
  subject: string;
  body_md: string;
  audience_tag: string;
  status: EmailCampaignStatus;
  send_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  recipients_total: number;
  recipients_sent: number;
  recipients_failed: number;
  created_at: string;
  updated_at: string;
};

export type CampaignRecipientRow = {
  id: string;
  campaign_id: string;
  business_id: string;
  contact_id: string;
  email: string;
  status: "pending" | "sent" | "failed";
  error_detail: string | null;
  sent_at: string | null;
  created_at: string;
};

/** Per-campaign audience cap — abuse-safety, not a product tier. */
export const CAMPAIGN_MAX_RECIPIENTS = 2000;

export async function listEmailCampaigns(
  businessId: string,
  client?: SupabaseClient
): Promise<EmailCampaignRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listEmailCampaigns: ${error.message}`);
  return (data ?? []) as EmailCampaignRow[];
}

export async function getEmailCampaign(
  businessId: string,
  campaignId: string,
  client?: SupabaseClient
): Promise<EmailCampaignRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .select()
    .eq("business_id", businessId)
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw new Error(`getEmailCampaign: ${error.message}`);
  return (data as EmailCampaignRow | null) ?? null;
}

export async function insertEmailCampaign(
  row: Pick<EmailCampaignRow, "business_id" | "subject" | "body_md" | "audience_tag"> &
    Partial<Pick<EmailCampaignRow, "status" | "send_at">>,
  client?: SupabaseClient
): Promise<EmailCampaignRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertEmailCampaign: ${error.message}`);
  return data as EmailCampaignRow;
}

export type EmailCampaignPatch = Partial<
  Pick<
    EmailCampaignRow,
    | "subject"
    | "body_md"
    | "audience_tag"
    | "status"
    | "send_at"
    | "started_at"
    | "completed_at"
    | "recipients_total"
    | "recipients_sent"
    | "recipients_failed"
  >
>;

export async function patchEmailCampaign(
  businessId: string,
  campaignId: string,
  patch: EmailCampaignPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("email_campaigns")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", campaignId);
  if (error) throw new Error(`patchEmailCampaign: ${error.message}`);
}

/**
 * Guarded lifecycle transition: applies `patch` only while the campaign is
 * still in `fromStatus`. Returns whether a row actually moved — the sweep's
 * scheduled→sending promotion and the owner's cancel both race through
 * here, and the loser must see "no rows" instead of clobbering.
 */
export async function transitionEmailCampaign(
  businessId: string,
  campaignId: string,
  fromStatus: EmailCampaignStatus,
  patch: EmailCampaignPatch,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", campaignId)
    .eq("status", fromStatus)
    .select("id");
  if (error) throw new Error(`transitionEmailCampaign: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function deleteEmailCampaign(
  businessId: string,
  campaignId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("email_campaigns")
    .delete()
    .eq("business_id", businessId)
    .eq("id", campaignId);
  if (error) throw new Error(`deleteEmailCampaign: ${error.message}`);
}

/** Campaigns whose send time has passed, oldest first (sweep promotion). */
export async function listDueScheduledCampaigns(
  nowIso: string,
  client?: SupabaseClient
): Promise<EmailCampaignRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .select()
    .eq("status", "scheduled")
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listDueScheduledCampaigns: ${error.message}`);
  return (data ?? []) as EmailCampaignRow[];
}

/** Campaigns mid-send (the sweep drains their pending recipients). */
export async function listSendingCampaigns(client?: SupabaseClient): Promise<EmailCampaignRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaigns")
    .select()
    .eq("status", "sending")
    .order("started_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listSendingCampaigns: ${error.message}`);
  return (data ?? []) as EmailCampaignRow[];
}

/** Insert the audience snapshot (idempotent per contact via the unique key). */
export async function insertCampaignRecipients(
  rows: Array<Pick<CampaignRecipientRow, "campaign_id" | "business_id" | "contact_id" | "email">>,
  client?: SupabaseClient
): Promise<void> {
  if (rows.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("email_campaign_recipients")
    .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true });
  if (error) throw new Error(`insertCampaignRecipients: ${error.message}`);
}

/** The next batch of unsent recipients for a campaign. */
export async function listPendingRecipients(
  campaignId: string,
  limit: number,
  client?: SupabaseClient
): Promise<CampaignRecipientRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaign_recipients")
    .select()
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listPendingRecipients: ${error.message}`);
  return (data ?? []) as CampaignRecipientRow[];
}

/**
 * Atomically claim a pending recipient by optimistically marking it sent
 * (conditional on `status = 'pending'`). Returns whether THIS caller won
 * the claim — overlapping sweeps and post-crash retries lose cleanly, so a
 * recipient can never receive the campaign twice. The at-most-once bias is
 * deliberate for marketing mail: a duplicate is a spam complaint, a rare
 * crash-window loss is harmless.
 */
export async function claimRecipient(
  recipientId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("email_campaign_recipients")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", recipientId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`claimRecipient: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Outcome stamp for one recipient (downgrades a claimed row on send failure). */
export async function markRecipient(
  recipientId: string,
  status: "sent" | "failed",
  errorDetail: string | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("email_campaign_recipients")
    .update({
      status,
      error_detail: errorDetail,
      sent_at: status === "sent" ? new Date().toISOString() : null
    })
    .eq("id", recipientId);
  if (error) throw new Error(`markRecipient: ${error.message}`);
}

/**
 * Convergent counters: derive sent/failed from the recipient rows instead
 * of read-modify-write increments on the campaign row (which drift under
 * concurrent sweeps).
 */
export async function countRecipientsByStatus(
  campaignId: string,
  status: "pending" | "sent" | "failed",
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", status);
  if (error) throw new Error(`countRecipientsByStatus: ${error.message}`);
  return count ?? 0;
}
