/**
 * Business Documents — tokenized share links.
 *
 * A share is a bearer capability: the URL carries a 256-bit random token,
 * the DB stores only its sha256 (a dump alone cannot reconstruct live
 * links). Every mint re-checks the document's eligibility for the minting
 * surface, and every download re-checks share expiry/revocation AND the
 * document's own expiration — so an expired price sheet can never be
 * fetched even through a link minted while it was fresh.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getDocumentShareByTokenSha,
  getBusinessDocument,
  insertDocumentShare,
  type BusinessDocumentRow,
  type BusinessDocumentShareRow
} from "./db";
import {
  DOCUMENT_SHARE_DEFAULT_TTL_DAYS,
  documentEligibleFor,
  isDocumentExpired,
  type DocumentAudienceView
} from "./core";

export type DocumentShareChannel = "dashboard" | "sms" | "voice" | "webchat" | "flow" | "email";

/** Which audience view a share-minting surface reads as. */
export function audienceViewForShareChannel(channel: DocumentShareChannel): DocumentAudienceView {
  return channel === "dashboard" ? "staff" : "clients";
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function buildShareUrl(token: string, appUrl?: string): string {
  const base = (appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  return `${base}/api/public/docs/${token}`;
}

export type MintShareInput = {
  businessId: string;
  document: BusinessDocumentRow;
  channel: DocumentShareChannel;
  /** Recipient identifier (phone / email / free label) for the audit row. */
  sharedWith: string;
  ttlDays?: number;
  now?: Date;
};

export type MintShareResult =
  | { ok: true; shareId: string; url: string; expiresAt: string }
  | { ok: false; detail: "document_not_ready" | "document_expired" | "document_not_shareable" };

/**
 * Mint a share link for a document, enforcing the audience gate for the
 * minting surface: client channels can only share client-audience docs.
 */
export async function mintDocumentShare(input: MintShareInput): Promise<MintShareResult> {
  const now = input.now ?? new Date();
  const doc = input.document;
  if (doc.status !== "ready") return { ok: false, detail: "document_not_ready" };
  if (isDocumentExpired(doc, now)) return { ok: false, detail: "document_expired" };
  if (!documentEligibleFor(doc, audienceViewForShareChannel(input.channel), now)) {
    return { ok: false, detail: "document_not_shareable" };
  }

  const token = randomBytes(32).toString("base64url");
  const ttlDays = input.ttlDays ?? DOCUMENT_SHARE_DEFAULT_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const row = await insertDocumentShare({
    id: randomUUID(),
    business_id: input.businessId,
    document_id: doc.id,
    token_sha256: hashShareToken(token),
    shared_with: input.sharedWith.slice(0, 200),
    channel: input.channel,
    expires_at: expiresAt
  });
  return { ok: true, shareId: row.id, url: buildShareUrl(token), expiresAt };
}

export type ResolveShareResult =
  | { ok: true; share: BusinessDocumentShareRow; document: BusinessDocumentRow }
  | {
      ok: false;
      detail: "not_found" | "revoked" | "expired" | "document_expired" | "document_unavailable";
    };

/**
 * Validate a presented share token for the public download route. Fails
 * closed on every state that should not serve the file.
 */
export async function resolveDocumentShareByToken(
  token: string,
  now: Date = new Date()
): Promise<ResolveShareResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, detail: "not_found" };
  const share = await getDocumentShareByTokenSha(hashShareToken(trimmed));
  if (!share) return { ok: false, detail: "not_found" };
  if (share.revoked_at) return { ok: false, detail: "revoked" };
  if (Date.parse(share.expires_at) <= now.getTime()) return { ok: false, detail: "expired" };
  const document = await getBusinessDocument(share.business_id, share.document_id);
  if (!document || document.status !== "ready") {
    return { ok: false, detail: "document_unavailable" };
  }
  if (isDocumentExpired(document, now)) return { ok: false, detail: "document_expired" };
  // Audience re-check at download time: a link minted from a customer-facing
  // surface (sms/voice/webchat/flow) dies the moment the owner flips the
  // document to internal-only. Dashboard-minted links survive — the owner
  // explicitly chose to send that document to that recipient.
  if (document.audience === "staff" && share.channel !== "dashboard") {
    return { ok: false, detail: "document_unavailable" };
  }
  return { ok: true, share, document };
}
