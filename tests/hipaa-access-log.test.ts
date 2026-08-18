import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock()
}));

import {
  PHI_RESOURCES,
  phiAccessRequestContext,
  recordPhiAccess
} from "@/lib/hipaa/access-log";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "33333333-3333-4333-8333-333333333333";

function mockDb(result: { error: { message: string } | null } = { error: null }) {
  // Typed with the row param so `insert.mock.calls[0][0]` is a real tuple
  // element; an argless vi.fn() infers calls as [][] and tsc rejects the index.
  const insert = vi.fn(async (_row: Record<string, unknown>) => result);
  const from = vi.fn(() => ({ insert }));
  return { db: { from } as never, from, insert };
}

function headerBag(map: Record<string, string>) {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

const ENTRY = {
  businessId: BIZ,
  userId: "user-1",
  userEmail: "staff@clinic.com",
  resource: "contact" as const,
  resourceId: "+15551234567"
};

describe("hipaa/access-log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersMock.mockReturnValue(headerBag({}));
  });

  describe("recordPhiAccess", () => {
    it("writes an append-only row for a HIPAA tenant", async () => {
      const { db, from, insert } = mockDb();
      await recordPhiAccess(true, { ...ENTRY, ip: "1.2.3.4", userAgent: "UA" }, db);
      expect(from).toHaveBeenCalledWith("phi_access_log");
      expect(insert).toHaveBeenCalledWith({
        business_id: BIZ,
        user_id: "user-1",
        user_email: "staff@clinic.com",
        action: "view",
        resource: "contact",
        resource_id: "+15551234567",
        ip: "1.2.3.4",
        user_agent: "UA"
      });
    });

    it("defaults the action to view", async () => {
      const { db, insert } = mockDb();
      await recordPhiAccess(true, ENTRY, db);
      expect(insert.mock.calls[0]?.[0]).toMatchObject({ action: "view" });
    });

    it("carries an explicit action through", async () => {
      const { db, insert } = mockDb();
      await recordPhiAccess(true, { ...ENTRY, action: "export" }, db);
      expect(insert.mock.calls[0]?.[0]).toMatchObject({ action: "export" });
    });

    it("nulls the optional fields rather than writing undefined", async () => {
      const { db, insert } = mockDb();
      await recordPhiAccess(true, { businessId: BIZ, resource: "email_thread" }, db);
      expect(insert.mock.calls[0]?.[0]).toMatchObject({
        user_id: null,
        user_email: null,
        resource_id: null,
        ip: null,
        user_agent: null
      });
    });

    it("records NOTHING for a non-HIPAA tenant", async () => {
      const { db, from } = mockDb();
      await recordPhiAccess(false, ENTRY, db);
      await recordPhiAccess(null, ENTRY, db);
      await recordPhiAccess(undefined, ENTRY, db);
      // Deliberately the opposite fail direction from the notification
      // redaction: over-logging would put other tenants' customer identifiers
      // into a table built for a duty they are not under.
      expect(from).not.toHaveBeenCalled();
    });

    it("never throws when the insert fails, but logs loudly", async () => {
      const { db } = mockDb({ error: { message: "insert denied" } });
      const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
      await expect(recordPhiAccess(true, ENTRY, db)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        "phi-access-log: FAILED to record an access",
        expect.objectContaining({ error: "insert denied" })
      );
      spy.mockRestore();
    });

    it("survives a non-Error throw and still names it in the log", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue("string rejection");
      const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
      await expect(recordPhiAccess(true, ENTRY)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        "phi-access-log: FAILED to record an access",
        expect.objectContaining({ error: "string rejection" })
      );
      spy.mockRestore();
    });

    it("never throws when the client cannot be built", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
      const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
      await expect(recordPhiAccess(true, ENTRY)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("falls back to the service client when none is supplied", async () => {
      const { db, from } = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
      await recordPhiAccess(true, ENTRY);
      expect(createSupabaseServiceClient).toHaveBeenCalled();
      expect(from).toHaveBeenCalledWith("phi_access_log");
    });
  });

  describe("phiAccessRequestContext", () => {
    it("prefers the first x-forwarded-for hop", async () => {
      headersMock.mockReturnValue(
        headerBag({ "x-forwarded-for": "9.9.9.9, 10.0.0.1", "user-agent": "Chrome" })
      );
      expect(await phiAccessRequestContext()).toEqual({ ip: "9.9.9.9", userAgent: "Chrome" });
    });

    it("falls back through x-real-ip then cf-connecting-ip", async () => {
      headersMock.mockReturnValue(headerBag({ "x-real-ip": "8.8.8.8" }));
      expect((await phiAccessRequestContext()).ip).toBe("8.8.8.8");
      headersMock.mockReturnValue(headerBag({ "cf-connecting-ip": "7.7.7.7" }));
      expect((await phiAccessRequestContext()).ip).toBe("7.7.7.7");
    });

    it("returns nulls when no address header is present", async () => {
      expect(await phiAccessRequestContext()).toEqual({ ip: null, userAgent: null });
    });

    it("degrades to nulls outside a request scope rather than throwing", async () => {
      // headers() throws here. An audit row missing its IP beats no page.
      headersMock.mockImplementation(() => {
        throw new Error("called outside a request scope");
      });
      expect(await phiAccessRequestContext()).toEqual({ ip: null, userAgent: null });
    });
  });

  it("exposes logical surfaces, not table names, so the trail survives schema churn", () => {
    expect([...PHI_RESOURCES]).toEqual([
      "contact",
      "sms_thread",
      "voice_transcript",
      "email_thread"
    ]);
  });
});
