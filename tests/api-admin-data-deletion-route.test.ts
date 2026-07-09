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

  it("maps EndUserDeletionError to a 400 and unexpected errors to 500", async () => {
    vi.mocked(deleteEndUserData).mockRejectedValue(new EndUserDeletionError("bad e164"));
    const bad = await POST(makeRequest({ businessId: BIZ_ID, e164: "nope", confirm: true }));
    expect(bad.status).toBe(400);

    vi.mocked(deleteEndUserData).mockRejectedValue(new Error("box down"));
    const boom = await POST(
      makeRequest({ businessId: BIZ_ID, e164: "+15551234567", confirm: true })
    );
    expect(boom.status).toBe(500);
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
