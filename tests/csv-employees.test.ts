import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  EMPLOYEES_EXPORT_HEADERS,
  employeesCsvTemplate,
  exportEmployeesCsv,
  importEmployeesCsv
} from "../src/lib/csv/employees";
import { parseCsv } from "../src/lib/csv/csv";

/**
 * Coverage for src/lib/csv/employees.ts — mirrors tests/csv-contacts.test.ts
 * (chainable recorded builder popping scripted results).
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown } | (() => never);

function makeDb(results: Scripted[]) {
  const log: { table: string; calls: CallLog[] }[] = [];
  let idx = 0;
  const next = () => {
    const r = results[idx++] ?? { data: null, error: null };
    if (typeof r === "function") r();
    return r as { data?: unknown; error?: unknown };
  };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "or", "order", "range", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown
    ) => {
      let value: unknown;
      try {
        value = next();
      } catch (e) {
        return Promise.reject(e).catch(reject);
      }
      return Promise.resolve(value).then(resolve);
    };
    return builder;
  };
  return { db: { from } as never, log };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    name: "Alex Rivera",
    phone_e164: "+16025551234",
    email: "alex@example.com",
    active: true,
    weekly_schedule: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] },
    preferred_windows: null,
    last_offered_at: "2026-06-01T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportEmployeesCsv", () => {
  it("writes the roster with schedules in compact text form", async () => {
    const { db, log } = makeDb([
      {
        data: [
          memberRow(),
          memberRow({
            id: "m-2",
            name: "Sam",
            phone_e164: "+16025555678",
            email: null,
            active: false,
            weekly_schedule: null,
            preferred_windows: { sat: [["10:00", "14:00"]] },
            last_offered_at: null
          })
        ],
        error: null
      }
    ]);
    const csv = await exportEmployeesCsv(BIZ, db);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([...EMPLOYEES_EXPORT_HEADERS]);
    expect(parsed.rows[0]).toMatchObject({
      name: "Alex Rivera",
      phone: "+16025551234",
      active: "true",
      weekly_schedule: "mon-tue 09:00-17:00",
      preferred_times: ""
    });
    expect(parsed.rows[1]).toMatchObject({
      name: "Sam",
      email: "",
      active: "false",
      weekly_schedule: "",
      preferred_times: "sat 10:00-14:00",
      last_offered_at: ""
    });
    expect(log[0].table).toBe("ai_flow_team_members");
    expect(log[0].calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
  });

  it("treats null data as an empty roster", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    const parsed = parseCsv(await exportEmployeesCsv(BIZ, db));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(0);
  });

  it("throws on a query error", async () => {
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    await expect(exportEmployeesCsv(BIZ, db)).rejects.toThrow("exportEmployeesCsv: boom");
  });

  it("falls back to the default service client when none is passed", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    defaultClientSpy.mockReturnValue(db);
    await exportEmployeesCsv(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });
});

describe("employeesCsvTemplate", () => {
  it("has the importable headers and one example row", () => {
    const parsed = parseCsv(employeesCsvTemplate());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([
      "name",
      "phone",
      "email",
      "active",
      "weekly_schedule",
      "preferred_times"
    ]);
    expect(parsed.rows[0].weekly_schedule).toBe("mon-fri 09:00-17:00");
  });
});

describe("importEmployeesCsv", () => {
  it("reports a structural parse failure as a row-0 error", async () => {
    const { db } = makeDb([]);
    const summary = await importEmployeesCsv(BIZ, 'name\n"Alex', db);
    expect(summary.errors[0].row).toBe(0);
  });

  it("requires the name and phone columns", async () => {
    const { db } = makeDb([]);
    const missingName = await importEmployeesCsv(BIZ, "phone\n+16025551234", db);
    expect(missingName.errors).toEqual([{ row: 1, message: 'Missing required column: "name".' }]);
    const missingPhone = await importEmployeesCsv(BIZ, "name\nAlex", db);
    expect(missingPhone.errors).toEqual([
      { row: 1, message: 'Missing required column: "phone".' }
    ]);
  });

  it("rejects files over the row cap", async () => {
    const lines = ["name,phone", ...Array.from({ length: 2001 }, () => "Alex,+16025551234")];
    const { db } = makeDb([]);
    const summary = await importEmployeesCsv(BIZ, lines.join("\n"), db);
    expect(summary.errors[0].message).toMatch(/Too many rows/);
  });

  it("creates a new member with parsed schedules and active flag", async () => {
    const { db, log } = makeDb([
      { data: null, error: null }, // lookup: none
      { data: null, error: null } // insert ok
    ]);
    const summary = await importEmployeesCsv(
      BIZ,
      "name,phone,email,active,weekly_schedule,preferred_times\n" +
        "Alex,602-555-1234,alex@example.com,yes,mon-fri 09:00-17:00,mon 09:00-12:00",
      db
    );
    expect(summary).toMatchObject({ totalRows: 1, created: 1, updated: 0, skipped: 0 });
    const insert = log[1].calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toMatchObject({
      business_id: BIZ,
      name: "Alex",
      phone_e164: "+16025551234",
      email: "alex@example.com",
      active: true,
      weekly_schedule: {
        mon: [["09:00", "17:00"]],
        tue: [["09:00", "17:00"]],
        wed: [["09:00", "17:00"]],
        thu: [["09:00", "17:00"]],
        fri: [["09:00", "17:00"]]
      },
      preferred_windows: { mon: [["09:00", "12:00"]] }
    });
  });

  it("creates with nulls when optional cells are blank", async () => {
    const { db, log } = makeDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const summary = await importEmployeesCsv(BIZ, "name,phone\nAlex,+16025551234", db);
    expect(summary.created).toBe(1);
    const insert = log[1].calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toEqual({
      business_id: BIZ,
      name: "Alex",
      phone_e164: "+16025551234",
      email: null,
      weekly_schedule: null,
      preferred_windows: null
    });
  });

  it("updates an existing member by phone, leaving blank cells untouched", async () => {
    const { db, log } = makeDb([
      { data: { id: "m-1" }, error: null },
      { data: null, error: null }
    ]);
    const summary = await importEmployeesCsv(
      BIZ,
      "name,phone,email,active,weekly_schedule,preferred_times\nAlex Rivera,+16025551234,,false,,",
      db
    );
    expect(summary.updated).toBe(1);
    expect(log[0].calls.find((c) => c.name === "eq" && c.args[0] === "phone_e164")?.args).toEqual([
      "phone_e164",
      "+16025551234"
    ]);
    const patch = log[1].calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch).toEqual({ name: "Alex Rivera", active: false });
  });

  it("updates schedules and email when provided", async () => {
    const { db, log } = makeDb([
      { data: { id: "m-1" }, error: null },
      { data: null, error: null }
    ]);
    await importEmployeesCsv(
      BIZ,
      "name,phone,email,weekly_schedule,preferred_times\n" +
        "Alex,+16025551234,alex@example.com,sat 10:00-14:00,sat 10:00-12:00",
      db
    );
    const patch = log[1].calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch).toMatchObject({
      email: "alex@example.com",
      weekly_schedule: { sat: [["10:00", "14:00"]] },
      preferred_windows: { sat: [["10:00", "12:00"]] }
    });
  });

  it("skips rows with a missing name, bad phone, short code, bad email, bad active, or bad schedule", async () => {
    const { db } = makeDb([]);
    const summary = await importEmployeesCsv(
      BIZ,
      [
        "name,phone,email,active,weekly_schedule,preferred_times",
        ",+16025551234,,,,", // no name
        "Alex,not-a-phone,,,,", // unparseable phone
        "Alex,55555,,,,", // short code normalizes but isn't dialable E.164
        "Alex,+16025551234,bad-email,,,", // bad email
        "Alex,+16025551234,,maybe,,", // bad active
        "Alex,+16025551234,,,someday,", // bad weekly schedule
        "Alex,+16025551234,,,,25:00-26:00" // bad preferred times
      ].join("\n"),
      db
    );
    expect(summary).toMatchObject({ totalRows: 7, created: 0, updated: 0, skipped: 7 });
    expect(summary.errors.map((e) => e.message.split(":")[0])).toEqual([
      "name",
      "phone",
      "phone",
      "email",
      "active",
      "weekly_schedule",
      "preferred_times"
    ]);
  });

  it("reports lookup, update, and insert errors per row and keeps going", async () => {
    const { db } = makeDb([
      { data: null, error: { message: "select down" } },
      { data: { id: "m-1" }, error: null },
      { data: null, error: { message: "update down" } },
      { data: null, error: null },
      { data: null, error: { message: "insert down" } }
    ]);
    const summary = await importEmployeesCsv(
      BIZ,
      "name,phone\nA,+16025551111\nB,+16025552222\nC,+16025553333",
      db
    );
    expect(summary).toMatchObject({ totalRows: 3, skipped: 3 });
    expect(summary.errors).toEqual([
      { row: 2, message: "select down" },
      { row: 3, message: "update down" },
      { row: 4, message: "insert down" }
    ]);
  });

  it("labels a non-Error throw as unexpected", async () => {
    const { db } = makeDb([
      () => {
        throw "string failure";
      }
    ]);
    const summary = await importEmployeesCsv(BIZ, "name,phone\nAlex,+16025551234", db);
    expect(summary.errors).toEqual([{ row: 2, message: "Unexpected error" }]);
  });

  it("accepts explicit false-y active spellings", async () => {
    const { db, log } = makeDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    await importEmployeesCsv(BIZ, "name,phone,active\nAlex,+16025551234,0", db);
    const insert = log[1].calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toMatchObject({ active: false });
  });

  it("falls back to the default service client when none is passed", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const summary = await importEmployeesCsv(BIZ, "name,phone\nAlex,+16025551234");
    expect(summary.created).toBe(1);
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });
});
