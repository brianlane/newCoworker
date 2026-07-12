/**
 * Business Documents — e-signatures (BizBlasts client-document signing port).
 *
 * The owner sends a document for a DocuSign-style legal sign-off: the
 * recipient opens a tokenized link, reads the document, and signs by typing
 * their legal name with an explicit consent checkbox (ESIGN/UETA-adequate;
 * a drawn-signature pad is a later enhancement). The signed row carries the
 * audit trail — signer name, instant, IP, user agent, and a sha256
 * fingerprint of the exact content_md on screen — so it remains standalone
 * evidence even if the document is edited afterwards.
 *
 * Token posture mirrors share.ts: 256-bit bearer capability in the URL,
 * sha256-only at rest, fail-closed resolution. Unlike customer shares, the
 * client-audience rule does NOT gate signing (contracts are often
 * internal-audience drafts the owner explicitly sends — the same exemption
 * dashboard-minted share links get); minting is dashboard/owner-side only,
 * which the route/tool layers enforce.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";
import {
  completeSignatureRequest,
  getBusinessDocument,
  getDocumentSignatureRequestByTokenSha,
  insertDocumentSignatureRequest,
  markSignatureRequestViewed,
  type BusinessDocumentRow,
  type DocumentSignatureRequestRow
} from "./db";
import { isDocumentExpired } from "./core";
import { hashShareToken } from "./share";

/** Signature links live this long unless the owner voids them sooner. */
export const SIGNATURE_REQUEST_DEFAULT_TTL_DAYS = 30;

export function buildSignUrl(token: string, appUrl?: string): string {
  const base = (appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  return `${base}/sign/${token}`;
}

/** Fingerprint of the exact markdown the signer saw. */
export function fingerprintDocumentContent(contentMd: string): string {
  return createHash("sha256").update(contentMd, "utf8").digest("hex");
}

export type MintSignatureRequestInput = {
  businessId: string;
  document: BusinessDocumentRow;
  /** Who the request is addressed to (shown on the signing page). */
  signerName: string;
  signerEmail?: string;
  signerPhone?: string;
  /** Optional note from the owner shown above the document. */
  message?: string;
  ttlDays?: number;
  now?: Date;
};

export type MintSignatureRequestResult =
  | { ok: true; requestId: string; url: string; expiresAt: string }
  | { ok: false; detail: "document_not_ready" | "document_expired" | "document_empty" };

/**
 * Mint a signature request for a document. The document must be ready,
 * unexpired, and have extracted content (the content IS what gets signed).
 */
export async function mintSignatureRequest(
  input: MintSignatureRequestInput
): Promise<MintSignatureRequestResult> {
  const now = input.now ?? new Date();
  const doc = input.document;
  if (doc.status !== "ready") return { ok: false, detail: "document_not_ready" };
  if (isDocumentExpired(doc, now)) return { ok: false, detail: "document_expired" };
  if (!doc.content_md.trim()) return { ok: false, detail: "document_empty" };

  const token = randomBytes(32).toString("base64url");
  const ttlDays = input.ttlDays ?? SIGNATURE_REQUEST_DEFAULT_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const row = await insertDocumentSignatureRequest({
    id: randomUUID(),
    business_id: input.businessId,
    document_id: doc.id,
    token_sha256: hashShareToken(token),
    signer_name: input.signerName.slice(0, 200),
    signer_email: (input.signerEmail ?? "").slice(0, 320),
    signer_phone: (input.signerPhone ?? "").slice(0, 32),
    message: (input.message ?? "").slice(0, 1000),
    expires_at: expiresAt
  });
  return { ok: true, requestId: row.id, url: buildSignUrl(token), expiresAt };
}

export type ResolveSignatureRequestResult =
  | { ok: true; request: DocumentSignatureRequestRow; document: BusinessDocumentRow }
  | {
      ok: false;
      detail: "not_found" | "void" | "expired" | "document_expired" | "document_unavailable";
    };

/**
 * Validate a presented signing token. Fails closed on every non-servable
 * state. A SIGNED request still resolves — the page renders the signature
 * certificate instead of the form.
 */
export async function resolveSignatureRequestByToken(
  token: string,
  now: Date = new Date()
): Promise<ResolveSignatureRequestResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, detail: "not_found" };
  const request = await getDocumentSignatureRequestByTokenSha(hashShareToken(trimmed));
  if (!request) return { ok: false, detail: "not_found" };
  if (request.status === "void") return { ok: false, detail: "void" };
  // A completed signature outlives the link's own TTL — it is evidence the
  // signer may revisit; only UNSIGNED requests expire.
  if (request.status !== "signed" && Date.parse(request.expires_at) <= now.getTime()) {
    return { ok: false, detail: "expired" };
  }
  const document = await getBusinessDocument(request.business_id, request.document_id);
  if (!document || document.status !== "ready") {
    return { ok: false, detail: "document_unavailable" };
  }
  // An expired document can no longer be SIGNED, but an already-signed
  // certificate stays viewable (what was signed, was signed).
  if (request.status !== "signed" && isDocumentExpired(document, now)) {
    return { ok: false, detail: "document_expired" };
  }
  return { ok: true, request, document };
}

/**
 * First-open stamp (`sent → viewed`), the analogue of BizBlasts flipping
 * `sent → pending_signature` on show. Best-effort: a failed stamp must
 * never block rendering the document.
 */
export async function markSignatureRequestOpened(
  request: DocumentSignatureRequestRow
): Promise<void> {
  if (request.status !== "sent") return;
  try {
    await markSignatureRequestViewed(request.id);
  } catch (err) {
    logger.warn("documents/signing: viewed stamp failed", {
      requestId: request.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export type SignDocumentInput = {
  token: string;
  /** The typed legal name — the signature itself. */
  signatureName: string;
  /** The explicit e-sign consent checkbox state. */
  consent: boolean;
  signerIp?: string;
  signerUserAgent?: string;
  now?: Date;
};

export type SignDocumentResult =
  | { ok: true; signedAt: string; documentTitle: string }
  | {
      ok: false;
      detail:
        | "not_found"
        | "void"
        | "expired"
        | "document_expired"
        | "document_unavailable"
        | "already_signed"
        | "consent_required"
        | "signature_name_required";
    };

/**
 * Execute the signature. The completing write is conditional on the request
 * still being signable, so a double-submit (or a racing void) loses instead
 * of double-signing — the port of BizBlasts' `lock!` + re-check. On success
 * the owner is notified and an audit log row is written.
 */
export async function signDocumentRequest(input: SignDocumentInput): Promise<SignDocumentResult> {
  const now = input.now ?? new Date();
  const signatureName = input.signatureName.trim();
  if (!signatureName) return { ok: false, detail: "signature_name_required" };
  if (!input.consent) return { ok: false, detail: "consent_required" };

  const resolved = await resolveSignatureRequestByToken(input.token, now);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  if (resolved.request.status === "signed") return { ok: false, detail: "already_signed" };

  const signedAt = now.toISOString();
  const updated = await completeSignatureRequest(resolved.request.id, {
    signature_name: signatureName.slice(0, 200),
    signed_at: signedAt,
    signer_ip: (input.signerIp ?? "").slice(0, 64) || null,
    signer_user_agent: (input.signerUserAgent ?? "").slice(0, 400) || null,
    content_sha256: fingerprintDocumentContent(resolved.document.content_md)
  });
  if (updated === 0) {
    // Zero rows means the request stopped being signable between resolve
    // and write. Distinguish WHY: a racing void must not be reported to the
    // signer as "already signed".
    const current = await getDocumentSignatureRequestByTokenSha(
      hashShareToken(input.token.trim())
    );
    return { ok: false, detail: current?.status === "void" ? "void" : "already_signed" };
  }

  // Owner notification + audit log are best-effort: the signature itself is
  // already durable, and the dashboard list shows it regardless.
  try {
    await insertCoworkerLog({
      id: randomUUID(),
      business_id: resolved.request.business_id,
      task_type: "data_flow",
      status: "success",
      log_payload: {
        source: "document_signature",
        event: "document_signed",
        documentId: resolved.document.id,
        title: resolved.document.title,
        requestId: resolved.request.id,
        signatureName: signatureName.slice(0, 200),
        signedAt
      }
    });
    await dispatchUrgentNotification({
      businessId: resolved.request.business_id,
      summary: `"${resolved.document.title}" was signed by ${signatureName}`,
      kind: "document_signed",
      payload: {
        documentId: resolved.document.id,
        requestId: resolved.request.id,
        signedAt
      },
      emailSubject: `Signed: "${resolved.document.title}"`,
      emailBody:
        `${signatureName} signed "${resolved.document.title}" on ${signedAt}. ` +
        `The signature record (name, time, IP, and a fingerprint of the exact ` +
        `content signed) is stored under Dashboard → Memory → Documents.`,
      smsBody: `[Coworker] ${signatureName} signed "${resolved.document.title}".`.slice(0, 640)
    });
  } catch (err) {
    logger.warn("documents/signing: post-sign notification failed", {
      requestId: resolved.request.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return { ok: true, signedAt, documentTitle: resolved.document.title };
}
