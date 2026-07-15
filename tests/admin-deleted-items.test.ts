import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false), readMovedRows: vi.fn() };
});

vi.mock("@/lib/residency/row-delete", () => ({
  restoreContentRows: vi.fn()
}));

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { listDeletedItems, restoreDeletedItem } from "@/lib/admin/deleted-items";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";
import { restoreContentRows } from "@/lib/residency/row-delete";

const BIZ = "11111111-1111-4111-8111-111111111111";

type Result = { data: unknown; error: { message: string } | null };

/**
 * Self-returning chain whose configured terminal method resolves. Central
 * list reads end at .limit(); the sms restore update ends at .select(); the
 * legacy page ends at .range().
 */
function chain(terminal: string, results: Result[] | Result) {
  const c: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["select", "update", "eq", "is", "in", "not", "order", "limit", "range"]) {
    c[m] = vi.fn(() => c);
  }
  const list = Array.isArray(results) ? results : [results];
  const t = vi.fn();
  for (const r of list) t.mockResolvedValueOnce(r);
  c[terminal] = t;
  return c;
}

function dbByTable(map: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>) {
  const counters: Record<string, number> = {};
  return {
    from: vi.fn((table: string) => {
      const entry = map[table];
      if (!entry) throw new Error(`unexpected from(${table})`);
      if (Array.isArray(entry)) {
        const i = counters[table] ?? 0;
        counters[table] = i + 1;
        return entry[Math.min(i, entry.length - 1)];
      }
      return entry;
    })
  };
}

const emptyList = () => chain("limit", { data: [], error: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVpsReadMode).mockResolvedValue(false);
  vi.mocked(readMovedRows).mockResolvedValue([]);
  vi.mocked(restoreContentRows).mockResolvedValue({ central: 1, box: null });
});

describe("listDeletedItems (central mode)", () => {
  it("maps every table into typed, summarized items, newest deletion first", async () => {
    const db = dbByTable({
      notifications: chain("limit", {
        data: [
          {
            id: "n1",
            summary: "Missed call from +1555",
            kind: "urgent_alert",
            deleted_at: "2026-07-10T00:00:00Z",
            deleted_by: "u1"
          }
        ],
        error: null
      }),
      email_log: chain("limit", {
        data: [
          {
            id: "e1",
            direction: "inbound",
            subject: "Quote please",
            from_email: "jane@x.com",
            to_email: null,
            deleted_at: "2026-07-12T00:00:00Z",
            deleted_by: null
          }
        ],
        error: null
      }),
      voice_call_transcripts: chain("limit", {
        data: [
          {
            id: "t1",
            caller_e164: "+1555",
            direction: "inbound",
            status: "completed",
            started_at: "2026-07-01T10:00:00Z",
            deleted_at: "2026-07-11T00:00:00Z",
            deleted_by: "u1"
          }
        ],
        error: null
      }),
      dashboard_chat_threads: chain("limit", {
        data: [
          { id: "th1", title: null, deleted_at: "2026-07-09T00:00:00Z", deleted_by: "u1" }
        ],
        error: null
      }),
      sms_outbound_log: chain("limit", {
        data: [
          { id: "o1", to_e164: "+1555", deleted_at: "2026-07-08T00:00:00Z", deleted_by: "u1" },
          { id: "o2", to_e164: "+1555", deleted_at: "2026-07-13T00:00:00Z", deleted_by: "u2" }
        ],
        error: null
      }),
      sms_inbound_jobs: chain("limit", {
        data: [
          { id: "j1", customer_e164: "+1555", deleted_at: "2026-07-07T00:00:00Z", deleted_by: "u1" },
          // Legacy row without the denormalized column — folded via its
          // payload, the same identification the reader and delete use.
          {
            id: "j2",
            customer_e164: null,
            payload: { data: { payload: { from: { phone_number: "+1555" }, text: "old" } } },
            deleted_at: "2026-07-07T00:00:00Z",
            deleted_by: "u1"
          },
          // Unparseable legacy row (no payload) — nothing to fold it into.
          { id: "j3", customer_e164: null, deleted_at: "2026-07-07T00:00:00Z", deleted_by: "u1" }
        ],
        error: null
      })
    });

    const items = await listDeletedItems(BIZ, { client: db as never });
    expect(items.map((i) => i.type)).toEqual([
      "sms_conversation",
      "email",
      "call",
      "notification",
      "chat_thread"
    ]);
    const sms = items[0];
    // 2 outbound + 1 inbound + 1 legacy inbound folded; newest stamp wins
    // the sort key.
    expect(sms).toMatchObject({
      id: "+1555",
      rowCount: 4,
      deletedAt: "2026-07-13T00:00:00Z",
      deletedBy: "u2",
      summary: "SMS conversation with +1555 (4 messages)"
    });
    expect(items[1].summary).toBe("Received email: Quote please — jane@x.com");
    expect(items[2].summary).toContain("Inbound call with +1555 · completed · 2026-07-01");
    expect(items[3].summary).toBe("Missed call from +1555");
    expect(items[4].summary).toBe("Chat: Untitled conversation");
  });

  it("covers the fallback summary arms (kind, outbound email, unknown caller)", async () => {
    const db = dbByTable({
      notifications: chain("limit", {
        data: [
          { id: "n1", summary: null, kind: "digest", deleted_at: "2026-07-01T00:00:00Z", deleted_by: null },
          { id: "n2", summary: null, kind: null, deleted_at: "2026-07-01T00:00:01Z", deleted_by: null }
        ],
        error: null
      }),
      email_log: chain("limit", {
        data: [
          {
            id: "e1",
            direction: "outbound",
            subject: null,
            from_email: null,
            to_email: "lead@x.com",
            deleted_at: "2026-07-02T00:00:00Z",
            deleted_by: null
          },
          {
            id: "e2",
            direction: "outbound",
            subject: "s",
            from_email: null,
            to_email: null,
            deleted_at: "2026-07-02T00:00:01Z",
            deleted_by: null
          }
        ],
        error: null
      }),
      voice_call_transcripts: chain("limit", {
        data: [
          {
            id: "t1",
            caller_e164: null,
            direction: "outbound",
            status: null,
            started_at: null,
            deleted_at: "2026-07-03T00:00:00Z",
            deleted_by: null
          }
        ],
        error: null
      }),
      dashboard_chat_threads: chain("limit", {
        data: [{ id: "th1", title: "Named", deleted_at: "2026-07-03T00:00:00Z", deleted_by: null }],
        error: null
      }),
      sms_outbound_log: emptyList(),
      sms_inbound_jobs: chain("limit", { data: null, error: null })
    });

    const items = await listDeletedItems(BIZ, { client: db as never });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("n1")?.summary).toBe("digest");
    expect(byId.get("n2")?.summary).toBe("Notification");
    expect(byId.get("e1")?.summary).toBe("Sent email: (no subject) — lead@x.com");
    expect(byId.get("e2")?.summary).toBe("Sent email: s");
    expect(byId.get("t1")?.summary).toBe("Outbound call (unknown caller) · unknown");
    expect(byId.get("th1")?.summary).toBe("Chat: Named");
    // Two identical-timestamp items exercise the comparator's equal arm.
    expect(items).toHaveLength(6);
  });

  it("treats null central data as empty and pluralizes a single-message conversation", async () => {
    const db = dbByTable({
      notifications: chain("limit", { data: null, error: null }),
      email_log: emptyList(),
      voice_call_transcripts: emptyList(),
      dashboard_chat_threads: emptyList(),
      sms_outbound_log: chain("limit", {
        data: [{ id: "o1", to_e164: "+1555", deleted_at: "2026-07-01T00:00:00Z", deleted_by: null }],
        error: null
      }),
      sms_inbound_jobs: emptyList()
    });
    const items = await listDeletedItems(BIZ, { client: db as never });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("SMS conversation with +1555 (1 message)");
  });

  it("throws on a central table read error and on an inbound-jobs error", async () => {
    const db = dbByTable({
      notifications: chain("limit", { data: null, error: { message: "boom" } }),
      email_log: emptyList(),
      voice_call_transcripts: emptyList(),
      dashboard_chat_threads: emptyList(),
      sms_outbound_log: emptyList(),
      sms_inbound_jobs: emptyList()
    });
    await expect(listDeletedItems(BIZ, { client: db as never })).rejects.toThrow(
      "listDeletedItems(notifications): boom"
    );

    const db2 = dbByTable({
      notifications: emptyList(),
      email_log: emptyList(),
      voice_call_transcripts: emptyList(),
      dashboard_chat_threads: emptyList(),
      sms_outbound_log: emptyList(),
      sms_inbound_jobs: chain("limit", { data: null, error: { message: "jobs down" } })
    });
    await expect(listDeletedItems(BIZ, { client: db2 as never })).rejects.toThrow(
      "listDeletedItems(sms_inbound_jobs): jobs down"
    );
  });

  it("uses the default service client when none is injected", async () => {
    const db = dbByTable({
      notifications: emptyList(),
      email_log: emptyList(),
      voice_call_transcripts: emptyList(),
      dashboard_chat_threads: emptyList(),
      sms_outbound_log: emptyList(),
      sms_inbound_jobs: emptyList()
    });
    defaultClientSpy.mockReturnValue(db);
    await expect(listDeletedItems(BIZ)).resolves.toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("listDeletedItems (vps mode)", () => {
  it("reads the four moved tables from the box with the gt-epoch stamp filter; chat + inbound stay central", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockImplementation(async (_biz, req) => {
      if ((req as { table: string }).table === "email_log") {
        return [
          {
            id: "e-box",
            direction: "outbound",
            subject: "box row",
            to_email: "x@y.com",
            from_email: null,
            deleted_at: "2026-07-05T00:00:00Z",
            deleted_by: null
          }
        ] as never;
      }
      return [] as never;
    });
    const db = dbByTable({
      dashboard_chat_threads: emptyList(),
      sms_inbound_jobs: emptyList()
    });

    const items = await listDeletedItems(BIZ, { client: db as never });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "email", id: "e-box" });

    const movedTables = vi.mocked(readMovedRows).mock.calls.map(
      (c) => (c[1] as { table: string }).table
    );
    expect(movedTables.sort()).toEqual([
      "email_log",
      "notifications",
      "sms_outbound_log",
      "voice_call_transcripts"
    ]);
    for (const call of vi.mocked(readMovedRows).mock.calls) {
      expect((call[1] as { filters: unknown[] }).filters).toEqual([
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "gt", value: "1970-01-01T00:00:00Z" }
      ]);
    }
    // Chat threads and inbound jobs never route to the box.
    expect(db.from).toHaveBeenCalledWith("dashboard_chat_threads");
    expect(db.from).toHaveBeenCalledWith("sms_inbound_jobs");
  });
});

describe("restoreDeletedItem", () => {
  it("restores single-row types via restoreContentRows on the right table", async () => {
    const db = dbByTable({});
    for (const [type, table] of [
      ["notification", "notifications"],
      ["email", "email_log"],
      ["call", "voice_call_transcripts"],
      ["chat_thread", "dashboard_chat_threads"]
    ] as const) {
      vi.mocked(restoreContentRows).mockClear();
      const result = await restoreDeletedItem(BIZ, type, "row-1", { client: db as never });
      expect(result).toEqual({ restored: 1 });
      expect(restoreContentRows).toHaveBeenCalledWith(
        BIZ,
        table,
        [{ column: "id", op: "eq", value: "row-1" }],
        { client: db }
      );
    }
  });

  it("counts the box side when central rows were purged (vps mode)", async () => {
    vi.mocked(restoreContentRows).mockResolvedValue({ central: 0, box: 2 });
    const result = await restoreDeletedItem(BIZ, "email", "e1", { client: dbByTable({}) as never });
    expect(result).toEqual({ restored: 2 });
  });

  it("forwards an injected dataApiFor to the restore helper", async () => {
    const dataApiFor = vi.fn();
    await restoreDeletedItem(BIZ, "call", "t1", {
      client: dbByTable({}) as never,
      dataApiFor: dataApiFor as never
    });
    expect(restoreContentRows).toHaveBeenCalledWith(
      BIZ,
      "voice_call_transcripts",
      [{ column: "id", op: "eq", value: "t1" }],
      { client: expect.anything(), dataApiFor }
    );
  });

  it("sms_conversation clears outbound (via helper) + inbound jobs incl. paged legacy rows", async () => {
    vi.mocked(restoreContentRows).mockResolvedValue({ central: 2, box: null });
    const byColumn = chain("select", { data: [{ id: "j1" }], error: null });
    const legacyPayload = {
      data: { payload: { from: { phone_number: "+1555" }, text: "old" } }
    };
    const otherPayload = { data: { payload: { from: { phone_number: "+1999" }, text: "x" } } };
    const legacyPage = chain("range", {
      data: [
        { id: "legacy-1", payload: legacyPayload },
        { id: "other", payload: otherPayload }
      ],
      error: null
    });
    const legacyUpdate = chain("select", { data: [{ id: "legacy-1" }], error: null });
    const db = dbByTable({ sms_inbound_jobs: [byColumn, legacyPage, legacyUpdate] });

    const result = await restoreDeletedItem(BIZ, "sms_conversation", "+1555", {
      client: db as never
    });
    // 2 outbound + 1 by-column inbound + 1 legacy inbound.
    expect(result).toEqual({ restored: 4 });
    expect(restoreContentRows).toHaveBeenCalledWith(
      BIZ,
      "sms_outbound_log",
      [{ column: "to_e164", op: "eq", value: "+1555" }],
      expect.objectContaining({ client: db })
    );
    expect(byColumn.update).toHaveBeenCalledWith({ deleted_at: null, deleted_by: null });
    expect(legacyUpdate.in).toHaveBeenCalledWith("id", ["legacy-1"]);
  });

  it("sms_conversation tolerates null page data and a null legacy-update result", async () => {
    vi.mocked(restoreContentRows).mockResolvedValue({ central: 0, box: null });
    const byColumn = chain("select", { data: null, error: null });
    const nullPage = chain("range", { data: null, error: null });
    const db = dbByTable({ sms_inbound_jobs: [byColumn, nullPage] });
    await expect(
      restoreDeletedItem(BIZ, "sms_conversation", "+1555", { client: db as never })
    ).resolves.toEqual({ restored: 0 });

    const byColumn2 = chain("select", { data: [], error: null });
    const pageWithLegacy = chain("range", {
      data: [
        { id: "legacy-1", payload: { data: { payload: { from: "+1555", text: "old" } } } }
      ],
      error: null
    });
    const nullLegacyUpdate = chain("select", { data: null, error: null });
    const db2 = dbByTable({ sms_inbound_jobs: [byColumn2, pageWithLegacy, nullLegacyUpdate] });
    await expect(
      restoreDeletedItem(BIZ, "sms_conversation", "+1555", { client: db2 as never })
    ).resolves.toEqual({ restored: 0 });
  });

  it("sms_conversation pages through a full legacy page before stopping", async () => {
    vi.mocked(restoreContentRows).mockResolvedValue({ central: 0, box: null });
    const byColumn = chain("select", { data: null, error: null });
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      id: `other-${i}`,
      payload: { data: { payload: { from: { phone_number: "+1999" }, text: "x" } } }
    }));
    const legacyPage = chain("range", [
      { data: fullPage, error: null },
      { data: [], error: null }
    ]);
    const db = dbByTable({ sms_inbound_jobs: [byColumn, legacyPage, legacyPage] });
    const result = await restoreDeletedItem(BIZ, "sms_conversation", "+1555", {
      client: db as never
    });
    expect(result).toEqual({ restored: 0 });
    expect(legacyPage.range).toHaveBeenCalledTimes(2);
  });

  it("sms_conversation surfaces inbound update / legacy page / legacy update errors", async () => {
    const failingUpdate = chain("select", { data: null, error: { message: "upd" } });
    await expect(
      restoreDeletedItem(BIZ, "sms_conversation", "+1555", {
        client: dbByTable({ sms_inbound_jobs: [failingUpdate] }) as never
      })
    ).rejects.toThrow("restoreDeletedItem(sms_inbound_jobs): upd");

    const okUpdate = chain("select", { data: [], error: null });
    const failingPage = chain("range", { data: null, error: { message: "page" } });
    await expect(
      restoreDeletedItem(BIZ, "sms_conversation", "+1555", {
        client: dbByTable({ sms_inbound_jobs: [okUpdate, failingPage] }) as never
      })
    ).rejects.toThrow("restoreDeletedItem(sms_inbound_jobs legacy): page");

    const okUpdate2 = chain("select", { data: [], error: null });
    const pageWithLegacy = chain("range", {
      data: [
        {
          id: "legacy-1",
          payload: { data: { payload: { from: "+1555", text: "old" } } }
        }
      ],
      error: null
    });
    const failingLegacyUpdate = chain("select", { data: null, error: { message: "lupd" } });
    await expect(
      restoreDeletedItem(BIZ, "sms_conversation", "+1555", {
        client: dbByTable({
          sms_inbound_jobs: [okUpdate2, pageWithLegacy, failingLegacyUpdate]
        }) as never
      })
    ).rejects.toThrow("restoreDeletedItem(sms_inbound_jobs legacy): lupd");
  });

  it("uses the default service client when none is injected", async () => {
    defaultClientSpy.mockReturnValue(dbByTable({}));
    const result = await restoreDeletedItem(BIZ, "notification", "n1");
    expect(result).toEqual({ restored: 1 });
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
