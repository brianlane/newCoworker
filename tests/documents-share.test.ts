/**
 * Tokenized share links (src/lib/documents/share.ts): mint-time audience /
 * expiration gating and the fail-closed download-time resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/db", () => ({
  insertDocumentShare: vi.fn(),
  getDocumentShareByTokenSha: vi.fn(),
  getBusinessDocument: vi.fn()
}));

import {
  audienceViewForShareChannel,
  buildShareUrl,
  hashShareToken,
  mintDocumentShare,
  resolveDocumentShareByToken
} from "@/lib/documents/share";
import {
  getBusinessDocument,
  getDocumentShareByTokenSha,
  insertDocumentShare,
  type BusinessDocumentRow
} from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    title: "Price sheet",
    category: "pricing",
    audience: "both",
    storage_path: "p/price.pdf",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "content",
    summary: "summary",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    contact_id: null,
    renewal_date: null,
    assigned_employee_id: null,
    renewal_due_notified_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
});

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

describe("audienceViewForShareChannel", () => {
  it("only the dashboard reads as staff", () => {
    expect(audienceViewForShareChannel("dashboard")).toBe("staff");
    for (const channel of ["sms", "voice", "webchat", "flow", "email"] as const) {
      expect(audienceViewForShareChannel(channel)).toBe("clients");
    }
  });
});

describe("hashShareToken / buildShareUrl", () => {
  it("hashes deterministically", () => {
    expect(hashShareToken("abc")).toBe(hashShareToken("abc"));
    expect(hashShareToken("abc")).not.toBe(hashShareToken("abd"));
  });

  it("builds the URL from the env base, stripping trailing slashes", () => {
    expect(buildShareUrl("tok")).toBe("https://app.example.com/api/public/docs/tok");
  });

  it("prefers an explicit base and falls back to localhost", () => {
    expect(buildShareUrl("tok", "https://x.test")).toBe("https://x.test/api/public/docs/tok");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(buildShareUrl("tok")).toBe("http://localhost:3000/api/public/docs/tok");
  });
});

describe("mintDocumentShare", () => {
  it("refuses a document that is not ready", async () => {
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc({ status: "processing" }),
      channel: "sms",
      sharedWith: "+15551230000",
      now: NOW
    });
    expect(res).toEqual({ ok: false, detail: "document_not_ready" });
    expect(insertDocumentShare).not.toHaveBeenCalled();
  });

  it("refuses an expired document", async () => {
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc({ expires_at: "2026-01-01T00:00:00Z" }),
      channel: "dashboard",
      sharedWith: "owner",
      now: NOW
    });
    expect(res).toEqual({ ok: false, detail: "document_expired" });
  });

  it("refuses a staff-only document on a client channel", async () => {
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc({ audience: "staff" }),
      channel: "sms",
      sharedWith: "+15551230000",
      now: NOW
    });
    expect(res).toEqual({ ok: false, detail: "document_not_shareable" });
  });

  it("lets the dashboard share a staff-only document", async () => {
    vi.mocked(insertDocumentShare).mockResolvedValue({ id: "share-1" } as never);
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc({ audience: "staff" }),
      channel: "dashboard",
      sharedWith: "owner",
      now: NOW
    });
    expect(res.ok).toBe(true);
  });

  it("mints with the default 30-day TTL and hashes the token", async () => {
    vi.mocked(insertDocumentShare).mockResolvedValue({ id: "share-1" } as never);
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc(),
      channel: "sms",
      sharedWith: "x".repeat(300),
      now: NOW
    });
    expect(res).toMatchObject({ ok: true, shareId: "share-1" });
    const inserted = vi.mocked(insertDocumentShare).mock.calls[0][0];
    expect(inserted.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.shared_with).toHaveLength(200);
    expect(inserted.channel).toBe("sms");
    expect(inserted.expires_at).toBe("2026-08-10T12:00:00.000Z");
    if (res.ok) {
      const token = res.url.split("/").pop()!;
      expect(hashShareToken(token)).toBe(inserted.token_sha256);
    }
  });

  it("honors a custom TTL and defaults the clock", async () => {
    vi.mocked(insertDocumentShare).mockResolvedValue({ id: "share-2" } as never);
    const res = await mintDocumentShare({
      businessId: BIZ,
      document: doc(),
      channel: "flow",
      sharedWith: "+15551230000",
      ttlDays: 1
    });
    expect(res.ok).toBe(true);
    const inserted = vi.mocked(insertDocumentShare).mock.calls[0][0];
    const ttlMs = Date.parse(inserted.expires_at) - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("resolveDocumentShareByToken", () => {
  const share = {
    id: "share-1",
    business_id: BIZ,
    document_id: "22222222-2222-4222-8222-222222222222",
    token_sha256: "irrelevant",
    shared_with: "+15551230000",
    channel: "sms",
    expires_at: "2026-08-01T00:00:00Z",
    revoked_at: null,
    access_count: 0,
    last_accessed_at: null,
    created_at: "2026-07-01T00:00:00Z"
  };

  it("rejects an empty token without a lookup", async () => {
    expect(await resolveDocumentShareByToken("  ", NOW)).toEqual({
      ok: false,
      detail: "not_found"
    });
    expect(getDocumentShareByTokenSha).not.toHaveBeenCalled();
  });

  it("rejects an unknown token", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue(null);
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "not_found"
    });
  });

  it("rejects a revoked share", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue({
      ...share,
      revoked_at: "2026-07-02T00:00:00Z"
    } as never);
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "revoked"
    });
  });

  it("rejects an expired share link", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue({
      ...share,
      expires_at: "2026-07-01T00:00:00Z"
    } as never);
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "expired"
    });
  });

  it("rejects when the document is gone or not ready", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue(share as never);
    vi.mocked(getBusinessDocument).mockResolvedValue(null);
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ status: "failed" }));
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
  });

  it("rejects when the document itself has expired (stale-link kill switch)", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue(share as never);
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ expires_at: "2026-07-02T00:00:00Z" }));
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_expired"
    });
  });

  it("kills a customer-channel link the moment the document flips to internal-only", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue({ ...share, channel: "sms" } as never);
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ audience: "staff" }));
    expect(await resolveDocumentShareByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
    // A dashboard-minted link survives — the owner explicitly sent it.
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue({
      ...share,
      channel: "dashboard"
    } as never);
    const res = await resolveDocumentShareByToken("tok", NOW);
    expect(res.ok).toBe(true);
  });

  it("resolves a healthy share (default clock)", async () => {
    vi.mocked(getDocumentShareByTokenSha).mockResolvedValue({
      ...share,
      expires_at: "2999-01-01T00:00:00Z"
    } as never);
    const healthy = doc();
    vi.mocked(getBusinessDocument).mockResolvedValue(healthy);
    const res = await resolveDocumentShareByToken("tok");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.document).toBe(healthy);
  });
});
