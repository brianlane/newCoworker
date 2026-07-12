/**
 * Document e-signatures (src/lib/documents/signing.ts): mint-time document
 * gating, fail-closed token resolution (signed certificates outlive link
 * expiry; expired documents block signing but not viewing a completed
 * signature), the TOCTOU-guarded signing write, and the audit trail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  insertDocumentSignatureRequest: vi.fn(),
  getDocumentSignatureRequestByTokenSha: vi.fn(),
  markSignatureRequestViewed: vi.fn(),
  completeSignatureRequest: vi.fn(),
  getBusinessDocument: vi.fn()
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));
vi.mock("@/lib/db/logs", () => ({ insertCoworkerLog: vi.fn() }));

import {
  SIGNATURE_REQUEST_DEFAULT_TTL_DAYS,
  buildSignUrl,
  fingerprintDocumentContent,
  markSignatureRequestOpened,
  mintSignatureRequest,
  resolveSignatureRequestByToken,
  signDocumentRequest
} from "@/lib/documents/signing";
import {
  completeSignatureRequest,
  getBusinessDocument,
  getDocumentSignatureRequestByTokenSha,
  insertDocumentSignatureRequest,
  markSignatureRequestViewed,
  type BusinessDocumentRow,
  type DocumentSignatureRequestRow
} from "@/lib/documents/db";
import { hashShareToken } from "@/lib/documents/share";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { insertCoworkerLog } from "@/lib/db/logs";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: DOC,
    business_id: BIZ,
    title: "Service agreement",
    category: "contracts",
    audience: "staff",
    storage_path: "p/agreement.pdf",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "## Terms\n- Net 30",
    summary: "Standard agreement.",
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

function requestRow(
  overrides: Partial<DocumentSignatureRequestRow> = {}
): DocumentSignatureRequestRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    business_id: BIZ,
    document_id: DOC,
    token_sha256: "irrelevant",
    signer_name: "Jane Customer",
    signer_email: "",
    signer_phone: "+15551230000",
    message: "",
    status: "sent",
    signature_name: null,
    signed_at: null,
    signer_ip: null,
    signer_user_agent: null,
    content_sha256: null,
    signed_content_md: null,
    expires_at: "2026-08-01T00:00:00Z",
    created_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
  vi.mocked(insertCoworkerLog).mockResolvedValue({} as never);
  vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
});

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

describe("buildSignUrl / fingerprintDocumentContent", () => {
  it("builds the public signing URL from the env base", () => {
    expect(buildSignUrl("tok")).toBe("https://app.example.com/sign/tok");
    expect(buildSignUrl("tok", "https://x.test/")).toBe("https://x.test/sign/tok");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(buildSignUrl("tok")).toBe("http://localhost:3000/sign/tok");
  });

  it("fingerprints content deterministically (sha256)", () => {
    expect(fingerprintDocumentContent("abc")).toBe(
      createHash("sha256").update("abc").digest("hex")
    );
  });
});

describe("mintSignatureRequest", () => {
  it("refuses non-ready, expired, and content-less documents", async () => {
    for (const [d, detail] of [
      [doc({ status: "processing" }), "document_not_ready"],
      [doc({ expires_at: "2026-01-01T00:00:00Z" }), "document_expired"],
      [doc({ content_md: "  " }), "document_empty"]
    ] as const) {
      expect(
        await mintSignatureRequest({ businessId: BIZ, document: d, signerName: "Jane", now: NOW })
      ).toEqual({ ok: false, detail });
    }
    expect(insertDocumentSignatureRequest).not.toHaveBeenCalled();
  });

  it("mints with the default TTL, hashed token, and bounded fields", async () => {
    vi.mocked(insertDocumentSignatureRequest).mockResolvedValue(requestRow({ id: "req-1" }));
    const res = await mintSignatureRequest({
      businessId: BIZ,
      document: doc(),
      signerName: "J".repeat(300),
      signerPhone: "+15551230000",
      message: "m".repeat(2000),
      now: NOW
    });
    expect(res).toMatchObject({ ok: true, requestId: "req-1" });
    const inserted = vi.mocked(insertDocumentSignatureRequest).mock.calls[0][0];
    expect(inserted.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.signer_name).toHaveLength(200);
    expect(inserted.message).toHaveLength(1000);
    expect(inserted.signer_email).toBe("");
    expect(inserted.expires_at).toBe(
      new Date(NOW.getTime() + SIGNATURE_REQUEST_DEFAULT_TTL_DAYS * 86_400_000).toISOString()
    );
    if (res.ok) {
      const token = res.url.split("/").pop()!;
      expect(hashShareToken(token)).toBe(inserted.token_sha256);
      expect(res.url).toContain("/sign/");
    }
  });

  it("honors a custom TTL, the email field, and defaults the clock", async () => {
    vi.mocked(insertDocumentSignatureRequest).mockResolvedValue(requestRow({ id: "req-2" }));
    const res = await mintSignatureRequest({
      businessId: BIZ,
      document: doc(),
      signerName: "Jane",
      signerEmail: "jane@example.com",
      ttlDays: 1
    });
    expect(res.ok).toBe(true);
    const inserted = vi.mocked(insertDocumentSignatureRequest).mock.calls[0][0];
    expect(inserted.signer_email).toBe("jane@example.com");
    const ttlMs = Date.parse(inserted.expires_at) - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("resolveSignatureRequestByToken", () => {
  it("rejects empty and unknown tokens", async () => {
    expect(await resolveSignatureRequestByToken("  ", NOW)).toEqual({
      ok: false,
      detail: "not_found"
    });
    expect(getDocumentSignatureRequestByTokenSha).not.toHaveBeenCalled();
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(null);
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "not_found"
    });
  });

  it("rejects void requests and expired UNSIGNED requests", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "void" })
    );
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({ ok: false, detail: "void" });
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ expires_at: "2026-07-01T00:00:00Z" })
    );
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "expired"
    });
  });

  it("a signed certificate outlives the link's own expiry", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "signed", expires_at: "2026-07-01T00:00:00Z" })
    );
    vi.mocked(getBusinessDocument).mockResolvedValue(doc());
    const res = await resolveSignatureRequestByToken("tok", NOW);
    expect(res.ok).toBe(true);
  });

  it("rejects when the document is gone or not ready", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(requestRow());
    vi.mocked(getBusinessDocument).mockResolvedValue(null);
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ status: "failed" }));
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
  });

  it("a SIGNED certificate stays viewable when the document leaves ready (but not when deleted)", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "signed" })
    );
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ status: "failed" }));
    const res = await resolveSignatureRequestByToken("tok", NOW);
    expect(res.ok).toBe(true);
    vi.mocked(getBusinessDocument).mockResolvedValue(null);
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_unavailable"
    });
  });

  it("an expired document blocks signing but not viewing a completed signature", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(requestRow());
    vi.mocked(getBusinessDocument).mockResolvedValue(doc({ expires_at: "2026-07-02T00:00:00Z" }));
    expect(await resolveSignatureRequestByToken("tok", NOW)).toEqual({
      ok: false,
      detail: "document_expired"
    });
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "signed" })
    );
    const res = await resolveSignatureRequestByToken("tok", NOW);
    expect(res.ok).toBe(true);
  });

  it("resolves a healthy request (default clock)", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "viewed", expires_at: "2999-01-01T00:00:00Z" })
    );
    vi.mocked(getBusinessDocument).mockResolvedValue(doc());
    const res = await resolveSignatureRequestByToken("tok");
    expect(res.ok).toBe(true);
  });
});

describe("markSignatureRequestOpened", () => {
  it("stamps only sent requests", async () => {
    await markSignatureRequestOpened(requestRow({ status: "viewed" }));
    expect(markSignatureRequestViewed).not.toHaveBeenCalled();
    await markSignatureRequestOpened(requestRow());
    expect(markSignatureRequestViewed).toHaveBeenCalledWith(requestRow().id);
  });

  it("swallows stamp failures (Error and non-Error) — rendering must not block", async () => {
    vi.mocked(markSignatureRequestViewed).mockRejectedValueOnce(new Error("db down"));
    await expect(markSignatureRequestOpened(requestRow())).resolves.toBeUndefined();
    vi.mocked(markSignatureRequestViewed).mockRejectedValueOnce("string failure");
    await expect(markSignatureRequestOpened(requestRow())).resolves.toBeUndefined();
  });
});

describe("signDocumentRequest", () => {
  const VIEWED_SHA = fingerprintDocumentContent(doc().content_md);
  function signable() {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "viewed" })
    );
    vi.mocked(getBusinessDocument).mockResolvedValue(doc());
    vi.mocked(completeSignatureRequest).mockResolvedValue(1);
  }

  it("requires a signature name and explicit consent", async () => {
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "  ", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "signature_name_required" });
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: false, now: NOW })
    ).toEqual({ ok: false, detail: "consent_required" });
    expect(getDocumentSignatureRequestByTokenSha).not.toHaveBeenCalled();
  });

  it("propagates resolution failures", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(null);
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "not_found" });
  });

  it("refuses an already-signed request without writing", async () => {
    vi.mocked(getDocumentSignatureRequestByTokenSha).mockResolvedValue(
      requestRow({ status: "signed" })
    );
    vi.mocked(getBusinessDocument).mockResolvedValue(doc());
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "already_signed" });
    expect(completeSignatureRequest).not.toHaveBeenCalled();
  });

  it("refuses when the document changed after the signer's page render", async () => {
    signable();
    const res = await signDocumentRequest({
      token: "tok",
      viewedContentSha256: fingerprintDocumentContent("some OTHER text the signer never saw"),
      signatureName: "Jane",
      consent: true,
      now: NOW
    });
    expect(res).toEqual({ ok: false, detail: "content_changed" });
    expect(completeSignatureRequest).not.toHaveBeenCalled();
  });

  it("loses the TOCTOU race cleanly when the conditional write matches zero rows", async () => {
    signable();
    vi.mocked(completeSignatureRequest).mockResolvedValue(0);
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "already_signed" });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("reports a racing VOID as void, not already_signed (and survives a vanished row)", async () => {
    signable();
    vi.mocked(completeSignatureRequest).mockResolvedValue(0);
    vi.mocked(getDocumentSignatureRequestByTokenSha)
      .mockResolvedValueOnce(requestRow({ status: "viewed" })) // resolve
      .mockResolvedValueOnce(requestRow({ status: "void" })); // post-race re-read
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "void" });
    vi.mocked(getDocumentSignatureRequestByTokenSha)
      .mockResolvedValueOnce(requestRow({ status: "viewed" }))
      .mockResolvedValueOnce(null);
    expect(
      await signDocumentRequest({ token: "tok", viewedContentSha256: VIEWED_SHA, signatureName: "Jane", consent: true, now: NOW })
    ).toEqual({ ok: false, detail: "already_signed" });
  });

  it("records the full audit trail, notifies the owner, and logs", async () => {
    signable();
    const res = await signDocumentRequest({
      token: "tok",
      viewedContentSha256: VIEWED_SHA,
      signatureName: `  ${"J".repeat(300)}  `,
      consent: true,
      signerIp: "203.0.113.9",
      signerUserAgent: "UA/1.0 " + "x".repeat(500),
      now: NOW
    });
    expect(res).toEqual({
      ok: true,
      signedAt: NOW.toISOString(),
      documentTitle: "Service agreement"
    });
    const [requestId, fields] = vi.mocked(completeSignatureRequest).mock.calls[0];
    expect(requestId).toBe(requestRow().id);
    expect(fields.signature_name).toHaveLength(200);
    expect(fields.signer_ip).toBe("203.0.113.9");
    expect(fields.signer_user_agent).toHaveLength(400);
    expect(fields.content_sha256).toBe(fingerprintDocumentContent(doc().content_md));
    expect(fields.signed_content_md).toBe(doc().content_md);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        task_type: "data_flow",
        status: "success",
        log_payload: expect.objectContaining({ event: "document_signed" })
      })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, kind: "document_signed" })
    );
  });

  it("stores null IP/UA when absent", async () => {
    signable();
    const res = await signDocumentRequest({
      token: "tok",
      viewedContentSha256: VIEWED_SHA,
      signatureName: "Jane",
      consent: true,
      now: NOW
    });
    expect(res.ok).toBe(true);
    const [, fields] = vi.mocked(completeSignatureRequest).mock.calls[0];
    expect(fields.signer_ip).toBeNull();
    expect(fields.signer_user_agent).toBeNull();
  });

  it("the signature survives a failed notification (Error and non-Error)", async () => {
    signable();
    vi.mocked(insertCoworkerLog).mockRejectedValueOnce(new Error("log down"));
    const res = await signDocumentRequest({
      token: "tok",
      viewedContentSha256: VIEWED_SHA,
      signatureName: "Jane",
      consent: true,
      now: NOW
    });
    expect(res.ok).toBe(true);
    signable();
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce("string failure");
    const res2 = await signDocumentRequest({
      token: "tok",
      viewedContentSha256: VIEWED_SHA,
      signatureName: "Jane",
      consent: true
    });
    expect(res2.ok).toBe(true);
  });
});
