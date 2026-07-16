/**
 * Business Documents — pure domain rules shared by every surface.
 *
 * Everything here is side-effect free: eligibility (audience + expiration),
 * per-tier caps, title matching for tool calls, the vault digest, and the
 * budget-packed retrieval selection used by business_knowledge_lookup. The
 * IO layers (db.ts, ingest.ts, share.ts, tool handlers, routes) all defer to
 * these rules so the audience/expiration guarantees hold identically on
 * voice, SMS, webchat, dashboard, and AiFlow paths.
 */

import type { BusinessDocumentRow } from "./db";

/** Which knowledge audience a surface reads as. Dashboard = staff. */
export type DocumentAudienceView = "clients" | "staff";

/** Private storage bucket holding the original uploads. */
export const BUSINESS_DOCS_BUCKET = "business-docs";

/** Hard cap for agent-facing extracted markdown, matching website_md scale. */
export const DOCUMENT_CONTENT_MD_MAX_CHARS = 8_000;
/** Hard cap for the 1–2 sentence retrieval summary. */
export const DOCUMENT_SUMMARY_MAX_CHARS = 300;
/** Default lifetime of a share link. */
export const DOCUMENT_SHARE_DEFAULT_TTL_DAYS = 30;
/** Documents expiring within this window trigger the owner reminder. */
export const DOCUMENT_EXPIRING_SOON_DAYS = 7;
/** Documents with a renewal date within this window trigger the renewal reminder. */
export const DOCUMENT_RENEWAL_SOON_DAYS = 30;
/**
 * Flat cap on contact-linked record documents (policies, contracts,
 * memberships). Separate from the per-tier knowledge-library cap because a
 * book of business legitimately holds hundreds of records: CSV-imported
 * records carry no file and skip Gemini ingestion entirely, records default
 * to the staff audience so they stay out of the client vault digest, and
 * owner-attended file uploads (which DO extract, linked or not) are
 * naturally self-limiting. This limit is abuse-safety only.
 */
export const CONTACT_DOCUMENT_RECORDS_LIMIT = 2000;

/** Per-tier document-count caps (uploads are refused past the cap). */
export const DOCUMENT_TIER_LIMITS: Record<string, number> = {
  starter: 5,
  standard: 25,
  enterprise: 100
};

export function documentLimitForTier(tier: string | null | undefined): number {
  return DOCUMENT_TIER_LIMITS[tier ?? ""] ?? DOCUMENT_TIER_LIMITS.starter;
}

export function isDocumentExpired(
  doc: Pick<BusinessDocumentRow, "expires_at">,
  now: Date = new Date()
): boolean {
  if (!doc.expires_at) return false;
  const ms = Date.parse(doc.expires_at);
  if (!Number.isFinite(ms)) return false;
  return ms <= now.getTime();
}

/**
 * Whether a document's renewal date falls within `days` from `now` —
 * including already-past dates, so an overdue renewal still reminds. Used
 * by the daily sweep and the dashboard renewal badges.
 */
export function isRenewalDueWithin(
  doc: Pick<BusinessDocumentRow, "renewal_date">,
  now: Date = new Date(),
  days: number = DOCUMENT_RENEWAL_SOON_DAYS
): boolean {
  if (!doc.renewal_date) return false;
  const ms = Date.parse(doc.renewal_date);
  if (!Number.isFinite(ms)) return false;
  return ms <= now.getTime() + days * 24 * 60 * 60 * 1000;
}

/**
 * Parse an owner-supplied expiration input into the stored ISO instant.
 *
 * A DATE-ONLY value ("2026-08-01" — what the dashboard date input and chat
 * phrasing produce) means "usable through that day", so it maps to the END
 * of that calendar day (23:59:59.999 UTC) — never the preceding midnight,
 * which would expire the document the prior evening in US timezones. A full
 * datetime is taken literally. Returns null when unparseable.
 */
export function parseExpirationInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T23:59:59.999Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The single eligibility rule every reader applies: a document is usable by
 * a surface only when it is ready, not expired, and its audience covers the
 * surface. Client channels (voice/SMS/webchat/flows) see 'clients'/'both';
 * the staff view (owner dashboard) sees everything.
 */
export function documentEligibleFor(
  doc: Pick<BusinessDocumentRow, "status" | "audience" | "expires_at">,
  view: DocumentAudienceView,
  now: Date = new Date()
): boolean {
  if (doc.status !== "ready") return false;
  if (isDocumentExpired(doc, now)) return false;
  if (view === "staff") return true;
  return doc.audience === "clients" || doc.audience === "both";
}

/**
 * Resolve a tool-supplied document reference (uuid or human title) against
 * the business's documents. Title matching is case-insensitive: exact title
 * first, then unique substring; an ambiguous substring match fails rather
 * than guessing.
 */
export function resolveDocumentReference(
  docs: BusinessDocumentRow[],
  ref: string
):
  | { ok: true; document: BusinessDocumentRow }
  | { ok: false; detail: "document_not_found" | "document_ambiguous" } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { ok: false, detail: "document_not_found" };
  const byId = docs.find((d) => d.id.toLowerCase() === needle);
  if (byId) return { ok: true, document: byId };
  const exact = docs.filter((d) => d.title.trim().toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, document: exact[0] };
  if (exact.length > 1) return { ok: false, detail: "document_ambiguous" };
  const partial = docs.filter((d) => d.title.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, document: partial[0] };
  if (partial.length > 1) return { ok: false, detail: "document_ambiguous" };
  return { ok: false, detail: "document_not_found" };
}

/** Cap for the client-audience digest synced into the VPS vault. */
export const DOCUMENTS_DIGEST_MAX_CHARS = 4_000;

/**
 * Compact awareness digest of client-eligible documents for the on-VPS
 * vault (documents.md). Titles + summaries only — full content stays behind
 * the business_knowledge_lookup / document_share tools so KVM2 prefill
 * stays bounded. Returns "" when no documents qualify, so vault composition
 * can skip the section entirely.
 */
export function buildDocumentsDigestMd(
  docs: BusinessDocumentRow[],
  now: Date = new Date(),
  maxChars: number = DOCUMENTS_DIGEST_MAX_CHARS
): string {
  const eligible = docs.filter((d) => documentEligibleFor(d, "clients", now));
  if (eligible.length === 0) return "";
  const lines: string[] = [
    "# documents.md",
    "Business documents on file (share on request via the document tools; answer detail questions via business_knowledge_lookup):",
    ""
  ];
  for (const doc of eligible) {
    const summary = doc.summary.trim();
    lines.push(`- **${doc.title.trim()}** (${doc.category})${summary ? `: ${summary}` : ""}`);
  }
  return lines.join("\n").slice(0, maxChars);
}

export type DocumentSelection = {
  /** Docs whose full content_md fits the budget, most relevant first. */
  included: BusinessDocumentRow[];
  /** Remaining eligible docs, surfaced as title+summary mentions only. */
  listed: BusinessDocumentRow[];
};

/** Tokenize into lowercase word stems for the overlap score. */
function questionTerms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Relevance score: term overlap between the question and the document's
 * title / category / summary / content. Deterministic and cheap — the
 * knowledge lookup runs under a 3s voice deadline, so selection cannot
 * afford a second model round-trip.
 */
export function scoreDocumentRelevance(
  doc: Pick<BusinessDocumentRow, "title" | "category" | "summary" | "content_md">,
  question: string
): number {
  const terms = questionTerms(question);
  if (terms.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const meta = `${doc.category}\n${doc.summary}`.toLowerCase();
  const body = doc.content_md.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (meta.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
  }
  return score;
}

/**
 * Stage-1 retrieval for business_knowledge_lookup: rank eligible documents
 * by term overlap with the question, then pack full contents into the
 * remaining prompt budget in rank order. Anything that does not fit (or
 * scored zero) is returned as `listed` so the answer model still knows the
 * document exists.
 */
export function selectDocumentsForQuestion(
  docs: BusinessDocumentRow[],
  question: string,
  view: DocumentAudienceView,
  charBudget: number,
  now: Date = new Date()
): DocumentSelection {
  const eligible = docs.filter((d) => documentEligibleFor(d, view, now));
  const ranked = eligible
    .map((doc) => ({ doc, score: scoreDocumentRelevance(doc, question) }))
    .sort((a, b) => b.score - a.score);

  const included: BusinessDocumentRow[] = [];
  const listed: BusinessDocumentRow[] = [];
  let remaining = Math.max(0, charBudget);
  for (const { doc, score } of ranked) {
    const cost = doc.content_md.length + doc.title.length + 32;
    if (score > 0 && cost <= remaining) {
      included.push(doc);
      remaining -= cost;
    } else {
      listed.push(doc);
    }
  }
  return { included, listed };
}

/**
 * Render the selected documents into the knowledge-lookup context block.
 * Returns "" when the business has no eligible documents.
 */
export function renderDocumentsContext(selection: DocumentSelection): string {
  const parts: string[] = [];
  for (const doc of selection.included) {
    parts.push(`# document: ${doc.title.trim()}\n${doc.content_md.trim()}`);
  }
  if (selection.listed.length > 0) {
    const mentions = selection.listed
      .map((d) => `- ${d.title.trim()}${d.summary.trim() ? `: ${d.summary.trim()}` : ""}`)
      .join("\n");
    parts.push(`# other documents on file (contents not shown)\n${mentions}`);
  }
  return parts.join("\n\n");
}
