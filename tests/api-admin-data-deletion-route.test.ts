import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));
vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));
vi.mock("@/lib/privacy/deletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/deletion")>();
  return { ...actual, deleteEndUserData: vi.fn() };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/admin/data-deletion/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { deleteEndUserData, EndUserDeletionError } from "@/lib/privacy/deletion";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const RESULT = {
  businessId: BIZ_ID,
  identifierFingerprint: "abc123",
  tables: [{ table: "contacts", central: 1, box: null }]
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/data-deletion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/data-deletion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ isAdmin: true } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID } as never);
    vi.mocked(deleteEndUserData).mockResolvedValue(RESULT);
    vi.mocked(insertCoworkerLog).mockResolvedValue({} as never);
  });

  it("runs the erasure and audit-logs the fingerprint (never the identifier)", async () => {
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, e164: "+15551234567", confirm: true })
    );
    expect(res.status).toBe(200);
    expect(deleteEndUserData).toHaveBeenCalledWith(BIZ_ID, {
      e164: "+15551234567",
      email: undefined
    });
    const logArg = vi.mocked(insertCoworkerLog).mock.calls[0][0];
    expect(JSON.stringify(logArg)).not.toContain("+15551234567");
    expect(logArg.log_payload).toMatchObject({
      action: "end_user_data_deleted",
      identifierFingerprint: "abc123"
    });
    const json = await res.json();
    expect(json.data.identifierFingerprint).toBe("abc123");
  });

  it("requires confirm: true and at least one identifier", async () => {
    const unconfirmed = await POST(makeRequest({ businessId: BIZ_ID, e164: "+15551234567" }));
    expect(unconfirmed.status).toBe(400);

    const noIdentifier = await POST(makeRequest({ businessId: BIZ_ID, confirm: true }));
    expect(noIdentifier.status).toBe(400);
    expect(deleteEndUserData).not.toHaveBeenCalled();
  });

  it("404s a missing business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, email: "a@b.co", confirm: true })
    );
    expect(res.status).toBe(404);
  });

  it("maps a bad identifier to a 400 and unexpected errors to 500", async () => {
    vi.mocked(deleteEndUserData).mockRejectedValue(
      new EndUserDeletionError("bad e164", "input")
    );
    const bad = await POST(makeRequest({ businessId: BIZ_ID, e164: "nope", confirm: true }));
    expect(bad.status).toBe(400);
    // Nothing ran, so nothing to remediate: no aborted-erasure audit row.
    expect(insertCoworkerLog).not.toHaveBeenCalled();

    vi.mocked(deleteEndUserData).mockRejectedValue(new Error("box down"));
    const boom = await POST(
      makeRequest({ businessId: BIZ_ID, e164: "+15551234567", confirm: true })
    );
    expect(boom.status).toBe(500);
  });

  /**
   * An execution failure means the erasure stopped part way through with rows
   * already deleted. Reporting that as a 400 is what let a dropped-table
   * reference abort every erasure for seven weeks while reading to the admin
   * as "you typed a bad identifier", and it left no trace to remediate from.
   */
  it("reports a part-way failure as a server error and records it for remediation", async () => {
    vi.mocked(deleteEndUserData).mockRejectedValue(
      new EndUserDeletionError("contact_overrides: relation does not exist")
    );

    const res = await POST(
      makeRequest({ businessId: BIZ_ID, e164: "+15551234567", confirm: true })
    );

    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("aborted part way through"),
      expect.objectContaining({ businessId: BIZ_ID })
    );
    // The audit row is what makes a half-erased subject findable later.
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        status: "error",
        log_payload: expect.objectContaining({
          action: "end_user_data_deletion_aborted",
          error: "contact_overrides: relation does not exist"
        })
      })
    );
    // Fingerprint, never the identifier itself.
    const payload = vi.mocked(insertCoworkerLog).mock.calls[0][0] as {
      log_payload: Record<string, unknown>;
    };
    expect(JSON.stringify(payload.log_payload)).not.toContain("+15551234567");
  });

  it("a failed aborted-erasure audit insert does not mask the original error", async () => {
    vi.mocked(deleteEndUserData).mockRejectedValue(new EndUserDeletionError("store down"));
    vi.mocked(insertCoworkerLog).mockRejectedValue(new Error("logs down"));

    const res = await POST(
      makeRequest({ businessId: BIZ_ID, e164: "+15551234567", confirm: true })
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ message: "store down" }) })
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("aborted-erasure audit insert failed"),
      expect.objectContaining({ businessId: BIZ_ID })
    );
  });

  it("a failed audit insert logs loudly but returns success", async () => {
    vi.mocked(insertCoworkerLog).mockRejectedValue(new Error("logs down"));
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, email: "a@b.co", confirm: true })
    );
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("audit log insert failed"),
      expect.objectContaining({ identifierFingerprint: "abc123" })
    );
  });
});
