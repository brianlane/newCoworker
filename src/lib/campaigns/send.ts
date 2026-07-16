/**
 * Email campaigns — the sending engine behind the per-minute
 * email-campaign-sweep (pg_cron → Edge → /api/internal/email-campaign-sweep
 * → here).
 *
 * One pass:
 *   1. Promote due scheduled campaigns to `sending` (guarded transition —
 *      an owner cancel racing the promotion wins cleanly) and snapshot
 *      their audience into email_campaign_recipients: customer contacts
 *      with an email, not marketing-unsubscribed, carrying the audience
 *      tag when one is set. The snapshot is capped and idempotent.
 *   2. Drain each sending campaign's pending recipients in a bounded batch
 *      via Resend, FROM the tenant's AI mailbox address, with the RFC 8058
 *      one-click unsubscribe headers + footer pointing at the per-contact
 *      marketing unsubscribe URL. Reply-To is the owner's email so replies
 *      reach a human.
 *   3. A campaign with no pending recipients left completes to `sent`.
 *
 * Compliance is structural: suppressed contacts are never snapshotted, and
 * every mail carries a working one-click unsubscribe for the CUSTOMER
 * (distinct from the owner-notification unsubscribe).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { ensureTenantMailbox, tenantMailboxAddress } from "@/lib/email/tenant-mailbox";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";
import {
  CAMPAIGN_MAX_RECIPIENTS,
  insertCampaignRecipients,
  listDueScheduledCampaigns,
  listPendingRecipients,
  listSendingCampaigns,
  markRecipient,
  patchEmailCampaign,
  transitionEmailCampaign,
  type EmailCampaignRow
} from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Sends per campaign per sweep pass — the pace lever. */
export const CAMPAIGN_BATCH_PER_SWEEP = 50;

/* c8 ignore next 2 -- key presence is environment wiring */
const signingSecret = (): string =>
  process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Per-contact unsubscribe token: HMAC over business + contact ids so a
 * link can only unsubscribe the person it was minted for.
 */
export function marketingUnsubscribeToken(businessId: string, contactId: string): string {
  return createHmac("sha256", signingSecret())
    .update(`marketing-unsub:${businessId}:${contactId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Constant-time token check. */
export function verifyMarketingUnsubscribeToken(
  businessId: string,
  contactId: string,
  token: string
): boolean {
  const expected = marketingUnsubscribeToken(businessId, contactId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildMarketingUnsubscribeUrl(
  appUrl: string,
  businessId: string,
  contactId: string
): string {
  const base = appUrl.replace(/\/+$/, "");
  const token = marketingUnsubscribeToken(businessId, contactId);
  return `${base}/api/marketing/unsubscribe?bid=${encodeURIComponent(businessId)}&c=${encodeURIComponent(contactId)}&t=${token}`;
}

export type CampaignSweepResult = {
  promoted: number;
  sent: number;
  failed: number;
  completed: number;
  errors: Array<{ campaignId: string; message: string }>;
};

export type CampaignSweepDeps = {
  client?: SupabaseClient;
  sendEmail?: typeof sendOwnerEmail;
  now?: () => Date;
};

/** Snapshot the audience for a just-promoted campaign. */
async function snapshotRecipients(
  db: SupabaseClient,
  campaign: EmailCampaignRow
): Promise<number> {
  let query = db
    .from("contacts")
    .select("id, email")
    .eq("business_id", campaign.business_id)
    .eq("type", "customer")
    .not("email", "is", null)
    .is("marketing_unsubscribed_at", null)
    .limit(CAMPAIGN_MAX_RECIPIENTS);
  if (campaign.audience_tag) {
    query = query.contains("tags", [campaign.audience_tag]);
  }
  const { data, error } = await query;
  if (error) throw new Error(`snapshotRecipients: ${error.message}`);
  const contacts = ((data as Array<{ id: string; email: string | null }> | null) ?? []).filter(
    (c): c is { id: string; email: string } => !!c.email && c.email.includes("@")
  );
  // De-dupe by address: two contact rows sharing an email get ONE mail.
  const seen = new Set<string>();
  const rows = contacts
    .filter((c) => {
      const key = c.email.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({
      campaign_id: campaign.id,
      business_id: campaign.business_id,
      contact_id: c.id,
      email: c.email.trim()
    }));
  await insertCampaignRecipients(rows, db);
  return rows.length;
}

/**
 * One sweep pass. Per-campaign errors are collected and the sweep
 * continues; every step is idempotent (guarded transitions, snapshot
 * upsert, per-recipient stamps) so the next minute converges.
 */
export async function processCampaignSweep(
  deps: CampaignSweepDeps = {}
): Promise<CampaignSweepResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const sendEmail = deps.sendEmail ?? sendOwnerEmail;
  /* c8 ignore stop */
  const now = (deps.now ?? (() => new Date()))();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const apiKey = process.env.RESEND_API_KEY ?? "";

  const result: CampaignSweepResult = { promoted: 0, sent: 0, failed: 0, completed: 0, errors: [] };

  // 1) Promote due scheduled campaigns and snapshot their audiences.
  const due = await listDueScheduledCampaigns(now.toISOString(), db);
  for (const campaign of due) {
    try {
      const moved = await transitionEmailCampaign(
        campaign.business_id,
        campaign.id,
        "scheduled",
        { status: "sending", started_at: now.toISOString() },
        db
      );
      if (!moved) continue; // cancelled (or promoted) under us — their win
      const total = await snapshotRecipients(db, campaign);
      await patchEmailCampaign(campaign.business_id, campaign.id, { recipients_total: total }, db);
      result.promoted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ campaignId: campaign.id, message });
      logger.warn("email-campaign-sweep: promotion failed; continuing", {
        campaignId: campaign.id,
        error: message
      });
    }
  }

  // 2) Drain each sending campaign's pending recipients in a bounded batch.
  const sending = await listSendingCampaigns(db);
  for (const campaign of sending) {
    try {
      const batch = await listPendingRecipients(campaign.id, CAMPAIGN_BATCH_PER_SWEEP, db);
      if (batch.length === 0) {
        await transitionEmailCampaign(
          campaign.business_id,
          campaign.id,
          "sending",
          { status: "sent", completed_at: now.toISOString() },
          db
        );
        result.completed += 1;
        continue;
      }

      const business = await getBusiness(campaign.business_id, db);
      const mailbox = await ensureTenantMailbox(campaign.business_id, db);
      const fromAddress = tenantMailboxAddress(mailbox.local_part);
      const businessName = business?.name?.trim() || "New Coworker";
      const from = `${businessName.replace(/[<>"]/g, "")} <${fromAddress}>`;
      const replyTo = business?.owner_email?.trim() || undefined;

      let sentDelta = 0;
      let failedDelta = 0;
      for (const recipient of batch) {
        const unsubscribeUrl = buildMarketingUnsubscribeUrl(
          appUrl,
          campaign.business_id,
          recipient.contact_id
        );
        try {
          const bodyParagraphs = campaign.body_md.split(/\n\n+/).filter(Boolean);
          const html = buildBrandedEmailHtml({
            siteUrl: appUrl,
            documentTitle: campaign.subject,
            heading: campaign.subject,
            bodyBlocks: bodyParagraphs.map((t) => ({ kind: "text" as const, text: t })),
            unsubscribeUrl,
            recipientEmail: recipient.email
          });
          await sendEmail(apiKey, recipient.email, campaign.subject, {
            text: campaign.body_md,
            html,
            from,
            unsubscribeUrl,
            ...(replyTo ? { replyTo } : {})
          });
          await markRecipient(recipient.id, "sent", null, db);
          sentDelta += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markRecipient(recipient.id, "failed", message.slice(0, 300), db);
          failedDelta += 1;
        }
      }
      await patchEmailCampaign(
        campaign.business_id,
        campaign.id,
        {
          recipients_sent: campaign.recipients_sent + sentDelta,
          recipients_failed: campaign.recipients_failed + failedDelta
        },
        db
      );
      result.sent += sentDelta;
      result.failed += failedDelta;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ campaignId: campaign.id, message });
      logger.warn("email-campaign-sweep: campaign batch failed; continuing", {
        campaignId: campaign.id,
        error: message
      });
    }
  }

  return result;
}
