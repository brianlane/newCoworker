/**
 * Daily expiration sweep (src/lib/documents/expiration.ts): one reminder
 * per state (expiring-soon / expired), armed/cleared stamps, per-document
 * error isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));
vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  patchBusinessDocument: vi.fn()
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));

import { sweepDocumentExpirations } from "@/lib/documents/expiration";
import { patchBusinessDocument, type BusinessDocumentRow } from "@/lib/documents/db";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    title: "Summer price list",
    category: "pricing",
    audience: "both",
    storage_path: "p",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "c",
    summary: "s",
    status: "ready",
    error_detail: null,
    expires_at: "2026-07-14T00:00:00Z",
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function makeDb(rows: BusinessDocumentRow[] | null, error: { message: string } | null = null) {
  const chain = {
    select: vi.fn(() => chain),
    not: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(resolve)
  };
  return { from: vi.fn(() => chain) } as never;
}

const dispatch = vi.mocked(dispatchUrgentNotification);
const patch = vi.mocked(patchBusinessDocument);

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.mockResolvedValue({ results: [] });
  patch.mockResolvedValue(undefined);
});

describe("sweepDocumentExpirations", () => {
  it("throws when the scan query fails", async () => {
    await expect(
      sweepDocumentExpirations({ client: makeDb(null, { message: "scan boom" }), now: () => NOW })
    ).rejects.toThrow(/scan boom/);
  });

  it("notifies once about a just-expired document and stamps it", async () => {
    const expired = doc({ expires_at: "2026-07-10T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([expired]), now: () => NOW });
    expect(result).toMatchObject({ scanned: 1, expiredNotified: 1, expiringSoonNotified: 0 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "document_expired",
        summary: expect.stringContaining("has expired")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      expired.id,
      { expired_notified_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("skips an expired document that was already notified", async () => {
    const expired = doc({
      expires_at: "2026-07-10T00:00:00Z",
      expired_notified_at: "2026-07-10T02:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([expired]), now: () => NOW });
    expect(result.expiredNotified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("notifies once about a document expiring within the window", async () => {
    const soon = doc({ expires_at: "2026-07-14T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([soon]), now: () => NOW });
    expect(result.expiringSoonNotified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document_expiring",
        summary: expect.stringContaining("expires 2026-07-14")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      soon.id,
      { expiring_soon_notified_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("skips an expiring-soon document that was already reminded", async () => {
    const soon = doc({
      expires_at: "2026-07-14T00:00:00Z",
      expiring_soon_notified_at: "2026-07-09T00:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([soon]), now: () => NOW });
    expect(result.expiringSoonNotified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves far-future documents alone", async () => {
    const far = doc({ expires_at: "2026-12-01T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([far]), now: () => NOW });
    expect(result).toMatchObject({ scanned: 1, expiredNotified: 0, expiringSoonNotified: 0 });
  });

  it("collects a per-document error and continues with the rest", async () => {
    const bad = doc({ id: "bad-doc", expires_at: "2026-07-10T00:00:00Z" });
    const good = doc({ id: "good-doc", expires_at: "2026-07-13T00:00:00Z" });
    dispatch
      .mockRejectedValueOnce(new Error("channel down"))
      .mockResolvedValueOnce({ results: [] });
    const result = await sweepDocumentExpirations({ client: makeDb([bad, good]), now: () => NOW });
    expect(result.errors).toEqual([{ documentId: "bad-doc", message: "channel down" }]);
    expect(result.expiringSoonNotified).toBe(1);
  });

  it("tolerates non-Error throw values in the per-document net", async () => {
    const bad = doc({ expires_at: "2026-07-10T00:00:00Z" });
    dispatch.mockRejectedValueOnce("string failure");
    const result = await sweepDocumentExpirations({ client: makeDb([bad]), now: () => NOW });
    expect(result.errors[0].message).toBe("string failure");
  });

  it("handles a null data payload and defaults the clock", async () => {
    const result = await sweepDocumentExpirations({ client: makeDb(null) });
    expect(result).toMatchObject({ scanned: 0 });
  });
});
