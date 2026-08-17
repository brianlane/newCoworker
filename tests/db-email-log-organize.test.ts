import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false), readMovedRows: vi.fn() };
});

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import {
  coerceEmailImportance,
  listEmailLog,
  organizeTenantEmailLog,
  setEmailLogImportance
} from "@/lib/db/email-log";
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

  it("pushes source in-filter for unread AI-mailbox views", async () => {
    const api: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = () => api;
    for (const m of ["select", "eq", "is", "not", "contains", "in", "order", "limit"]) {
      api[m] = vi.fn(self);
    }
    api.limit = vi.fn().mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => api) });
    await listEmailLog(BIZ, {
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
    });
    expect(api.in).toHaveBeenCalledWith("source", [
      "tenant_mailbox_inbound",
      "tenant_mailbox_outbound"
    ]);

    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockResolvedValue([]);
    await listEmailLog(BIZ, {
      unreadOnly: true,
      sources: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"],
      limit: 5
    });
    expect(readMovedRows).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        filters: expect.arrayContaining([
          {
            column: "source",
            op: "in",
            value: ["tenant_mailbox_inbound", "tenant_mailbox_outbound"]
          }
        ])
      })
    );
  });
});

describe("coerceEmailImportance", () => {
  /**
   * The value arrives as a rendered template, which means it arrives as
   * whatever a language model felt like emitting. Asking for a number is not
   * the same as receiving one, so this is lenient about SHAPE and strict about
   * RANGE: the display field must never be able to fail a labelling step.
   */
  it("takes a clean integer", () => {
    expect(coerceEmailImportance("6")).toBe(6);
    expect(coerceEmailImportance(" 6 ")).toBe(6);
    expect(coerceEmailImportance(6)).toBe(6);
  });

  it("takes the leading integer out of the shapes models actually return", () => {
    expect(coerceEmailImportance("6/10")).toBe(6);
    expect(coerceEmailImportance("7 - needs a reply")).toBe(7);
  });

  it("clamps instead of rejecting, so an out-of-range answer still sorts", () => {
    // 0 and 11 are still expressions of "least" and "most". Rejecting them
    // would trade a usable ordering for a null, and the DB check constraint
    // would otherwise turn a model's overshoot into a failed write.
    expect(coerceEmailImportance("0")).toBe(1);
    expect(coerceEmailImportance("-3")).toBe(1);
    expect(coerceEmailImportance("11")).toBe(10);
    expect(coerceEmailImportance("100")).toBe(10);
  });

  it("scores nothing when there is no leading integer", () => {
    // Null means "never scored", which the Emails page sinks to the bottom of
    // an importance sort. That is the honest answer for prose.
    for (const raw of ["", "   ", "high", "very important", "n/a", null, undefined, {}, []]) {
      expect(coerceEmailImportance(raw), String(raw)).toBeNull();
    }
  });

  it("returns null for a digit string too large to be a finite number", () => {
    // Reachable, not defensive: Number.parseInt of ~400 nines is Infinity, and
    // clamping Infinity would write 10, inventing a maximum score out of
    // gibberish. A model repeating a digit is a real failure mode.
    expect(coerceEmailImportance("9".repeat(400))).toBeNull();
  });

  it("ignores a number that only appears later in the text", () => {
    // "no idea, maybe 8" is not a score, it is a sentence. Reading the 8 out of
    // it would invent a confidence the model never expressed.
    expect(coerceEmailImportance("no idea, maybe 8")).toBeNull();
  });
});

describe("setEmailLogImportance", () => {
  beforeEach(() => {
    defaultClientSpy.mockReset();
  });

  function makeImportanceChain(rows: unknown[], error: { message: string } | null = null) {
    const select = vi.fn().mockResolvedValue({ data: rows, error });
    const eqId = vi.fn(() => ({ select }));
    const is = vi.fn(() => ({ eq: eqId }));
    const eqBiz = vi.fn(() => ({ is }));
    const update = vi.fn(() => ({ eq: eqBiz }));
    return { update, eqBiz, is, eqId, select };
  }

  it("returns false without any identity to write against", async () => {
    await expect(setEmailLogImportance(BIZ, {}, 5)).resolves.toBe(false);
    await expect(setEmailLogImportance(BIZ, { emailLogId: "  " }, 5)).resolves.toBe(false);
  });

  it("writes by row id, scoped to the business and to live rows", async () => {
    const c = makeImportanceChain([{ id: ID }]);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(setEmailLogImportance(BIZ, { emailLogId: ID }, 6)).resolves.toBe(true);
    expect(c.update).toHaveBeenCalledWith({ importance: 6 });
    expect(c.eqBiz).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
    expect(c.eqId).toHaveBeenCalledWith("id", ID);
  });

  it("falls back to the provider message id when there is no row id", async () => {
    const c = makeImportanceChain([{ id: ID }]);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(
      setEmailLogImportance(BIZ, { providerMessageId: "gmail-123" }, 3)
    ).resolves.toBe(true);
    expect(c.eqId).toHaveBeenCalledWith("provider_message_id", "gmail-123");
  });

  it("clears the score with an explicit null", async () => {
    const c = makeImportanceChain([{ id: ID }]);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(setEmailLogImportance(BIZ, { emailLogId: ID }, null)).resolves.toBe(true);
    expect(c.update).toHaveBeenCalledWith({ importance: null });
  });

  it("reports a write that matched no rows", async () => {
    // PostgREST returns no error for an update matching zero rows, so without
    // the .select() this would read as a successful score and the Emails page
    // would show a blank forever.
    const c = makeImportanceChain([]);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(setEmailLogImportance(BIZ, { emailLogId: ID }, 6)).resolves.toBe(false);
  });

  it("treats a null data payload as no rows written", async () => {
    // PostgREST can answer with data:null rather than an empty array; reading
    // .length off that would throw inside a display-only write path.
    const c = makeImportanceChain(null as never);
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(setEmailLogImportance(BIZ, { emailLogId: ID }, 6)).resolves.toBe(false);
  });

  it("throws on a real write error", async () => {
    const c = makeImportanceChain([], { message: "boom" });
    defaultClientSpy.mockResolvedValue({ from: vi.fn(() => c) });
    await expect(setEmailLogImportance(BIZ, { emailLogId: ID }, 6)).rejects.toThrow(
      /setEmailLogImportance: boom/
    );
  });
});
