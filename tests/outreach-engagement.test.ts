import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServiceClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => createSupabaseServiceClient(...a)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  BOOKING_LOOKUP_LIMIT,
  findEngagedProspects,
  hasAdvancedPastContacted,
  prospectContactKey
} from "@/lib/outreach/engagement";

/**
 * Has a prospect already answered us some way other than email?
 *
 * The follow-up is scheduled off silence, and `replied_at` only ever hears
 * inbound mail. These tests are about the two signals that close that gap and
 * about the direction this fails in, which is "do not send".
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const SENT = "2026-08-20T12:00:00Z";
const AFTER = "2026-08-21T09:00:00Z";
const BEFORE = "2026-08-01T09:00:00Z";

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  phone: "(480) 999-5302",
  email: "info@greenmagicpest.com",
  sent_at: SENT,
  ...over
});

/**
 * Chainable fake. `bookings` answers BOTH calendar_booking_dedupe reads (the
 * exact one on attendee_key and the ilike one on attendee_email), `stages` the
 * pipeline_stages read, `contacts` the per-contact tag read. A table set to
 * "error" reports a query error; "null" answers null data with no error.
 */
function makeDb(tables: {
  bookings?: unknown[] | "error" | "null";
  stages?: unknown[] | "error" | "null";
  contacts?: Array<{ tags: string[] | null } | null> | "error";
}) {
  const seenTables: string[] = [];
  const bookingLookups: string[] = [];
  const bookingFilters: unknown[][] = [];
  let contactCall = 0;
  const from = (table: string) => {
    seenTables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "or", "in", "not", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        if (m === "in" || m === "or") bookingLookups.push(String(args[0] ?? ""));
        if (m === "not" && table === "calendar_booking_dedupe") bookingFilters.push(args);
        return builder;
      };
    }
    const resultFor = (): { data: unknown; error: unknown } => {
      if (table === "calendar_booking_dedupe") {
        if (tables.bookings === "error") return { data: null, error: { message: "boom" } };
        if (tables.bookings === "null") return { data: null, error: null };
        return { data: tables.bookings ?? [], error: null };
      }
      if (table === "pipeline_stages") {
        if (tables.stages === "error") return { data: null, error: { message: "boom" } };
        if (tables.stages === "null") return { data: null, error: null };
        return { data: tables.stages ?? [], error: null };
      }
      if (tables.contacts === "error") return { data: null, error: { message: "boom" } };
      const row = (tables.contacts ?? [])[contactCall++] ?? null;
      return { data: row, error: null };
    };
    builder.maybeSingle = async () => resultFor();
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resultFor()).then(resolve);
    return builder;
  };
  return { db: { from } as never, seenTables, bookingLookups, bookingFilters };
}

const CONTACTED_BOARD = [
  { id: "s0", pipeline_id: "p1", name: "New Lead", position: 0 },
  { id: "s1", pipeline_id: "p1", name: "Contacted", position: 1 },
  { id: "s2", pipeline_id: "p1", name: "Engaged", position: 2 },
  { id: "s3", pipeline_id: "p1", name: "Won", position: 4 }
];

beforeEach(() => {
  createSupabaseServiceClient.mockReset();
});

describe("prospectContactKey", () => {
  it("normalizes the loose NANP number the ledger stores", () => {
    // The ledger holds "(480) 999-5302"; contacts are keyed on E.164. Same
    // normalization fireLifecycleStage applies, so this resolves the same
    // contact the Contacted stage was written to.
    expect(prospectContactKey("(480) 999-5302")).toBe("+14809995302");
  });

  it("passes an E.164 number through", () => {
    expect(prospectContactKey("+14809995302")).toBe("+14809995302");
  });

  it("answers null for nothing usable", () => {
    expect(prospectContactKey(null)).toBeNull();
    expect(prospectContactKey("   ")).toBeNull();
    expect(prospectContactKey("not a phone")).toBeNull();
  });
});

describe("hasAdvancedPastContacted", () => {
  const board = CONTACTED_BOARD.map((s) => ({ id: s.id, name: s.name, position: s.position }));

  it("is true past Contacted and false at or before it", () => {
    expect(hasAdvancedPastContacted([board], ["Engaged"])).toBe(true);
    expect(hasAdvancedPastContacted([board], ["Won"])).toBe(true);
    expect(hasAdvancedPastContacted([board], ["Contacted"])).toBe(false);
    expect(hasAdvancedPastContacted([board], ["New Lead"])).toBe(false);
  });

  it("is false for a lead not on the board at all", () => {
    expect(hasAdvancedPastContacted([board], ["VIP"])).toBe(false);
  });

  it("anchors on the Contacted column, not on a fixed position", () => {
    // A board with extra columns in front still compares the right thing.
    const shifted = [
      { id: "a", name: "Imported", position: 0 },
      { id: "b", name: "Screened", position: 1 },
      { id: "c", name: "Contacted", position: 2 },
      { id: "d", name: "Engaged", position: 3 }
    ];
    expect(hasAdvancedPastContacted([shifted], ["Screened"])).toBe(false);
    expect(hasAdvancedPastContacted([shifted], ["Engaged"])).toBe(true);
  });

  it("ignores a board with no Contacted column", () => {
    // Prospecting writes no stage there either, so there is no "past" to be
    // past of. The booking signal stands on its own for that tenant.
    const other = [{ id: "x", name: "Working", position: 0 }];
    expect(hasAdvancedPastContacted([other], ["Working"])).toBe(false);
  });

  it("is true when ANY board says so", () => {
    const other = [{ id: "x", name: "Working", position: 0 }];
    expect(hasAdvancedPastContacted([other, board], ["Won"])).toBe(true);
  });
});

describe("findEngagedProspects: the booking signal", () => {
  it("catches a prospect who took a slot from the link in the pitch", async () => {
    const { db } = makeDb({
      bookings: [
        { attendee_key: "phone:+14809995302", attendee_email: null, created_at: AFTER }
      ]
    });
    const out = await findEngagedProspects(BIZ, [candidate()], db);
    expect(out.engaged.has("p1")).toBe(true);
    expect(out.readFailed).toBe(false);
  });

  it("matches on the address when they booked under a different number", async () => {
    const { db } = makeDb({
      bookings: [
        {
          attendee_key: "phone:+15550000000",
          attendee_email: "Info@GreenMagicPest.com",
          created_at: AFTER
        }
      ]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(true);
  });

  it("matches an email-keyed booking", async () => {
    const { db } = makeDb({
      bookings: [
        {
          attendee_key: "email:info@greenmagicpest.com",
          attendee_email: null,
          created_at: AFTER
        }
      ]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(true);
  });

  it("asks only for CONFIRMED bookings", async () => {
    // A null event_id is an in-flight or abandoned claim, not an
    // appointment: somebody who opened the booking page and gave up leaves
    // one. Counting it would permanently retire a prospect who never booked.
    const { db, bookingFilters } = makeDb({ bookings: [], stages: [] });
    await findEngagedProspects(BIZ, [candidate()], db);
    expect(bookingFilters).toContainEqual(["event_id", "is", null]);
  });

  it("ignores a booking that predates the pitch", async () => {
    // An older booking is a relationship that predates the outreach, not a
    // response to it.
    const { db } = makeDb({
      bookings: [
        { attendee_key: "phone:+14809995302", attendee_email: null, created_at: BEFORE }
      ]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(false);
  });

  it("ignores somebody else's booking", async () => {
    const { db } = makeDb({
      bookings: [
        { attendee_key: "phone:+15550001111", attendee_email: "other@x.com", created_at: AFTER }
      ]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(false);
  });
});

describe("findEngagedProspects: the stage signal", () => {
  it("catches a prospect whose card moved past Contacted", async () => {
    const { db } = makeDb({
      bookings: [],
      stages: CONTACTED_BOARD,
      contacts: [{ tags: ["Won"] }]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(true);
  });

  it("leaves a prospect still sitting at Contacted alone", async () => {
    // Which is where prospecting itself put them, so it is not engagement.
    const { db } = makeDb({
      bookings: [],
      stages: CONTACTED_BOARD,
      contacts: [{ tags: ["Contacted"] }]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.has("p1")).toBe(false);
  });

  it("costs nothing for a tenant with no board", async () => {
    // Boards are optional, which is exactly why the booking signal exists.
    const { db, seenTables } = makeDb({ bookings: [], stages: [] });
    const out = await findEngagedProspects(BIZ, [candidate()], db);
    expect(out.engaged.size).toBe(0);
    expect(out.readFailed).toBe(false);
    expect(seenTables).not.toContain("contacts");
  });

  it("skips a prospect whose phone will not normalize", async () => {
    const { db, seenTables } = makeDb({ bookings: [], stages: CONTACTED_BOARD });
    const out = await findEngagedProspects(
      BIZ,
      [candidate({ phone: "not a phone" })],
      db
    );
    expect(out.engaged.size).toBe(0);
    expect(seenTables).not.toContain("contacts");
  });

  it("treats a contact with no row or no tags as not engaged", async () => {
    const { db } = makeDb({ bookings: [], stages: CONTACTED_BOARD, contacts: [null] });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.size).toBe(0);
  });
});

describe("findEngagedProspects: the fail direction", () => {
  it("reports readFailed when the booking read errors", async () => {
    const out = await findEngagedProspects(BIZ, [candidate()], makeDb({ bookings: "error" }).db);
    expect(out.readFailed).toBe(true);
  });

  it("reports readFailed when the stage read errors", async () => {
    const out = await findEngagedProspects(
      BIZ,
      [candidate()],
      makeDb({ bookings: [], stages: "error" }).db
    );
    expect(out.readFailed).toBe(true);
  });

  it("reports readFailed when a contact read errors", async () => {
    const out = await findEngagedProspects(
      BIZ,
      [candidate()],
      makeDb({ bookings: [], stages: CONTACTED_BOARD, contacts: "error" }).db
    );
    expect(out.readFailed).toBe(true);
  });

  it("reports readFailed when the client cannot be built", async () => {
    createSupabaseServiceClient.mockRejectedValue(new Error("no env"));
    const out = await findEngagedProspects(BIZ, [candidate()]);
    expect(out.readFailed).toBe(true);
    expect(out.engaged.size).toBe(0);
  });

  it("reports readFailed when a read throws outright", async () => {
    const db = {
      from: () => {
        throw new Error("boom");
      }
    } as never;
    expect((await findEngagedProspects(BIZ, [candidate()], db)).readFailed).toBe(true);
  });

  it("touches nothing for an empty batch", async () => {
    const { db, seenTables } = makeDb({});
    const out = await findEngagedProspects(BIZ, [], db);
    expect(out).toEqual({ engaged: new Set(), readFailed: false });
    expect(seenTables).toHaveLength(0);
  });
});

describe("findEngagedProspects: batching", () => {
  it("asks for the whole batch's identifiers in one lookup per column", async () => {
    // Two reads for any batch size, not two per prospect. Keyed rather than
    // scanned, so a tenant's booking volume can never hide a match.
    const { db, seenTables, bookingLookups } = makeDb({
      bookings: [
        { attendee_key: "phone:+14809995302", attendee_email: null, created_at: AFTER }
      ],
      stages: []
    });
    const out = await findEngagedProspects(
      BIZ,
      [
        candidate(),
        candidate({ id: "p2", phone: "(602) 641-8882", email: "info@plumbers.example" })
      ],
      db
    );
    expect(out.engaged.has("p1")).toBe(true);
    expect(out.engaged.has("p2")).toBe(false);
    expect(seenTables.filter((t) => t === "calendar_booking_dedupe")).toHaveLength(2);
    // Both prospects' keys ride the SAME lookup.
    const keyLookup = bookingLookups.find((l) => l === "attendee_key");
    expect(keyLookup).toBeDefined();
  });

  it("matches attendee_email case-insensitively, since bookers type it freely", () => {
    // attendee_key is normalized by bookingAttendeeKey, so `in` matches it.
    // attendee_email keeps whatever casing was typed, so an exact `in` there
    // would silently never fire.
    const { db, bookingLookups } = makeDb({ bookings: [], stages: [] });
    return findEngagedProspects(BIZ, [candidate()], db).then(() => {
      expect(bookingLookups.some((l) => l.includes("attendee_email.ilike."))).toBe(true);
      expect(bookingLookups).toContain("attendee_key");
    });
  });
});

describe("findEngagedProspects: the thin cases", () => {
  it("handles a prospect with no address, no send stamp and a booking anyway", async () => {
    // A row can be thin: the ledger allows a null email and a null sent_at,
    // and neither may crash the check that decides whether to mail.
    const { db } = makeDb({
      bookings: [
        { attendee_key: "phone:+14809995302", attendee_email: null, created_at: AFTER }
      ],
      stages: []
    });
    const out = await findEngagedProspects(
      BIZ,
      [candidate({ email: null, sent_at: null })],
      db
    );
    expect(out.engaged.has("p1")).toBe(true);
    expect(out.readFailed).toBe(false);
  });

  it("ignores a booking row with no attendee key at all", async () => {
    const { db } = makeDb({
      bookings: [{ attendee_key: null, attendee_email: null, created_at: AFTER }],
      stages: []
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.size).toBe(0);
  });

  it("reads null query payloads as empty, not as a failure", async () => {
    // supabase-js can answer with null data and no error.
    const { db } = makeDb({ bookings: "null", stages: "null" });
    const out = await findEngagedProspects(BIZ, [candidate()], db);
    expect(out).toEqual({ engaged: new Set(), readFailed: false });
  });

  it("treats a contact row with null tags as not engaged", async () => {
    const { db } = makeDb({
      bookings: [],
      stages: CONTACTED_BOARD,
      contacts: [{ tags: null }]
    });
    expect((await findEngagedProspects(BIZ, [candidate()], db)).engaged.size).toBe(0);
  });

  it("survives raw thrown values from any of the three reads", async () => {
    for (const target of [
      "calendar_booking_dedupe",
      "pipeline_stages",
      "contacts"
    ] as const) {
      const { db } = makeDb({ bookings: [], stages: CONTACTED_BOARD, contacts: [null] });
      const wrapped = {
        from: (t: string) => {
          if (t === target) {
            throw "raw string";
          }
          return (db as unknown as { from: (t: string) => unknown }).from(t);
        }
      } as never;
      expect((await findEngagedProspects(BIZ, [candidate()], wrapped)).readFailed).toBe(true);
    }
  });

  it("reports readFailed when the client rejects with a raw value", async () => {
    createSupabaseServiceClient.mockRejectedValue("raw string");
    expect((await findEngagedProspects(BIZ, [candidate()])).readFailed).toBe(true);
  });
});

describe("findEngagedProspects: the booking lookup's rails", () => {
  it("holds the batch when a lookup comes back full, rather than assuming no booking", async () => {
    // A cap on a fail-safe check is fail-OPEN if a full page reads as "none
    // found": past the cap a real booking is invisible and the follow-up
    // sends. A full page is an UNKNOWN answer (Bugbot, PR #1571).
    const full = Array.from({ length: BOOKING_LOOKUP_LIMIT }, () => ({
      attendee_key: "phone:+15550001111",
      attendee_email: null,
      created_at: AFTER
    }));
    const { db } = makeDb({ bookings: full, stages: [] });
    const out = await findEngagedProspects(BIZ, [candidate()], db);
    expect(out.readFailed).toBe(true);
  });

  it("asks nothing when the batch carries no usable identifier at all", async () => {
    const { db, seenTables } = makeDb({ bookings: [], stages: [] });
    const out = await findEngagedProspects(
      BIZ,
      [candidate({ phone: null, email: null })],
      db
    );
    expect(out).toEqual({ engaged: new Set(), readFailed: false });
    expect(seenTables).not.toContain("calendar_booking_dedupe");
  });

  it("skips the key lookup when only an address is usable", async () => {
    // A prospect with no phone still has the email arm; the key arm has
    // nothing to ask for beyond the address key, which rides it.
    const { db, bookingLookups } = makeDb({
      bookings: [
        {
          attendee_key: "email:info@greenmagicpest.com",
          attendee_email: null,
          created_at: AFTER
        }
      ],
      stages: []
    });
    const out = await findEngagedProspects(BIZ, [candidate({ phone: null })], db);
    expect(out.engaged.has("p1")).toBe(true);
    expect(bookingLookups).toContain("attendee_key");
  });

  it("skips the email lookup when only a phone is usable", async () => {
    const { db, bookingLookups } = makeDb({
      bookings: [
        { attendee_key: "phone:+14809995302", attendee_email: null, created_at: AFTER }
      ],
      stages: []
    });
    const out = await findEngagedProspects(BIZ, [candidate({ email: null })], db);
    expect(out.engaged.has("p1")).toBe(true);
    expect(bookingLookups.some((l) => l.includes("attendee_email.ilike."))).toBe(false);
  });

  it("ignores an address the filter gate refuses", async () => {
    const { db, seenTables } = makeDb({ bookings: [], stages: [] });
    const out = await findEngagedProspects(
      BIZ,
      [candidate({ phone: null, email: "not an address" })],
      db
    );
    expect(out.engaged.size).toBe(0);
    expect(seenTables).not.toContain("calendar_booking_dedupe");
  });
});
