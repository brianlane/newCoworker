import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service client the functions reach for when a caller does not hand
 * them one. Production takes that path on every call, so it is tested
 * rather than annotated away.
 */
let serviceDb: unknown = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => serviceDb)
}));
import {
  listStaffModes,
  setStaffMode,
  staffModeEnabled
} from "@/lib/owner-surfaces/staff-mode";
import { OWNER_SURFACES } from "@/lib/owner-surfaces/registry";

/**
 * Per-surface staff mode.
 *
 * ON means "answer them as staff". OFF means "do not answer them here". It
 * never means "answer them as a customer", which is the behavior this whole
 * change exists to remove, and it matches what the SMS flag has always
 * meant.
 *
 * A missing row and a failed read both resolve to ENABLED, the same posture
 * getAgentToolStates takes for tool toggles: a transient database blip must
 * not flip behavior away from what the owner configured. That is the safe
 * direction here because the dangerous mistake (treating a stranger as
 * staff) is decided by resolveSurfaceSpeaker, which fails the other way.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  serviceDb = null;
});

type Scripted = { data?: unknown; error?: unknown };

/** Minimal PostgREST chain fake: one scripted result per terminal await. */
function makeDb(results: Scripted[], onUpsert?: (row: unknown) => void) {
  const queue = [...results];
  const pop = () => Promise.resolve(queue.shift() ?? { data: null, error: null });
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = () => builder;
  builder.upsert = (row: unknown) => {
    onUpsert?.(row);
    return builder;
  };
  builder.single = pop;
  builder.maybeSingle = pop;
  builder.then = (res: (v: unknown) => unknown) => pop().then(res);
  return { from: () => builder } as never;
}

describe("staffModeEnabled", () => {
  it("defaults to enabled when the owner has never touched it", async () => {
    const db = makeDb([{ data: null, error: null }]);
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("reads a stored ON", async () => {
    const db = makeDb([{ data: { assistant_reply_enabled: true }, error: null }]);
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("reads a stored OFF", async () => {
    const db = makeDb([{ data: { assistant_reply_enabled: false }, error: null }]);
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(false);
  });

  it("stays ENABLED when the read errors, rather than going silent", async () => {
    // A database blip must not silently stop answering the owner.
    const db = makeDb([{ data: null, error: { message: "boom" } }]);
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("stays ENABLED when the client itself throws", async () => {
    const db = {
      from: () => {
        throw new Error("no connection");
      }
    } as never;
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("ignores a row whose flag is not a boolean", async () => {
    const db = makeDb([{ data: { assistant_reply_enabled: "yes" }, error: null }]);
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("survives a rejection that is not an Error", async () => {
    const db = {
      from: () => {
        throw "connection reset";
      }
    } as never;
    await expect(staffModeEnabled(BIZ, "whatsapp", db)).resolves.toBe(true);
  });

  it("refuses a surface the registry does not know", async () => {
    // A typo here would otherwise read a row nothing ever writes and look
    // like a working default forever.
    await expect(staffModeEnabled(BIZ, "carrier-pigeon" as never)).rejects.toThrow(
      /carrier-pigeon/
    );
  });
});

describe("listStaffModes", () => {
  it("answers for every registered surface, filling defaults", async () => {
    const db = makeDb([
      { data: [{ surface_key: "sms", assistant_reply_enabled: false }], error: null }
    ]);
    const modes = await listStaffModes(BIZ, db);
    expect(Object.keys(modes).sort()).toEqual(OWNER_SURFACES.map((s) => s.key).sort());
    expect(modes.sms).toBe(false);
    expect(modes.whatsapp).toBe(true);
  });

  it("ignores stored rows for surfaces the registry no longer has", async () => {
    const db = makeDb([
      { data: [{ surface_key: "carrier-pigeon", assistant_reply_enabled: false }], error: null }
    ]);
    const modes = await listStaffModes(BIZ, db);
    expect(modes).not.toHaveProperty("carrier-pigeon");
  });

  it("ignores a stored row whose flag is not a boolean", async () => {
    const db = makeDb([
      { data: [{ surface_key: "sms", assistant_reply_enabled: null }], error: null }
    ]);
    expect((await listStaffModes(BIZ, db)).sms).toBe(true);
  });

  it("returns all defaults when the client throws something that is not an Error", async () => {
    const db = {
      from: () => {
        throw "connection reset";
      }
    } as never;
    const modes = await listStaffModes(BIZ, db);
    expect(Object.values(modes).every((v) => v === true)).toBe(true);
  });

  it("returns all defaults when the read fails", async () => {
    const db = makeDb([{ data: null, error: { message: "boom" } }]);
    const modes = await listStaffModes(BIZ, db);
    expect(Object.values(modes).every((v) => v === true)).toBe(true);
  });

  it("returns all defaults when there is nothing stored", async () => {
    const db = makeDb([{ data: null, error: null }]);
    const modes = await listStaffModes(BIZ, db);
    expect(Object.values(modes).every((v) => v === true)).toBe(true);
  });
});

describe("setStaffMode", () => {
  it("upserts the flag and returns what was stored", async () => {
    const seen: unknown[] = [];
    const db = makeDb(
      [{ data: { assistant_reply_enabled: false }, error: null }],
      (row) => seen.push(row)
    );
    await expect(setStaffMode(BIZ, "whatsapp", false, db)).resolves.toBe(false);
    expect(seen[0]).toMatchObject({
      business_id: BIZ,
      surface_key: "whatsapp",
      assistant_reply_enabled: false
    });
  });

  it("throws on a write failure instead of reporting a save that did not happen", async () => {
    // The dashboard toggle rolls back on a rejected save; swallowing the
    // error would leave the switch showing a state the database does not
    // hold.
    const db = makeDb([{ data: null, error: { message: "denied" } }]);
    await expect(setStaffMode(BIZ, "whatsapp", false, db)).rejects.toThrow(/denied/);
  });

  it("refuses a surface the registry does not know", async () => {
    await expect(setStaffMode(BIZ, "carrier-pigeon" as never, true)).rejects.toThrow(
      /carrier-pigeon/
    );
  });
});

describe("the default service client", () => {
  it("is used by every read and write when the caller supplies none", async () => {
    const seen: unknown[] = [];
    serviceDb = makeDb(
      [
        { data: { assistant_reply_enabled: false }, error: null },
        { data: [{ surface_key: "slack", assistant_reply_enabled: false }], error: null },
        { data: { assistant_reply_enabled: true }, error: null }
      ],
      (row) => seen.push(row)
    );
    await expect(staffModeEnabled(BIZ, "whatsapp")).resolves.toBe(false);
    await expect((await listStaffModes(BIZ)).slack).toBe(false);
    await expect(setStaffMode(BIZ, "whatsapp", true)).resolves.toBe(true);
    expect(seen).toHaveLength(1);
  });
});
