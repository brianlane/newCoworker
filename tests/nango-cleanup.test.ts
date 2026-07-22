import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.fn();
const mockListConnections = vi.fn();
const mockDeleteConnection = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => mockCreateClient(...a)
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: (...a: unknown[]) => mockListConnections(...a)
}));

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({ deleteConnection: mockDeleteConnection })
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  revokeNangoConnectionRows,
  revokeNangoConnectionsForBusiness,
  snapshotNangoConnectionLinks
} from "@/lib/nango/cleanup";
import { logger } from "@/lib/logger";

const OLD_ENV = process.env;

function mockDb(deleteError: { message: string } | null = null) {
  const db = {
    from: vi.fn(),
    delete: vi.fn(),
    eq: vi.fn()
  };
  db.from.mockReturnValue(db);
  db.delete.mockReturnValue(db);
  db.eq.mockResolvedValue({ error: deleteError });
  return db;
}

const ROWS = [
  { provider_config_key: "google-mail", connection_id: "c1" },
  { provider_config_key: "outlook", connection_id: "c2" }
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...OLD_ENV, NANGO_SECRET_KEY: "sk" };
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("snapshotNangoConnectionLinks", () => {
  it("returns the business's rows (default client)", async () => {
    mockCreateClient.mockResolvedValue(mockDb());
    mockListConnections.mockResolvedValue(ROWS);
    await expect(snapshotNangoConnectionLinks("biz-1")).resolves.toEqual(ROWS);
  });

  it("returns [] on a read failure instead of blocking the deletion", async () => {
    const db = mockDb();
    mockListConnections.mockRejectedValue(new Error("db offline"));
    await expect(snapshotNangoConnectionLinks("biz-1", db as never)).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "nango cleanup: snapshot failed (revocation will be skipped)",
      { businessId: "biz-1", error: "db offline" }
    );

    mockListConnections.mockRejectedValue("weird");
    await expect(snapshotNangoConnectionLinks("biz-1", db as never)).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "nango cleanup: snapshot failed (revocation will be skipped)",
      { businessId: "biz-1", error: "weird" }
    );
  });
});

describe("revokeNangoConnectionRows", () => {
  it("revokes every snapshot row on Nango", async () => {
    mockDeleteConnection.mockResolvedValue(undefined);
    await expect(revokeNangoConnectionRows("biz-1", ROWS)).resolves.toBe(2);
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "c1");
    expect(mockDeleteConnection).toHaveBeenCalledWith("outlook", "c2");
    expect(logger.info).toHaveBeenCalledWith("nango cleanup: connections revoked", {
      businessId: "biz-1",
      rows: 2,
      revoked: 2
    });
  });

  it("returns 0 fast on an empty snapshot", async () => {
    await expect(revokeNangoConnectionRows("biz-1", [])).resolves.toBe(0);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });

  it("skips revocation without NANGO_SECRET_KEY", async () => {
    delete process.env.NANGO_SECRET_KEY;
    await expect(revokeNangoConnectionRows("biz-1", ROWS)).resolves.toBe(0);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "nango cleanup: NANGO_SECRET_KEY missing; skipping provider-side revocation",
      { businessId: "biz-1", rows: 2 }
    );
  });

  it("continues past per-connection failures (Error and non-Error)", async () => {
    mockDeleteConnection
      .mockRejectedValueOnce(new Error("nango down"))
      .mockRejectedValueOnce("plain refusal");
    await expect(revokeNangoConnectionRows("biz-1", ROWS)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "nango cleanup: deleteConnection failed (leaks account quota)",
      expect.objectContaining({ connectionId: "c1", error: "nango down" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "nango cleanup: deleteConnection failed (leaks account quota)",
      expect.objectContaining({ connectionId: "c2", error: "plain refusal" })
    );
  });
});

describe("revokeNangoConnectionsForBusiness (wipe path)", () => {
  it("revokes every connection on Nango then deletes the rows", async () => {
    const db = mockDb();
    mockCreateClient.mockResolvedValue(db);
    mockListConnections.mockResolvedValue(ROWS);
    mockDeleteConnection.mockResolvedValue(undefined);

    const revoked = await revokeNangoConnectionsForBusiness("biz-1");
    expect(revoked).toBe(2);
    expect(mockDeleteConnection).toHaveBeenCalledWith("google-mail", "c1");
    expect(mockDeleteConnection).toHaveBeenCalledWith("outlook", "c2");
    expect(db.from).toHaveBeenCalledWith("workspace_oauth_connections");
    expect(db.eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("returns 0 fast when the business has no connections", async () => {
    const db = mockDb();
    mockListConnections.mockResolvedValue([]);
    const revoked = await revokeNangoConnectionsForBusiness("biz-1", db as never);
    expect(revoked).toBe(0);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("still deletes the rows after a partial Nango failure", async () => {
    const db = mockDb();
    mockListConnections.mockResolvedValue(ROWS);
    mockDeleteConnection
      .mockRejectedValueOnce(new Error("nango down"))
      .mockResolvedValueOnce(undefined);

    const revoked = await revokeNangoConnectionsForBusiness("biz-1", db as never);
    expect(revoked).toBe(1);
    expect(db.delete).toHaveBeenCalled();
  });

  it("logs a failed row delete without throwing", async () => {
    const db = mockDb({ message: "rls says no" });
    mockListConnections.mockResolvedValue([ROWS[0]]);
    mockDeleteConnection.mockResolvedValue(undefined);

    const revoked = await revokeNangoConnectionsForBusiness("biz-1", db as never);
    expect(revoked).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("nango cleanup: row delete failed", {
      businessId: "biz-1",
      error: "rls says no"
    });
  });

  it("never throws — a listing failure returns 0 (Error and non-Error)", async () => {
    const db = mockDb();
    mockListConnections.mockRejectedValue(new Error("db offline"));
    await expect(revokeNangoConnectionsForBusiness("biz-1", db as never)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("nango cleanup failed", {
      businessId: "biz-1",
      error: "db offline"
    });

    mockListConnections.mockRejectedValue("weird");
    await expect(revokeNangoConnectionsForBusiness("biz-1", db as never)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("nango cleanup failed", {
      businessId: "biz-1",
      error: "weird"
    });
  });
});
