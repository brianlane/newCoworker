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
  claimRecipient,
  countRecipientsByStatus,
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

/** Directory scan bound for the audience snapshot (pre-tag-filter). */
export const CAMPAIGN_AUDIENCE_SCAN_LIMIT = 5000;

/**
 * Snapshot the audience for a due campaign. The tag filter runs in JS,
 * case-insensitively, because contact-tag normalization preserves the
 * owner's original casing — a campaign targeting "vip" must reach a
 * contact tagged "VIP".
 */
async function snapshotRecipients(
  db: SupabaseClient,
  campaign: EmailCampaignRow
): Promise<number> {
  const { data, error } = await db
    .from("contacts")
    .select("id, email, tags")
    .eq("business_id", campaign.business_id)
    .eq("type", "customer")
    .not("email", "is", null)
    .is("marketing_unsubscribed_at", null)
    .limit(CAMPAIGN_AUDIENCE_SCAN_LIMIT);
  if (error) throw new Error(`snapshotRecipients: ${error.message}`);
  const wantedTag = campaign.audience_tag.trim().toLowerCase();
  const contacts = (
    (data as Array<{ id: string; email: string | null; tags: string[] | null }> | null) ?? []
  )
    .filter((c): c is { id: string; email: string; tags: string[] | null } =>
      Boolean(c.email && c.email.includes("@"))
    )
    .filter(
      (c) =>
        !wantedTag || (c.tags ?? []).some((t) => t.trim().toLowerCase() === wantedTag)
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
    .slice(0, CAMPAIGN_MAX_RECIPIENTS)
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

  // 1) Snapshot due campaigns' audiences, THEN promote. Snapshot-first
  //    means a snapshot failure leaves the campaign `scheduled` for the
  //    next sweep to retry — never a recipient-less `sending` campaign
  //    that would complete to `sent` without delivering a thing. The
  //    snapshot is an idempotent upsert, and rows for a campaign that a
  //    racing cancel wins stay inert (only `sending` campaigns drain).
  const due = await listDueScheduledCampaigns(now.toISOString(), db);
  for (const campaign of due) {
    try {
      const total = await snapshotRecipients(db, campaign);
      const moved = await transitionEmailCampaign(
        campaign.business_id,
        campaign.id,
        "scheduled",
        { status: "sending", started_at: now.toISOString(), recipients_total: total },
        db
      );
      if (!moved) continue; // cancelled (or promoted) under us — their win
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

      for (const recipient of batch) {
        // Atomic claim (pending → sent) BEFORE the send: an overlapping
        // sweep or post-crash retry loses the claim and skips, so nobody
        // gets the campaign twice. A send failure downgrades the claim.
        const claimed = await claimRecipient(recipient.id, db);
        if (!claimed) continue;
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
          result.sent += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markRecipient(recipient.id, "failed", message.slice(0, 300), db);
          result.failed += 1;
        }
      }
      // Convergent counters derived from the recipient rows — immune to
      // concurrent-sweep read-modify-write drift.
      const [sentCount, failedCount] = await Promise.all([
        countRecipientsByStatus(campaign.id, "sent", db),
        countRecipientsByStatus(campaign.id, "failed", db)
      ]);
      await patchEmailCampaign(
        campaign.business_id,
        campaign.id,
        { recipients_sent: sentCount, recipients_failed: failedCount },
        db
      );
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
