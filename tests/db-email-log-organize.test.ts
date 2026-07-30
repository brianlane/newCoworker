import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false), readMovedRows: vi.fn() };
});

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import { listEmailLog, organizeTenantEmailLog } from "@/lib/db/email-log";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";

const BIZ = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000099";

function makeSelectChain(row: unknown, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  const eq2 = vi.fn(() => ({ maybeSingle }));
  const is = vi.fn(() => ({ eq: eq2, maybeSingle }));
  const eq1 = vi.fn(() => ({ is, eq: eq2, maybeSingle }));
  const select = vi.fn(() => ({ eq: eq1 }));
  return { select, eq1, eq2, is, maybeSingle };
}

function makeUpdateChain(error: { message: string } | null = null) {
  const result = { error };
  const thenable = {
    ...result,
    then: (resolve: (v: { error: typeof error }) => void) => resolve(result)
  };
  const eq2 = vi.fn(() => thenable);
  const eq1 = vi.fn(() => ({ eq: eq2, then: thenable.then, error }));
  const update = vi.fn(() => ({ eq: eq1 }));
  return { update, eq1, eq2 };
}

describe("organizeTenantEmailLog", () => {
  beforeEach(() => {
    defaultClientSpy.mockReset();
    vi.mocked(isVpsReadMode).mockResolvedValue(false);
  });

  it("returns false without identity", async () => {
    await expect(organizeTenantEmailLog({ businessId: BIZ, markRead: true })).resolves.toBe(
      false
    );
  });

  it("returns false when the row is missing", async () => {
    const sel = makeSelectChain(null);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => sel) });
    await expect(
      organizeTenantEmailLog({ businessId: BIZ, providerMessageId: "rfc", unarchive: true })
    ).resolves.toBe(false);
  });

  it("throws on select error", async () => {
    const sel = makeSelectChain(null, { message: "boom" });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => sel) });
    await expect(
      organizeTenantEmailLog({ businessId: BIZ, emailLogId: ID, markRead: true })
    ).rejects.toThrow(/organizeTenantEmailLog: boom/);
  });

  it("applies archive, labels, folder, and read updates", async () => {
    const sel = makeSelectChain({
      id: ID,
      is_read: false,
      archived_at: null,
      folder: null,
      labels: ["Old", null]
    });
    const upd = makeUpdateChain(null);
    const from = vi
      .fn()
      .mockReturnValueOnce(sel)
      .mockReturnValueOnce(upd);
    defaultClientSpy.mockResolvedValue({ from });

    await expect(
      organizeTenantEmailLog({
        businessId: BIZ,
        emailLogId: ID,
        markRead: true,
        archive: true,
        addLabels: ["Sales", " ", "Old"],
        removeLabels: ["Old", ""],
        moveToFolder: "Sales"
      })
    ).resolves.toBe(true);
    expect(upd.update).toHaveBeenCalled();
  });

  it("clears folder and unarchives; no-op when patch empty", async () => {
    const sel = makeSelectChain({
      id: ID,
      is_read: true,
      archived_at: "2026-01-01T00:00:00Z",
      folder: "X",
      labels: null
    });
    const upd = makeUpdateChain(null);
    const from = vi.fn().mockReturnValueOnce(sel).mockReturnValueOnce(upd);
    defaultClientSpy.mockResolvedValue({ from });
    await expect(
      organizeTenantEmailLog({
        businessId: BIZ,
        emailLogId: ID,
        markUnread: true,
        unarchive: true,
        moveToFolder: null
      })
    ).resolves.toBe(true);

    const sel2 = makeSelectChain({
      id: ID,
      is_read: true,
      archived_at: null,
      folder: null,
      labels: ["Keep"]
    });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => sel2) });
    // removeLabels that do not match → no labelsChanged; no other actions → empty patch
    await expect(
      organizeTenantEmailLog({
        businessId: BIZ,
        emailLogId: ID,
        removeLabels: ["Missing"]
      })
    ).resolves.toBe(true);
  });

  it("throws on update error", async () => {
    const sel = makeSelectChain({
      id: ID,
      is_read: false,
      archived_at: null,
      folder: null,
      labels: []
    });
    const upd = makeUpdateChain({ message: "write failed" });
    const from = vi.fn().mockReturnValueOnce(sel).mockReturnValueOnce(upd);
    defaultClientSpy.mockResolvedValue({ from });
    await expect(
      organizeTenantEmailLog({ businessId: BIZ, emailLogId: ID, archive: true })
    ).rejects.toThrow(/update: write failed/);
  });
});

describe("listEmailLog organize filters", () => {
  beforeEach(() => {
    defaultClientSpy.mockReset();
    vi.mocked(isVpsReadMode).mockResolvedValue(false);
    vi.mocked(readMovedRows).mockReset();
  });

  it("applies central inbox=true filter", async () => {
    const api: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = () => api;
    for (const m of ["select", "eq", "is", "not", "contains", "order", "limit"]) {
      api[m] = vi.fn(self);
    }
    api.limit = vi.fn().mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => api) });
    await listEmailLog(BIZ, { inbox: true });
    expect(api.eq).toHaveBeenCalledWith("direction", "inbound");
    expect(api.is).toHaveBeenCalledWith("archived_at", null);
    expect(api.is).toHaveBeenCalledWith("folder", null);
  });

  it("applies central filters for archived and label", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const order = vi.fn(() => ({ limit }));
    const contains = vi.fn(() => ({ order }));
    const not = vi.fn(() => ({ contains, order }));
    const eq = vi.fn(() => ({ is: vi.fn(() => ({ not, eq, contains, order })), eq, contains, order, not }));
    // Rebuild a more linear chain matching listEmailLog's fluent calls.
    const api: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = () => api;
    for (const m of ["select", "eq", "is", "not", "contains", "order", "limit"]) {
      api[m] = vi.fn(self);
    }
    api.limit = vi.fn().mockResolvedValue({
      data: [
        {
          id: ID,
          business_id: BIZ,
          direction: "inbound",
          to_email: null,
          from_email: "a@b.com",
          subject: "S",
          body_preview: "p",
          cc_email: null,
          bcc_email: null,
          source: "tenant_mailbox_inbound",
          run_id: null,
          flow_id: null,
          provider_message_id: null,
          created_at: "2026-07-30T00:00:00Z",
          is_read: false,
          archived_at: "2026-07-30T01:00:00Z",
          folder: "Sales",
          labels: ["Sales"]
        }
      ],
      error: null
    });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => api) });
    const rows = await listEmailLog(BIZ, {
      direction: "inbound",
      inbox: false,
      unreadOnly: true,
      folder: "Sales",
      label: "Sales"
    });
    expect(rows).toHaveLength(1);
    expect(api.not).toHaveBeenCalled();
    expect(api.contains).toHaveBeenCalledWith("labels", ["Sales"]);
  });

  it("filters archived and labels on the VPS path", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockResolvedValue([
      {
        id: "a",
        business_id: BIZ,
        direction: "inbound",
        to_email: null,
        from_email: "a@b.com",
        subject: "1",
        body_preview: "",
        cc_email: null,
        bcc_email: null,
        source: "tenant_mailbox_inbound",
        run_id: null,
        flow_id: null,
        provider_message_id: null,
        created_at: "2026-07-30T00:00:00Z",
        is_read: false,
        archived_at: "2026-07-30T01:00:00Z",
        folder: "Sales",
        labels: ["Sales"]
      },
      {
        id: "b",
        business_id: BIZ,
        direction: "inbound",
        to_email: null,
        from_email: "a@b.com",
        subject: "2",
        body_preview: "",
        cc_email: null,
        bcc_email: null,
        source: "tenant_mailbox_inbound",
        run_id: null,
        flow_id: null,
        provider_message_id: null,
        created_at: "2026-07-30T00:00:00Z",
        is_read: true,
        archived_at: null,
        folder: null,
        labels: []
      }
    ] as never);
    const rows = await listEmailLog(BIZ, {
      inbox: false,
      label: "Sales",
      direction: "inbound",
      unreadOnly: true,
      folder: "Sales",
      limit: 10
    });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("pushes archived_at is null on the VPS inbox filter", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockResolvedValue([]);
    await listEmailLog(BIZ, { inbox: true, limit: 5 });
    expect(readMovedRows).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        filters: expect.arrayContaining([
          { column: "direction", op: "eq", value: "inbound" },
          { column: "archived_at", op: "is", value: null },
          { column: "folder", op: "is", value: null }
        ])
      })
    );
  });

  it("pushes archived_at gte on the VPS archived filter", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockResolvedValue([]);
    await listEmailLog(BIZ, { inbox: false, limit: 5 });
    expect(readMovedRows).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        filters: expect.arrayContaining([
          {
            column: "archived_at",
            op: "gte",
            value: "1970-01-01T00:00:00.000Z"
          }
        ])
      })
    );
  });
});
