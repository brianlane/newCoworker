/**
 * Pure domain rules for the Business Documents library
 * (src/lib/documents/core.ts): eligibility (audience + expiration), tier
 * caps, tool-reference resolution, the vault digest, and the budget-packed
 * retrieval selection behind business_knowledge_lookup.
 */
import { describe, expect, it } from "vitest";
import {
  BUSINESS_DOCS_BUCKET,
  DOCUMENTS_DIGEST_MAX_CHARS,
  DOCUMENT_TIER_LIMITS,
  buildDocumentsDigestMd,
  documentEligibleFor,
  documentLimitForTier,
  isDocumentExpired,
  renderDocumentsContext,
  resolveDocumentReference,
  scoreDocumentRelevance,
  selectDocumentsForQuestion
} from "@/lib/documents/core";
import type { BusinessDocumentRow } from "@/lib/documents/db";

const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    business_id: "22222222-2222-4222-8222-222222222222",
    title: "Price sheet",
    category: "pricing",
    audience: "both",
    storage_path: "biz/doc/price.pdf",
    mime_type: "application/pdf",
    byte_size: 1024,
    content_md: "## Prices\n- Haircut: $40",
    summary: "Current service prices.",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

describe("documentLimitForTier", () => {
  it("maps each tier and falls back to the starter cap", () => {
    expect(documentLimitForTier("starter")).toBe(DOCUMENT_TIER_LIMITS.starter);
    expect(documentLimitForTier("standard")).toBe(25);
    expect(documentLimitForTier("enterprise")).toBe(100);
    expect(documentLimitForTier("mystery")).toBe(DOCUMENT_TIER_LIMITS.starter);
    expect(documentLimitForTier(null)).toBe(DOCUMENT_TIER_LIMITS.starter);
    expect(documentLimitForTier(undefined)).toBe(DOCUMENT_TIER_LIMITS.starter);
  });
});

describe("isDocumentExpired", () => {
  it("never expires without a date", () => {
    expect(isDocumentExpired(doc({ expires_at: null }), NOW)).toBe(false);
  });

  it("treats an unparseable date as not expired (fail open, sweep-visible)", () => {
    expect(isDocumentExpired(doc({ expires_at: "not-a-date" }), NOW)).toBe(false);
  });

  it("compares against the provided clock", () => {
    expect(isDocumentExpired(doc({ expires_at: "2026-07-12T00:00:00Z" }), NOW)).toBe(false);
    expect(isDocumentExpired(doc({ expires_at: "2026-07-11T12:00:00Z" }), NOW)).toBe(true);
    expect(isDocumentExpired(doc({ expires_at: "2026-07-01T00:00:00Z" }), NOW)).toBe(true);
  });

  it("defaults the clock to now", () => {
    expect(isDocumentExpired(doc({ expires_at: "1999-01-01T00:00:00Z" }))).toBe(true);
  });
});

describe("documentEligibleFor", () => {
  it("requires ready status", () => {
    expect(documentEligibleFor(doc({ status: "processing" }), "staff", NOW)).toBe(false);
    expect(documentEligibleFor(doc({ status: "failed" }), "clients", NOW)).toBe(false);
  });

  it("excludes expired documents on every view", () => {
    const expired = doc({ expires_at: "2026-01-01T00:00:00Z" });
    expect(documentEligibleFor(expired, "staff", NOW)).toBe(false);
    expect(documentEligibleFor(expired, "clients", NOW)).toBe(false);
  });

  it("staff view sees every audience; client view never sees staff-only", () => {
    expect(documentEligibleFor(doc({ audience: "staff" }), "staff", NOW)).toBe(true);
    expect(documentEligibleFor(doc({ audience: "staff" }), "clients", NOW)).toBe(false);
    expect(documentEligibleFor(doc({ audience: "clients" }), "clients", NOW)).toBe(true);
    expect(documentEligibleFor(doc({ audience: "both" }), "clients", NOW)).toBe(true);
  });

  it("defaults the clock to now", () => {
    expect(documentEligibleFor(doc(), "clients")).toBe(true);
  });
});

describe("resolveDocumentReference", () => {
  const priceSheet = doc({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Price sheet" });
  const menu = doc({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Summer menu" });
  const menuCopy = doc({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "summer menu" });

  it("rejects an empty reference", () => {
    expect(resolveDocumentReference([priceSheet], "  ")).toEqual({
      ok: false,
      detail: "document_not_found"
    });
  });

  it("matches by id first", () => {
    const res = resolveDocumentReference([priceSheet, menu], priceSheet.id.toUpperCase());
    expect(res).toEqual({ ok: true, document: priceSheet });
  });

  it("matches a unique exact title case-insensitively", () => {
    expect(resolveDocumentReference([priceSheet, menu], "PRICE SHEET")).toEqual({
      ok: true,
      document: priceSheet
    });
  });

  it("flags duplicate exact titles as ambiguous", () => {
    expect(resolveDocumentReference([menu, menuCopy], "summer menu")).toEqual({
      ok: false,
      detail: "document_ambiguous"
    });
  });

  it("falls back to a unique substring match", () => {
    expect(resolveDocumentReference([priceSheet, menu], "price")).toEqual({
      ok: true,
      document: priceSheet
    });
  });

  it("flags multi-substring matches as ambiguous rather than guessing", () => {
    expect(resolveDocumentReference([menu, menuCopy], "menu")).toEqual({
      ok: false,
      detail: "document_ambiguous"
    });
  });

  it("reports not found when nothing matches", () => {
    expect(resolveDocumentReference([priceSheet], "warranty")).toEqual({
      ok: false,
      detail: "document_not_found"
    });
  });
});

describe("buildDocumentsDigestMd", () => {
  it("returns empty when no documents are client-eligible", () => {
    expect(buildDocumentsDigestMd([], NOW)).toBe("");
    expect(buildDocumentsDigestMd([doc({ audience: "staff" })], NOW)).toBe("");
    expect(buildDocumentsDigestMd([doc({ status: "failed" })], NOW)).toBe("");
  });

  it("lists eligible docs with title, category, and summary", () => {
    const md = buildDocumentsDigestMd([doc(), doc({ id: "x", title: "FAQ", summary: "" })], NOW);
    expect(md).toContain("# documents.md");
    expect(md).toContain("- **Price sheet** (pricing): Current service prices.");
    // Empty summary omits the trailing colon segment.
    expect(md).toContain("- **FAQ** (pricing)");
    expect(md).not.toContain("- **FAQ** (pricing):");
  });

  it("respects the char cap", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      doc({ id: `d${i}`, title: `Document number ${i}`, summary: "s".repeat(100) })
    );
    const md = buildDocumentsDigestMd(many, NOW);
    expect(md.length).toBeLessThanOrEqual(DOCUMENTS_DIGEST_MAX_CHARS);
  });
});

describe("scoreDocumentRelevance", () => {
  it("returns 0 for a question with no usable terms", () => {
    expect(scoreDocumentRelevance(doc(), "a b")).toBe(0);
  });

  it("weights title over metadata over body", () => {
    const d = doc({
      title: "Price sheet",
      category: "pricing",
      summary: "Current prices",
      content_md: "haircut costs money"
    });
    // "price" hits title (4) + meta via category "pricing"?? "price" is a
    // substring of "pricing" → meta hit (2). Body has no "price".
    expect(scoreDocumentRelevance(d, "price")).toBe(6);
    expect(scoreDocumentRelevance(d, "haircut")).toBe(1);
    expect(scoreDocumentRelevance(d, "warranty")).toBe(0);
  });
});

describe("selectDocumentsForQuestion", () => {
  it("packs relevant docs into the budget and lists the rest", () => {
    const relevant = doc({ id: "r", title: "Price sheet", content_md: "price ".repeat(10) });
    const irrelevant = doc({
      id: "i",
      title: "Holiday hours",
      category: "hours",
      summary: "Seasonal schedule.",
      content_md: "closed dec 25"
    });
    const selection = selectDocumentsForQuestion(
      [relevant, irrelevant],
      "what is the price?",
      "clients",
      5_000,
      NOW
    );
    expect(selection.included.map((d) => d.id)).toEqual(["r"]);
    expect(selection.listed.map((d) => d.id)).toEqual(["i"]);
  });

  it("lists a relevant doc that does not fit the budget", () => {
    const big = doc({ id: "big", title: "Price sheet", content_md: "price ".repeat(500) });
    const selection = selectDocumentsForQuestion([big], "price?", "clients", 100, NOW);
    expect(selection.included).toEqual([]);
    expect(selection.listed.map((d) => d.id)).toEqual(["big"]);
  });

  it("excludes ineligible docs entirely and clamps a negative budget", () => {
    const staffOnly = doc({ id: "s", audience: "staff" });
    const selection = selectDocumentsForQuestion([staffOnly, doc()], "price?", "clients", -50, NOW);
    expect(selection.included).toEqual([]);
    expect(selection.listed).toHaveLength(1);
  });

  it("defaults the clock to now", () => {
    const selection = selectDocumentsForQuestion([doc()], "price?", "staff", 5_000);
    expect(selection.included).toHaveLength(1);
  });
});

describe("renderDocumentsContext", () => {
  it("renders nothing for an empty selection", () => {
    expect(renderDocumentsContext({ included: [], listed: [] })).toBe("");
  });

  it("renders full contents for included docs and mentions for listed docs", () => {
    const included = doc({ title: "Price sheet", content_md: "- Haircut $40" });
    const listedWithSummary = doc({ id: "l1", title: "FAQ", summary: "Common questions." });
    const listedNoSummary = doc({ id: "l2", title: "Menu", summary: "  " });
    const out = renderDocumentsContext({
      included: [included],
      listed: [listedWithSummary, listedNoSummary]
    });
    expect(out).toContain("# document: Price sheet\n- Haircut $40");
    expect(out).toContain("# other documents on file (contents not shown)");
    expect(out).toContain("- FAQ: Common questions.");
    expect(out).toContain("- Menu");
  });
});

describe("constants", () => {
  it("exposes the storage bucket name", () => {
    expect(BUSINESS_DOCS_BUCKET).toBe("business-docs");
  });
});
