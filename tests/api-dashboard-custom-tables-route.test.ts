import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireBusinessRole: vi.fn(),
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/custom-tables/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/custom-tables/db")>();
  return {
    CustomTableError: actual.CustomTableError,
    listCustomTables: vi.fn(),
    listDeletedCustomTables: vi.fn(),
    countRowsByTable: vi.fn(),
    createCustomTable: vi.fn(),
    getCustomTable: vi.fn(),
    patchCustomTableFields: vi.fn(),
    updateCustomTableDetails: vi.fn(),
    softDeleteCustomTable: vi.fn(),
    restoreCustomTable: vi.fn(),
    createCustomTableRow: vi.fn(),
    updateCustomTableRow: vi.fn(),
    deleteCustomTableRow: vi.fn(),
    listCustomTableRowsWithContacts: vi.fn(),
    attachContacts: vi.fn(),
    listCustomTableRows: vi.fn()
  };
});

vi.mock("@/lib/custom-tables/versions", () => ({
  listCustomTableVersions: vi.fn(),
  restoreCustomTableVersion: vi.fn()
}));

import { GET, POST } from "@/app/api/dashboard/custom-tables/route";
import {
  DELETE as TABLE_DELETE,
  GET as TABLE_GET,
  PATCH as TABLE_PATCH,
  POST as TABLE_RESTORE
} from "@/app/api/dashboard/custom-tables/[tableId]/route";
import {
  GET as ROWS_GET,
  POST as ROWS_POST
} from "@/app/api/dashboard/custom-tables/[tableId]/rows/route";
import {
  DELETE as ROW_DELETE,
  PATCH as ROW_PATCH
} from "@/app/api/dashboard/custom-tables/[tableId]/rows/[rowId]/route";
import {
  GET as VERSIONS_GET,
  POST as VERSIONS_POST
} from "@/app/api/dashboard/custom-tables/[tableId]/versions/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  CustomTableError,
  attachContacts,
  countRowsByTable,
  createCustomTable,
  createCustomTableRow,
  deleteCustomTableRow,
  getCustomTable,
  listCustomTableRows,
  listCustomTableRowsWithContacts,
  listCustomTables,
  listDeletedCustomTables,
  patchCustomTableFields,
  restoreCustomTable,
  softDeleteCustomTable,
  updateCustomTableDetails,
  updateCustomTableRow
} from "@/lib/custom-tables/db";
import { listCustomTableVersions, restoreCustomTableVersion } from "@/lib/custom-tables/versions";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";
const ROW_ID = "33333333-3333-4333-8333-333333333333";

const USER = { userId: "u-1", email: "owner@example.com", isAdmin: false };

const FIELD = {
  id: "address",
  label: "Address",
  type: "text" as const,
  required: false,
  enabled: true
};

const TABLE = {
  id: TABLE_ID,
  businessId: BIZ,
  name: "Properties",
  description: null,
  icon: "home" as const,
  rowLink: "standalone" as const,
  fields: [FIELD],
  position: 0,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z"
};

const ROW = {
  id: ROW_ID,
  tableId: TABLE_ID,
  contactId: null,
  values: { address: "12 Maple St" },
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  contactName: null,
  contactE164: null
};

const listUrl = (biz = BIZ) => `http://x/api/dashboard/custom-tables?businessId=${biz}`;
const tableUrl = (biz = BIZ) =>
  `http://x/api/dashboard/custom-tables/${TABLE_ID}?businessId=${biz}`;
const rowsUrl = (query = "") =>
  `http://x/api/dashboard/custom-tables/${TABLE_ID}/rows?businessId=${BIZ}${query}`;
const rowUrl = () =>
  `http://x/api/dashboard/custom-tables/${TABLE_ID}/rows/${ROW_ID}?businessId=${BIZ}`;
const versionsUrl = () =>
  `http://x/api/dashboard/custom-tables/${TABLE_ID}/versions?businessId=${BIZ}`;

const tableParams = () => ({ params: Promise.resolve({ tableId: TABLE_ID }) });
const rowParams = () => ({ params: Promise.resolve({ tableId: TABLE_ID, rowId: ROW_ID }) });

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function patch(url: string, body: unknown) {
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(USER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(getCustomTable).mockResolvedValue(TABLE as never);
  vi.mocked(listCustomTables).mockResolvedValue([TABLE] as never);
  vi.mocked(listDeletedCustomTables).mockResolvedValue([] as never);
  vi.mocked(countRowsByTable).mockResolvedValue(new Map([[TABLE_ID, 3]]));
  vi.mocked(createCustomTable).mockResolvedValue(TABLE as never);
  vi.mocked(updateCustomTableDetails).mockResolvedValue(TABLE as never);
  vi.mocked(patchCustomTableFields).mockResolvedValue({ table: TABLE, sweptRows: 0 } as never);
  vi.mocked(restoreCustomTable).mockResolvedValue(TABLE as never);
  vi.mocked(attachContacts).mockImplementation(
    (async (_b: string, rows: unknown[]) =>
      rows.map((r) => ({ ...(r as object), contactName: null, contactE164: null }))) as never
  );
  vi.mocked(listCustomTableRowsWithContacts).mockResolvedValue({
    rows: [ROW],
    nextCursor: null
  } as never);
  vi.mocked(listCustomTableRows).mockResolvedValue({ rows: [ROW], nextCursor: null } as never);
  vi.mocked(createCustomTableRow).mockResolvedValue(ROW as never);
  vi.mocked(updateCustomTableRow).mockResolvedValue(ROW as never);
  vi.mocked(listCustomTableVersions).mockResolvedValue([] as never);
  vi.mocked(restoreCustomTableVersion).mockResolvedValue({ kind: "schema" } as never);
});

describe("the authorization bar, which a refactor must not quietly move", () => {
  it("gates DEFINING a table at manage_settings, the schema bar", async () => {
    await POST(post(listUrl(), { name: "Vehicles", fields: [{ label: "Name", type: "text" }] }));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");

    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(getCustomTable).mockResolvedValue(TABLE as never);
    vi.mocked(updateCustomTableDetails).mockResolvedValue(TABLE as never);
    await TABLE_PATCH(patch(tableUrl(), { action: "rename", name: "Listings" }), tableParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("gates FILLING one in at operate_messages, the data-entry bar", async () => {
    // Anything higher would mean staff can text a customer but not log the
    // call, which is the wrong way round.
    await ROWS_POST(post(rowsUrl(), { values: {} }), tableParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");

    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(getCustomTable).mockResolvedValue(TABLE as never);
    vi.mocked(updateCustomTableRow).mockResolvedValue(ROW as never);
    await ROW_PATCH(patch(rowUrl(), { values: { address: "x" } }), rowParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");

    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(getCustomTable).mockResolvedValue(TABLE as never);
    await ROW_DELETE(new Request(rowUrl(), { method: "DELETE" }), rowParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");
  });

  it("gates READING at view_dashboard, so staff can see the data", async () => {
    await GET(new Request(listUrl()));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");

    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(getCustomTable).mockResolvedValue(TABLE as never);
    vi.mocked(attachContacts).mockImplementation(
    (async (_b: string, rows: unknown[]) =>
      rows.map((r) => ({ ...(r as object), contactName: null, contactE164: null }))) as never
  );
  vi.mocked(listCustomTableRowsWithContacts).mockResolvedValue({
      rows: [],
      nextCursor: null
    } as never);
    await ROWS_GET(new Request(rowsUrl()), tableParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");
  });

  it("gates restoring at manage_settings, because an undo can revive a whole table", async () => {
    await VERSIONS_POST(post(versionsUrl(), { versionId: 5 }), tableParams());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });
});

describe("GET /api/dashboard/custom-tables", () => {
  it("returns tables with their row counts", async () => {
    const res = await GET(new Request(listUrl()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tables).toHaveLength(1);
    expect(body.data.rowCounts).toEqual({ [TABLE_ID]: 3 });
  });

  it("returns the trash to anyone who can read the tables", async () => {
    // Gating the QUERY on admin put the safety net out of reach of the
    // owner, who is the person most likely to need it: the coworker can
    // delete a table on request. The directory hides the restore CONTROL
    // from people who cannot use it; the data itself is the same tenant's.
    vi.mocked(listDeletedCustomTables).mockResolvedValue([
      { ...TABLE, id: "trashed", deletedAt: "2026-08-20T00:00:00.000Z" }
    ] as never);
    const res = await GET(new Request(listUrl()));
    expect(listDeletedCustomTables).toHaveBeenCalledWith(BIZ);
    expect((await res.json()).data.deleted).toHaveLength(1);
  });

  it("refuses without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await GET(new Request(listUrl()))).status).toBe(401);
  });

  it("refuses a non-uuid business", async () => {
    expect((await GET(new Request(listUrl("nope")))).status).toBe(400);
  });

  it("skips the role check for an admin", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...USER, isAdmin: true } as never);
    await GET(new Request(listUrl()));
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/custom-tables", () => {
  it("generates the column ids rather than trusting the client", async () => {
    // Ids are what every stored row keys on, so a caller-chosen one could
    // silently point at another column's data.
    await POST(
      post(listUrl(), {
        name: "Vehicles",
        fields: [
          { label: "Make and model", type: "text" },
          { label: "Status", type: "select", options: ["New", "Won"] }
        ]
      })
    );
    expect(createCustomTable).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        fields: [
          expect.objectContaining({ id: "make_and_model", label: "Make and model" }),
          expect.objectContaining({ id: "status", options: ["New", "Won"] })
        ]
      })
    );
  });

  it("defaults the row link to standalone", async () => {
    await POST(post(listUrl(), { name: "V", fields: [{ label: "Name", type: "text" }] }));
    expect(createCustomTable).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ rowLink: "standalone", createdBy: "u-1" })
    );
  });

  it("refuses a body the schema rejects", async () => {
    expect((await POST(post(listUrl(), { name: "", fields: [] }))).status).toBe(400);
  });

  it.each([
    ["limit", 400],
    ["duplicate", 400],
    ["not_found", 404]
  ])("maps a %s failure onto the right status", async (code, status) => {
    vi.mocked(createCustomTable).mockRejectedValue(new CustomTableError(code as never, "no"));
    const res = await POST(post(listUrl(), { name: "V", fields: [{ label: "N", type: "text" }] }));
    expect(res.status).toBe(status);
  });

  it("lets an unexpected error fall through to the handler", async () => {
    vi.mocked(createCustomTable).mockRejectedValue(new Error("boom"));
    const res = await POST(post(listUrl(), { name: "V", fields: [{ label: "N", type: "text" }] }));
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/dashboard/custom-tables/[tableId]", () => {
  it.each([
    ["rename", { action: "rename", name: "Listings" }],
    ["update_details", { action: "update_details", description: "New", icon: "home" }]
  ])("routes the %s action to the details path", async (_label, body) => {
    const res = await TABLE_PATCH(patch(tableUrl(), body), tableParams());
    expect(res.status).toBe(200);
    expect(updateCustomTableDetails).toHaveBeenCalled();
  });

  it.each([
    ["add_field", { action: "add_field", field: { label: "Price", type: "number" } }, "add"],
    ["update_field", { action: "update_field", fieldId: "address", required: true }, "update"],
    ["reorder_fields", { action: "reorder_fields", fieldIds: ["address"] }, "reorder"],
    ["delete_field", { action: "delete_field", fieldId: "address" }, "remove"]
  ])("routes the %s action to the field path", async (_label, body, expected) => {
    const res = await TABLE_PATCH(patch(tableUrl(), body), tableParams());
    expect(res.status).toBe(200);
    expect(patchCustomTableFields).toHaveBeenCalledWith(
      BIZ,
      TABLE_ID,
      expect.objectContaining({ action: expected }),
      expect.anything()
    );
  });

  it("reports how many rows the column sweep touched", async () => {
    vi.mocked(patchCustomTableFields).mockResolvedValue({ table: TABLE, sweptRows: 7 } as never);
    const res = await TABLE_PATCH(
      patch(tableUrl(), { action: "delete_field", fieldId: "address" }),
      tableParams()
    );
    expect((await res.json()).data.swept).toBe(7);
  });

  it("refuses an unknown action, a non-uuid table, and a missing session", async () => {
    expect((await TABLE_PATCH(patch(tableUrl(), { action: "explode" }), tableParams())).status).toBe(
      400
    );
    expect(
      (
        await TABLE_PATCH(patch(tableUrl(), { action: "rename", name: "x" }), {
          params: Promise.resolve({ tableId: "nope" })
        })
      ).status
    ).toBe(400);
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect(
      (await TABLE_PATCH(patch(tableUrl(), { action: "rename", name: "x" }), tableParams())).status
    ).toBe(401);
  });

  it("maps a typed failure and lets anything else fall through", async () => {
    vi.mocked(updateCustomTableDetails).mockRejectedValue(
      new CustomTableError("not_found", "gone")
    );
    expect(
      (await TABLE_PATCH(patch(tableUrl(), { action: "rename", name: "x" }), tableParams())).status
    ).toBe(404);
    vi.mocked(updateCustomTableDetails).mockRejectedValue(new Error("boom"));
    expect(
      (await TABLE_PATCH(patch(tableUrl(), { action: "rename", name: "x" }), tableParams())).status
    ).toBe(500);
  });
});

describe("DELETE and restore", () => {
  it("soft deletes, recording who did it", async () => {
    const res = await TABLE_DELETE(new Request(tableUrl(), { method: "DELETE" }), tableParams());
    expect(res.status).toBe(200);
    expect(softDeleteCustomTable).toHaveBeenCalledWith(BIZ, TABLE_ID, "u-1", {
      source: "dashboard",
      actor: "owner@example.com"
    });
  });

  it("restores from the trash", async () => {
    const res = await TABLE_RESTORE(new Request(tableUrl(), { method: "POST" }), tableParams());
    expect(res.status).toBe(200);
    expect(restoreCustomTable).toHaveBeenCalledWith(BIZ, TABLE_ID, {
      source: "dashboard_restore",
      actor: "owner@example.com"
    });
  });

  it("maps typed failures and lets anything else fall through", async () => {
    vi.mocked(softDeleteCustomTable).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect(
      (await TABLE_DELETE(new Request(tableUrl(), { method: "DELETE" }), tableParams())).status
    ).toBe(404);
    vi.mocked(softDeleteCustomTable).mockRejectedValue(new Error("boom"));
    expect(
      (await TABLE_DELETE(new Request(tableUrl(), { method: "DELETE" }), tableParams())).status
    ).toBe(500);
    vi.mocked(restoreCustomTable).mockRejectedValue(new CustomTableError("limit", "full"));
    expect(
      (await TABLE_RESTORE(new Request(tableUrl(), { method: "POST" }), tableParams())).status
    ).toBe(400);
    vi.mocked(restoreCustomTable).mockRejectedValue(new Error("boom"));
    expect(
      (await TABLE_RESTORE(new Request(tableUrl(), { method: "POST" }), tableParams())).status
    ).toBe(500);
  });

  it("refuses both without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect(
      (await TABLE_DELETE(new Request(tableUrl(), { method: "DELETE" }), tableParams())).status
    ).toBe(401);
    expect(
      (await TABLE_RESTORE(new Request(tableUrl(), { method: "POST" }), tableParams())).status
    ).toBe(401);
  });
});

describe("GET /api/dashboard/custom-tables/[tableId]", () => {
  it("returns the table, and 404s one that is gone", async () => {
    expect((await TABLE_GET(new Request(tableUrl()), tableParams())).status).toBe(200);
    vi.mocked(getCustomTable).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect((await TABLE_GET(new Request(tableUrl()), tableParams())).status).toBe(404);
    vi.mocked(getCustomTable).mockRejectedValue(new Error("boom"));
    expect((await TABLE_GET(new Request(tableUrl()), tableParams())).status).toBe(500);
  });

  it("refuses without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await TABLE_GET(new Request(tableUrl()), tableParams())).status).toBe(401);
  });
});

describe("rows", () => {
  it("passes the cursor, limit, and contact filter through", async () => {
    await ROWS_GET(
      new Request(rowsUrl(`&limit=50&cursor=abc&contactId=${BIZ}`)),
      tableParams()
    );
    expect(listCustomTableRowsWithContacts).toHaveBeenCalledWith(
      BIZ,
      TABLE_ID,
      TABLE.fields,
      { limit: 50, cursor: "abc", contactId: BIZ }
    );
  });

  it("filters the page by the search text", async () => {
    vi.mocked(attachContacts).mockImplementation(
    (async (_b: string, rows: unknown[]) =>
      rows.map((r) => ({ ...(r as object), contactName: null, contactE164: null }))) as never
  );
  vi.mocked(listCustomTableRowsWithContacts).mockResolvedValue({
      rows: [ROW, { ...ROW, id: "other", values: { address: "9 Oak" } }],
      nextCursor: null
    } as never);
    const res = await ROWS_GET(new Request(rowsUrl("&q=maple")), tableParams());
    const body = await res.json();
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0].id).toBe(ROW_ID);
  });

  it("creates a row from validated values", async () => {
    const res = await ROWS_POST(post(rowsUrl(), { values: { address: "12 Maple St" } }), tableParams());
    expect(res.status).toBe(200);
    expect(createCustomTableRow).toHaveBeenCalledWith(
      BIZ,
      TABLE,
      expect.objectContaining({ values: { address: "12 Maple St" }, contactId: null }),
      { source: "dashboard", actor: "owner@example.com" }
    );
  });

  it("drops a contact on a standalone table, where no reader would look for it", async () => {
    await ROWS_POST(post(rowsUrl(), { values: {}, contactId: BIZ }), tableParams());
    expect(createCustomTableRow).toHaveBeenCalledWith(
      BIZ,
      TABLE,
      expect.objectContaining({ contactId: null }),
      expect.anything()
    );
  });

  it("keeps the contact on a contact-linked table", async () => {
    vi.mocked(getCustomTable).mockResolvedValue({ ...TABLE, rowLink: "contact" } as never);
    await ROWS_POST(post(rowsUrl(), { values: {}, contactId: BIZ }), tableParams());
    expect(createCustomTableRow).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({ contactId: BIZ }),
      expect.anything()
    );
  });

  it("lets a BLANK row be created even when a column is required", async () => {
    // The grid's Add row makes an empty starter row, which a spreadsheet has
    // to allow. Refusing it would mean a table with one required column can
    // never gain a row from the UI at all.
    vi.mocked(getCustomTable).mockResolvedValue({
      ...TABLE,
      fields: [{ ...FIELD, required: true }]
    } as never);
    const res = await ROWS_POST(post(rowsUrl(), { values: {} }), tableParams());
    expect(res.status).toBe(200);
  });

  it("names the failing column in plain English", async () => {
    // A row sent WITH cells is a real submission, so required still holds.
    vi.mocked(getCustomTable).mockResolvedValue({
      ...TABLE,
      fields: [{ ...FIELD, required: true }, { ...FIELD, id: "city", label: "City" }]
    } as never);
    const res = await ROWS_POST(post(rowsUrl(), { values: { city: "Phoenix" } }), tableParams());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Address is required.");
  });

  it("relays a typed failure, and lets anything else fall through", async () => {
    vi.mocked(createCustomTableRow).mockRejectedValue(new CustomTableError("limit", "full"));
    expect((await ROWS_POST(post(rowsUrl(), { values: {} }), tableParams())).status).toBe(400);
    vi.mocked(createCustomTableRow).mockRejectedValue(new Error("boom"));
    expect((await ROWS_POST(post(rowsUrl(), { values: {} }), tableParams())).status).toBe(500);
    vi.mocked(getCustomTable).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect((await ROWS_GET(new Request(rowsUrl()), tableParams())).status).toBe(404);
    vi.mocked(getCustomTable).mockRejectedValue(new Error("boom"));
    expect((await ROWS_GET(new Request(rowsUrl()), tableParams())).status).toBe(500);
  });

  it("refuses both verbs without a session, and a bad filter", async () => {
    expect((await ROWS_GET(new Request(rowsUrl("&limit=999")), tableParams())).status).toBe(400);
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await ROWS_GET(new Request(rowsUrl()), tableParams())).status).toBe(401);
    expect((await ROWS_POST(post(rowsUrl(), { values: {} }), tableParams())).status).toBe(401);
  });
});

describe("one row", () => {
  it("passes the cells to clear through, so a cell can actually be emptied", async () => {
    const res = await ROW_PATCH(patch(rowUrl(), { values: { address: "" } }), rowParams());
    expect(res.status).toBe(200);
    expect(updateCustomTableRow).toHaveBeenCalledWith(
      TABLE,
      ROW_ID,
      expect.objectContaining({ values: {}, clear: ["address"] }),
      { source: "dashboard", actor: "owner@example.com" }
    );
  });

  it("does not join the contact back on after the write has committed", async () => {
    // Joining after the commit means a failed join turns a landed write into
    // a 500, and the grid reverts the cell while the database keeps the new
    // value. The picker already has the name, so nothing needs the join.
    vi.mocked(getCustomTable).mockResolvedValue({ ...TABLE, rowLink: "contact" } as never);
    const res = await ROW_PATCH(patch(rowUrl(), { contactId: BIZ }), rowParams());
    expect(res.status).toBe(200);
    expect(attachContacts).not.toHaveBeenCalled();
  });

  it("can change the contact without touching the cells", async () => {
    vi.mocked(getCustomTable).mockResolvedValue({ ...TABLE, rowLink: "contact" } as never);
    await ROW_PATCH(patch(rowUrl(), { contactId: null }), rowParams());
    const arg = vi.mocked(updateCustomTableRow).mock.calls[0][2];
    expect(arg).toEqual({ values: undefined, clear: undefined, contactId: null });
  });

  it("saves ONE cell on a table that has a required column", async () => {
    // Partial: a column nobody mentioned is a column nobody is touching.
    vi.mocked(getCustomTable).mockResolvedValue({
      ...TABLE,
      fields: [{ ...FIELD, required: true }, { ...FIELD, id: "city", label: "City" }]
    } as never);
    const res = await ROW_PATCH(patch(rowUrl(), { values: { city: "Tempe" } }), rowParams());
    expect(res.status).toBe(200);
  });

  it("names the failing column on a bad cell", async () => {
    const res = await ROW_PATCH(patch(rowUrl(), { values: { address: 7 } }), rowParams());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Address is the wrong kind of value.");
  });

  it("proves the table belongs to this business before deleting a row", async () => {
    // Without this the URL could name another tenant's table id, since the
    // delete itself only scopes to the table.
    const res = await ROW_DELETE(new Request(rowUrl(), { method: "DELETE" }), rowParams());
    expect(res.status).toBe(200);
    expect(getCustomTable).toHaveBeenCalledWith(BIZ, TABLE_ID);
    expect(deleteCustomTableRow).toHaveBeenCalledWith(TABLE_ID, ROW_ID, {
      source: "dashboard",
      actor: "owner@example.com"
    });
  });

  it("maps typed failures and lets anything else fall through", async () => {
    vi.mocked(updateCustomTableRow).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect(
      (await ROW_PATCH(patch(rowUrl(), { values: { address: "x" } }), rowParams())).status
    ).toBe(404);
    vi.mocked(updateCustomTableRow).mockRejectedValue(new Error("boom"));
    expect(
      (await ROW_PATCH(patch(rowUrl(), { values: { address: "x" } }), rowParams())).status
    ).toBe(500);
    vi.mocked(deleteCustomTableRow).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect((await ROW_DELETE(new Request(rowUrl(), { method: "DELETE" }), rowParams())).status).toBe(
      404
    );
    vi.mocked(deleteCustomTableRow).mockRejectedValue(new Error("boom"));
    expect((await ROW_DELETE(new Request(rowUrl(), { method: "DELETE" }), rowParams())).status).toBe(
      500
    );
  });

  it("refuses both verbs without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await ROW_PATCH(patch(rowUrl(), { values: {} }), rowParams())).status).toBe(401);
    expect((await ROW_DELETE(new Request(rowUrl(), { method: "DELETE" }), rowParams())).status).toBe(
      401
    );
  });
});

describe("versions", () => {
  it("hands the builder the live rows, so a row edit is described against today", async () => {
    const res = await VERSIONS_GET(new Request(versionsUrl()), tableParams());
    expect(res.status).toBe(200);
    expect(listCustomTableVersions).toHaveBeenCalledWith(BIZ, TABLE_ID);
    expect(listCustomTableRows).toHaveBeenCalledWith(TABLE_ID, TABLE.fields);
  });

  it("restores a version", async () => {
    const res = await VERSIONS_POST(post(versionsUrl(), { versionId: 5 }), tableParams());
    expect(res.status).toBe(200);
    expect(restoreCustomTableVersion).toHaveBeenCalledWith(BIZ, 5, {
      source: "dashboard_restore",
      actor: "owner@example.com"
    });
  });

  it("refuses a bad version id", async () => {
    expect((await VERSIONS_POST(post(versionsUrl(), { versionId: 0 }), tableParams())).status).toBe(
      400
    );
  });

  it("maps typed failures and lets anything else fall through", async () => {
    vi.mocked(getCustomTable).mockRejectedValue(new CustomTableError("not_found", "gone"));
    expect((await VERSIONS_GET(new Request(versionsUrl()), tableParams())).status).toBe(404);
    vi.mocked(getCustomTable).mockRejectedValue(new Error("boom"));
    expect((await VERSIONS_GET(new Request(versionsUrl()), tableParams())).status).toBe(500);
    vi.mocked(restoreCustomTableVersion).mockRejectedValue(
      new CustomTableError("not_found", "pruned")
    );
    expect(
      (await VERSIONS_POST(post(versionsUrl(), { versionId: 5 }), tableParams())).status
    ).toBe(404);
    vi.mocked(restoreCustomTableVersion).mockRejectedValue(new Error("boom"));
    expect(
      (await VERSIONS_POST(post(versionsUrl(), { versionId: 5 }), tableParams())).status
    ).toBe(500);
  });

  it("refuses both verbs without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await VERSIONS_GET(new Request(versionsUrl()), tableParams())).status).toBe(401);
    expect((await VERSIONS_POST(post(versionsUrl(), { versionId: 5 }), tableParams())).status).toBe(
      401
    );
  });
});
