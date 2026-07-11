/**
 * Business Documents — agent tool cores.
 *
 * Channel-agnostic handlers behind the document tools, shared by every
 * surface adapter (Rowboat tool webhook for sms/dashboard/webchat, the
 * voice-bridge adapter under /api/voice/tools/*):
 *
 *   - document_list            (dashboard-only) inventory for the owner.
 *   - document_share           mint a tokenized link + deliver it. Client
 *                              channels can only share client-audience docs
 *                              (enforced in mintDocumentShare); webchat gets
 *                              the link INLINE — no SMS/email side effects
 *                              on the anonymous surface.
 *   - document_update          (dashboard-only) free-form edit applied to
 *                              content_md via Gemini; original file immutable.
 *   - document_set_expiration  (dashboard-only) set/extend/clear expires_at.
 *
 * Surface gating is layered: the tool registries / TOOL_GATES decide which
 * names exist per surface, and these cores re-assert the dashboard-only
 * rules so a miswired adapter still fails closed.
 */

import { randomUUID } from "node:crypto";
import { getBusiness } from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";
import {
  listBusinessDocuments,
  patchBusinessDocument,
  revokeDocumentShare,
  type BusinessDocumentRow
} from "./db";
import { isDocumentExpired, resolveDocumentReference } from "./core";
import { mintDocumentShare, type DocumentShareChannel } from "./share";
import { rewriteDocumentContent } from "./ingest";

export type DocumentToolSurface = "dashboard" | "sms" | "voice" | "webchat";

/** coworker_logs.task_type value for each tool surface. */
const LOG_TASK_TYPE: Record<DocumentToolSurface, "data_flow" | "sms" | "call" | "webchat"> = {
  dashboard: "data_flow",
  sms: "sms",
  voice: "call",
  webchat: "webchat"
};

/** email_log.source value for each tool surface that can send email. */
const EMAIL_LOG_SOURCE: Record<DocumentToolSurface, "dashboard_chat" | "sms_assistant" | "voice_assistant"> = {
  dashboard: "dashboard_chat",
  sms: "sms_assistant",
  voice: "voice_assistant",
  // Webchat never sends (inline-only), so this value is never written.
  webchat: "dashboard_chat"
};

export type DocumentToolResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
  message?: string;
};

function docSummaryView(doc: BusinessDocumentRow) {
  return {
    id: doc.id,
    title: doc.title,
    category: doc.category,
    audience: doc.audience,
    status: doc.status,
    expiresAt: doc.expires_at,
    summary: doc.summary
  };
}

/** Dashboard-only inventory so the owner's coworker can reference docs by id. */
export async function listDocumentsTool(businessId: string): Promise<DocumentToolResult> {
  const docs = await listBusinessDocuments(businessId);
  return { ok: true, data: { documents: docs.map(docSummaryView) } };
}

export type ShareDocumentArgs = {
  /** Document id or (partial) title. */
  documentRef: string;
  /** E.164 recipient for SMS delivery. */
  phone?: string;
  /** Email recipient for email delivery. */
  email?: string;
  /** Optional custom message; the link is appended when not already present. */
  message?: string;
};

/**
 * Mint a share link and deliver it. Delivery matrix:
 *   phone → metered SMS from the business number (opt-out checked)
 *   email → owner's connected mailbox
 *   neither → link returned inline (dashboard presents it; webchat is
 *             ALWAYS inline regardless of args — no sends from the
 *             anonymous surface).
 */
export async function shareDocumentTool(
  businessId: string,
  args: ShareDocumentArgs,
  surface: DocumentToolSurface
): Promise<DocumentToolResult> {
  const docs = await listBusinessDocuments(businessId);
  const resolved = resolveDocumentReference(docs, args.documentRef);
  if (!resolved.ok) {
    return {
      ok: false,
      detail: resolved.detail,
      message:
        resolved.detail === "document_ambiguous"
          ? "More than one document matches that name — ask which one they mean."
          : "No document with that name is on file. Never invent a link."
    };
  }

  const channel: DocumentShareChannel = surface;
  const sharedWith = args.phone ?? args.email ?? (surface === "webchat" ? "webchat visitor" : "owner");

  // Recipient validation happens BEFORE the link exists: an opted-out (or
  // uncheckable) number must not leave an orphaned live capability behind.
  if (surface !== "webchat" && args.phone) {
    const optOut = await checkSmsOptOut(businessId, args.phone);
    if (!optOut.ok) {
      logger.error("documents/tool: opt-out check failed; refusing (fail closed)", {
        businessId,
        error: optOut.error
      });
      return { ok: false, detail: "opt_out_check_failed" };
    }
    if (optOut.optedOut) return { ok: false, detail: "recipient_opted_out" };
  }

  const minted = await mintDocumentShare({
    businessId,
    document: resolved.document,
    channel,
    sharedWith
  });
  if (!minted.ok) {
    return {
      ok: false,
      detail: minted.detail,
      message:
        minted.detail === "document_expired"
          ? "That document has expired — tell them the team will follow up with a current copy."
          : minted.detail === "document_not_shareable"
            ? "That document is internal-only and cannot be shared with customers."
            : "That document is not ready to share yet."
    };
  }

  // Failed delivery must not leave a live link nobody received. Best-effort:
  // a revoke failure is logged, and the share still dies at its TTL.
  const revokeUndelivered = async (): Promise<void> => {
    try {
      await revokeDocumentShare(businessId, minted.shareId);
    } catch (err) {
      logger.warn("documents/tool: undelivered-share revoke failed", {
        businessId,
        shareId: minted.shareId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const title = resolved.document.title;
  const logPayload: Record<string, unknown> = {
    source: `${surface}_tool_document_share`,
    documentId: resolved.document.id,
    title,
    shareId: minted.shareId,
    sharedWith,
    channel
  };

  let delivered: "sms" | "email" | "inline" = "inline";
  if (surface !== "webchat" && args.phone) {
    const business = await getBusiness(businessId);
    const base = (args.message ?? "").trim() || `Here is "${title}"${business?.name ? ` from ${business.name}` : ""}`;
    const body = base.includes(minted.url) ? base : `${base}: ${minted.url}`;
    const config = await getTelnyxMessagingForBusiness(businessId, undefined, { resolveRcs: true });
    try {
      await sendTelnyxSms(config, args.phone, body, { meterBusinessId: businessId });
      delivered = "sms";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
      logger.warn("documents/tool: share sms send failed", { businessId, error: message });
      await revokeUndelivered();
      return { ok: false, detail: isQuota ? "sms_quota_blocked" : "sms_send_failed" };
    }
  } else if (surface !== "webchat" && args.email) {
    const business = await getBusiness(businessId);
    const bodyText = [
      (args.message ?? "").trim() || `Here is "${title}"${business?.name ? ` from ${business.name}` : ""}.`,
      "",
      minted.url,
      "",
      `This link expires ${minted.expiresAt.slice(0, 10)}.`
    ].join("\n");
    const sent = await sendFromOwnerMailbox(businessId, {
      toEmail: args.email,
      subject: `Document: ${title}`,
      bodyText
    });
    if (!sent.ok) {
      await revokeUndelivered();
      return { ok: false, detail: sent.detail };
    }
    await recordOutboundAssistantEmail({
      businessId,
      toEmail: args.email,
      subject: `Document: ${title}`,
      bodyText,
      source: EMAIL_LOG_SOURCE[surface],
      providerMessageId: sent.messageId
    });
    delivered = "email";
  }

  await insertCoworkerLog({
    id: randomUUID(),
    business_id: businessId,
    task_type: LOG_TASK_TYPE[surface],
    status: "success",
    log_payload: { ...logPayload, event: "document_shared", delivered, url: minted.url }
  });

  return {
    ok: true,
    data: {
      title,
      url: minted.url,
      expiresAt: minted.expiresAt,
      delivered
    },
    message:
      delivered === "inline"
        ? "Share this link with them directly; it expires automatically."
        : `The document link was ${delivered === "sms" ? "texted" : "emailed"} to them.`
  };
}

export type UpdateDocumentArgs = {
  documentRef: string;
  /** Plain-language edit, e.g. "haircuts are now $40". */
  instruction: string;
};

/**
 * Dashboard-only: apply an owner edit to a document's agent-facing markdown
 * and re-sync the vault digest so voice/SMS grounding updates immediately.
 */
export async function updateDocumentTool(
  businessId: string,
  args: UpdateDocumentArgs,
  surface: DocumentToolSurface
): Promise<DocumentToolResult> {
  if (surface !== "dashboard") {
    return { ok: false, detail: "surface_not_allowed" };
  }
  const docs = await listBusinessDocuments(businessId);
  const resolved = resolveDocumentReference(docs, args.documentRef);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  const doc = resolved.document;
  if (!doc.content_md.trim()) {
    return { ok: false, detail: "document_empty" };
  }
  const rewritten = await rewriteDocumentContent({
    businessId,
    title: doc.title,
    currentContentMd: doc.content_md,
    instruction: args.instruction
  });
  if (!rewritten.ok) return { ok: false, detail: rewritten.error };
  if (!rewritten.contentMd.trim()) return { ok: false, detail: "rewrite_empty" };

  await patchBusinessDocument(businessId, doc.id, {
    content_md: rewritten.contentMd,
    summary: rewritten.summary || doc.summary
  });
  await insertCoworkerLog({
    id: randomUUID(),
    business_id: businessId,
    task_type: "data_flow",
    status: "success",
    log_payload: {
      source: "dashboard_tool_document_update",
      event: "document_updated",
      documentId: doc.id,
      title: doc.title,
      instruction: args.instruction.slice(0, 500)
    }
  });
  // Fire-and-forget: the Supabase write is canonical; a slow VPS must not
  // block the tool response. syncVaultToVpsAndLog never throws.
  void syncVaultToVpsAndLog(businessId);
  return {
    ok: true,
    data: { documentId: doc.id, title: doc.title, summary: rewritten.summary },
    message: "Document updated. Voice and texting coworkers pick the change up within a minute."
  };
}

export type SetDocumentExpirationArgs = {
  documentRef: string;
  /** ISO date/datetime, or null/"" to clear (never expires). */
  expiresAt: string | null;
};

/** Dashboard-only: set / extend / clear a document's expiration date. */
export async function setDocumentExpirationTool(
  businessId: string,
  args: SetDocumentExpirationArgs,
  surface: DocumentToolSurface
): Promise<DocumentToolResult> {
  if (surface !== "dashboard") {
    return { ok: false, detail: "surface_not_allowed" };
  }
  const docs = await listBusinessDocuments(businessId);
  const resolved = resolveDocumentReference(docs, args.documentRef);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  const doc = resolved.document;

  let expiresIso: string | null = null;
  if (args.expiresAt !== null && args.expiresAt.trim() !== "") {
    const ms = Date.parse(args.expiresAt);
    if (!Number.isFinite(ms)) return { ok: false, detail: "invalid_date" };
    expiresIso = new Date(ms).toISOString();
  }

  await patchBusinessDocument(businessId, doc.id, {
    expires_at: expiresIso,
    // Changing the date re-arms the sweep's one-reminder-per-state flags.
    expiring_soon_notified_at: null,
    expired_notified_at: null
  });
  await insertCoworkerLog({
    id: randomUUID(),
    business_id: businessId,
    task_type: "data_flow",
    status: "success",
    log_payload: {
      source: "dashboard_tool_document_set_expiration",
      event: "document_expiration_set",
      documentId: doc.id,
      title: doc.title,
      expiresAt: expiresIso
    }
  });
  void syncVaultToVpsAndLog(businessId);

  const wasExpired = isDocumentExpired(doc);
  return {
    ok: true,
    data: { documentId: doc.id, title: doc.title, expiresAt: expiresIso },
    message: expiresIso
      ? `"${doc.title}" now expires ${expiresIso.slice(0, 10)}.${wasExpired ? " It is active again." : ""}`
      : `"${doc.title}" no longer expires.`
  };
}
