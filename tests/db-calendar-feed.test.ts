/**
 * Tests for the calendar-feed token store and the feed's ledger read
 * (src/lib/db/calendar-feed.ts).
 *
 * The mint race is the piece worth pinning hard: two dashboard loads must
 * hand out the SAME URL, or half the owner's devices subscribe to a token
 * that the other half's mint just replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  CALENDAR_FEED_HORIZON_DAYS,
  CALENDAR_FEED_MAX_EVENTS,
  CALENDAR_FEED_TOKEN_REGEX,
  ensureCalendarFeedToken,
  findBusinessByCalendarFeedToken,
  listFeedBookings,
  mintCalendarFeedToken,
  parseCalendarFeedToken,
  rotateCalendarFeedToken
} from "@/lib/db/calendar-feed";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = `ncbf_${"a".repeat(64)}`;

type Step = { data?: unknown; error?: { message: string } | null };

/**
 * Scripted chain: each terminal call (maybeSingle / awaited
 * insert / awaited update) consumes the next step in order.
 */
function scriptedDb(steps: Step[]) {
  let i = 0;
  const next = () => Promise.resolve(steps[i++] ?? { data: null, error: null });
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = vi.fn(self);
  c.eq = vi.fn(self);
  c.gte = vi.fn(self);
  c.not = vi.fn(self);
  c.lte = vi.fn(self);
  c.order = vi.fn(self);
  c.limit = vi.fn(next);
  c.maybeSingle = vi.fn(next);
  c.insert = vi.fn(next);
  c.update = vi.fn(self);
  c.then = (resolve: (v: unknown) => unknown) => next().then(resolve);
  return { db: { from: vi.fn(() => c) } as never, chain: c };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("token shape", () => {
  it("mints ncbf_ + 64 hex and the regex agrees", () => {
    const t = mintCalendarFeedToken();
    expect(t).toMatch(CALENDAR_FEED_TOKEN_REGEX);
    expect(mintCalendarFeedToken()).not.toBe(t);
  });

  it("parses a bare token and one with the .ics suffix apps require", () => {
    expect(parseCalendarFeedToken(TOKEN)).toBe(TOKEN);
    expect(parseCalendarFeedToken(`${TOKEN}.ics`)).toBe(TOKEN);
    expect(parseCalendarFeedToken(`  ${TOKEN}.ics  `)).toBe(TOKEN);
  });

  it("fails closed on garbage without a DB round-trip", () => {
    for (const bad of [null, 7, "", "ncbf_short", `ncb_${"a".repeat(64)}`, `${TOKEN}x`]) {
      expect(parseCalendarFeedToken(bad)).toBeNull();
    }
  });
});

describe("ensureCalendarFeedToken", () => {
  it("returns the stored token without minting", async () => {
    const { db, chain } = scriptedDb([{ data: { token: TOKEN }, error: null }]);
    await expect(ensureCalendarFeedToken(BIZ, db)).resolves.toBe(TOKEN);
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("mints on first ask", async () => {
    const { db } = scriptedDb([
      { data: null, error: null }, // read: nothing yet
      { error: null } // insert ok
    ]);
    const token = await ensureCalendarFeedToken(BIZ, db);
    expect(token).toMatch(CALENDAR_FEED_TOKEN_REGEX);
  });

  it("hands the RACE LOSER the winner's token, not a second one", async () => {
    // Two dashboard loads must give out the same URL.
    const { db } = scriptedDb([
      { data: null, error: null }, // read: nothing yet
      { error: { message: "duplicate key" } }, // insert loses the race
      { data: { token: TOKEN }, error: null } // re-read the winner
    ]);
    await expect(ensureCalendarFeedToken(BIZ, db)).resolves.toBe(TOKEN);
  });

  it("surfaces the insert failure when the re-read finds nothing either", async () => {
    const { db } = scriptedDb([
      { data: null, error: null },
      { error: { message: "insert boom" } },
      { data: null, error: null }
    ]);
    await expect(ensureCalendarFeedToken(BIZ, db)).rejects.toThrow(/insert boom/);
  });

  it("surfaces a read error", async () => {
    const { db } = scriptedDb([{ data: null, error: { message: "read boom" } }]);
    await expect(ensureCalendarFeedToken(BIZ, db)).rejects.toThrow(/read boom/);
  });
});

describe("rotateCalendarFeedToken", () => {
  it("ensures the row exists, then replaces the token", async () => {
    const { db, chain } = scriptedDb([
      { data: { token: TOKEN }, error: null }, // ensure: row exists
      { error: null } // update ok
    ]);
    const fresh = await rotateCalendarFeedToken(BIZ, db);
    expect(fresh).toMatch(CALENDAR_FEED_TOKEN_REGEX);
    expect(fresh).not.toBe(TOKEN);
    expect(chain.update).toHaveBeenCalled();
  });

  it("surfaces an update failure", async () => {
    const { db } = scriptedDb([
      { data: { token: TOKEN }, error: null },
      { error: { message: "update boom" } }
    ]);
    await expect(rotateCalendarFeedToken(BIZ, db)).rejects.toThrow(/update boom/);
  });
});

describe("findBusinessByCalendarFeedToken", () => {
  it("resolves the owning business, and null for a rotated token", async () => {
    const hit = scriptedDb([{ data: { business_id: BIZ }, error: null }]);
    await expect(findBusinessByCalendarFeedToken(TOKEN, hit.db)).resolves.toBe(BIZ);
    const miss = scriptedDb([{ data: null, error: null }]);
    await expect(findBusinessByCalendarFeedToken(TOKEN, miss.db)).resolves.toBeNull();
  });

  it("surfaces a read error", async () => {
    const { db } = scriptedDb([{ data: null, error: { message: "boom" } }]);
    await expect(findBusinessByCalendarFeedToken(TOKEN, db)).rejects.toThrow(/boom/);
  });
});

describe("listFeedBookings", () => {
  const NOW = Date.parse("2026-08-04T12:00:00.000Z");

  it("reads a bounded upcoming window ordered by start", async () => {
    const rows = [{ id: "r1", start_at: "2026-08-05T17:00:00Z" }];
    const { db, chain } = scriptedDb([{ data: rows, error: null }]);
    await expect(listFeedBookings(BIZ, NOW, db)).resolves.toEqual(rows);
    // Confirmed rows only: an in-flight claim (event_id null) must never
    // render as an appointment for subscribers.
    expect(chain.not).toHaveBeenCalledWith("event_id", "is", null);
    expect(chain.gte).toHaveBeenCalledWith("start_at", new Date(NOW).toISOString());
    expect(chain.lte).toHaveBeenCalledWith(
      "start_at",
      new Date(NOW + CALENDAR_FEED_HORIZON_DAYS * 86_400_000).toISOString()
    );
    expect(chain.limit).toHaveBeenCalledWith(CALENDAR_FEED_MAX_EVENTS);
  });

  it("returns empty for a null payload and surfaces errors", async () => {
    const empty = scriptedDb([{ data: null, error: null }]);
    await expect(listFeedBookings(BIZ, NOW, empty.db)).resolves.toEqual([]);
    const err = scriptedDb([{ data: null, error: { message: "boom" } }]);
    await expect(listFeedBookings(BIZ, NOW, err.db)).rejects.toThrow(/listFeedBookings: boom/);
  });
});

describe("default client", () => {
  it("falls back to the service client on every helper", async () => {
    const { db } = scriptedDb([
      { data: { token: TOKEN }, error: null }, // ensure read
      { data: { business_id: BIZ }, error: null }, // find
      { data: [], error: null }, // list
      { data: { token: TOKEN }, error: null }, // rotate: ensure read
      { error: null } // rotate: update
    ]);
    defaultClientSpy.mockReturnValue(db);
    await ensureCalendarFeedToken(BIZ);
    await findBusinessByCalendarFeedToken(TOKEN);
    await listFeedBookings(BIZ, Date.now());
    await rotateCalendarFeedToken(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(4);
  });
});
