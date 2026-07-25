import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  findLiveWaitlistEntriesForAttendee,
  getWaitlistSettings,
  listExpiredWaitlistOffers,
  listLapsedWaitlistEntries,
  listLiveWaitlistEntries,
  markWaitlistOffered,
  revertWaitlistOfferToWaiting,
  setWaitlistStatus,
  updateWaitlistBookingLink,
  upsertLiveWaitlistEntry,
  WAITLIST_DEFAULT_DURATION_MINUTES,
  WAITLIST_DEFAULT_OFFER_TTL_MINUTES,
  type BookingWaitlistRow
} from "@/lib/db/booking-waitlist";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * booking_waitlist accessors: one live row per (business, phone), guarded
 * writes (compare-and-set offer claims), and fail-soft reads for the
 * lifecycle hooks.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";

type Scripted = { data?: unknown; error?: { code?: string; message: string } | null };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of [
      "insert",
      "select",
      "update",
      "delete",
      "eq",
      "in",
      "or",
      "lte",
      "gte",
      "order",
      "limit",
      "range"
    ]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = () => Promise.resolve(next());
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

function scriptClient(results: Scripted[]) {
  const { db, calls } = makeDb(results);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
  return calls;
}

function brokenClient() {
  vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("db down"));
}

function row(overrides: Partial<BookingWaitlistRow> = {}): BookingWaitlistRow {
  return {
    id: "wl-1",
    business_id: BIZ,
    phone: "+15485773546",
    email: null,
    name: null,
    duration_minutes: 30,
    earliest_at: "2026-07-01T00:00:00Z",
    latest_at: null,
    current_booking_start_at: null,
    current_event_id: null,
    status: "waiting",
    offered_start_at: null,
    offered_end_at: null,
    offer_expires_at: null,
    last_offered_start_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWaitlistSettings", () => {
  it("reads the Bookings settings row", async () => {
    scriptClient([
      { data: { waitlist_enabled: false, waitlist_offer_ttl_minutes: 30 }, error: null }
    ]);
    expect(await getWaitlistSettings(BIZ)).toEqual({ enabled: false, offerTtlMinutes: 30 });
  });

  it("normalizes null/invalid columns to the defaults", async () => {
    scriptClient([
      { data: { waitlist_enabled: null, waitlist_offer_ttl_minutes: 0 }, error: null }
    ]);
    expect(await getWaitlistSettings(BIZ)).toEqual({
      enabled: true,
      offerTtlMinutes: WAITLIST_DEFAULT_OFFER_TTL_MINUTES
    });
  });

  it("answers the defaults on a missing row, a read error, and a thrown client", async () => {
    scriptClient([{ data: null, error: null }]);
    expect(await getWaitlistSettings(BIZ)).toEqual({
      enabled: true,
      offerTtlMinutes: WAITLIST_DEFAULT_OFFER_TTL_MINUTES
    });

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect((await getWaitlistSettings(BIZ)).enabled).toBe(true);

    brokenClient();
    expect((await getWaitlistSettings(BIZ)).enabled).toBe(true);
  });
});

describe("upsertLiveWaitlistEntry", () => {
  it("refreshes an existing live row in place (created false)", async () => {
    const existing = row({ status: "offered" });
    const calls = scriptClient([{ data: existing, error: null }]);
    const res = await upsertLiveWaitlistEntry(BIZ, {
      phone: " +15485773546 ",
      email: "A@B.Co",
      name: " Pat ",
      durationMinutes: 45,
      latestAtIso: "2026-08-04T15:00:00Z",
      currentBookingStartAtIso: "2026-08-04T15:00:00Z",
      currentEventId: "evt-9"
    });
    expect(res).toEqual({ row: existing, created: false });
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({
      email: "a@b.co",
      name: "Pat",
      duration_minutes: 45,
      latest_at: "2026-08-04T15:00:00Z",
      current_booking_start_at: "2026-08-04T15:00:00Z",
      current_event_id: "evt-9"
    });
  });

  it("inserts a fresh row when no live one exists (created true, defaults applied)", async () => {
    const created = row();
    const calls = scriptClient([
      { data: null, error: null },
      { data: created, error: null }
    ]);
    const res = await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546" });
    expect(res).toEqual({ row: created, created: true });
    const insert = calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toMatchObject({
      business_id: BIZ,
      phone: "+15485773546",
      duration_minutes: WAITLIST_DEFAULT_DURATION_MINUTES,
      latest_at: null,
      current_booking_start_at: null,
      current_event_id: null
    });
    // email/name were not provided, so the columns are untouched.
    expect(insert?.args[0]).not.toHaveProperty("email");
  });

  it("normalizes explicitly provided blank email/name to null", async () => {
    const calls = scriptClient([{ data: row(), error: null }]);
    await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546", email: "  ", name: "" });
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ email: null, name: null });
  });

  it("normalizes explicit empty/null identity fields to null columns", async () => {
    const calls = scriptClient([{ data: row(), error: null }]);
    await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546", email: null, name: "  " });
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ email: null, name: null });
  });

  it("re-refreshes after a unique-violation insert race", async () => {
    const winner = row();
    scriptClient([
      { data: null, error: null },
      { data: null, error: { code: "23505", message: "dup" } },
      { data: winner, error: null }
    ]);
    expect(await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546" })).toEqual({
      row: winner,
      created: false
    });
  });

  it("answers null on non-unique insert errors and thrown clients", async () => {
    scriptClient([
      { data: null, error: null },
      { data: null, error: { code: "57014", message: "canceled" } }
    ]);
    expect(await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546" })).toBeNull();

    brokenClient();
    expect(await upsertLiveWaitlistEntry(BIZ, { phone: "+15485773546" })).toBeNull();
  });
});

describe("listLiveWaitlistEntries", () => {
  it("lists waiting/offered rows oldest first", async () => {
    const rows = [row(), row({ id: "wl-2", status: "offered" })];
    const calls = scriptClient([{ data: rows, error: null }]);
    expect(await listLiveWaitlistEntries(BIZ)).toEqual(rows);
    const inFilter = calls.find((c) => c.name === "in");
    expect(inFilter?.args).toEqual(["status", ["waiting", "offered"]]);
  });

  it("defaults a null payload to [] and throws on a read error", async () => {
    scriptClient([{ data: null, error: null }]);
    expect(await listLiveWaitlistEntries(BIZ)).toEqual([]);

    scriptClient([{ data: null, error: { message: "boom" } }]);
    await expect(listLiveWaitlistEntries(BIZ)).rejects.toThrow("listLiveWaitlistEntries");
  });
});

describe("findLiveWaitlistEntriesForAttendee", () => {
  it("matches digit-tolerant phones and lower-cased emails", async () => {
    const byPhone = row({ phone: "+15485773546" });
    const byEmail = row({ id: "wl-2", phone: "+15005550000", email: "pat@acme.co" });
    const neither = row({ id: "wl-3", phone: "+15005559999", email: "other@acme.co" });
    // Email null on the row: the comparison runs against "" and misses.
    const noEmail = row({ id: "wl-4", phone: "+15005558888", email: null });
    scriptClient([{ data: [byPhone, byEmail, neither, noEmail], error: null }]);
    const found = await findLiveWaitlistEntriesForAttendee(BIZ, {
      // National formatting still matches the stored E.164.
      phones: ["(548) 577-3546"],
      email: "PAT@Acme.Co"
    });
    expect(found.map((r) => r.id)).toEqual(["wl-1", "wl-2"]);
  });

  it("pages through EVERY live row so a customer past the first page still resolves", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      row({ id: `filler-${i}`, phone: `+1500555${String(i).padStart(4, "0")}` })
    );
    const target = row({ id: "wl-target", phone: "+15485773546" });
    scriptClient([
      { data: fullPage, error: null },
      { data: [target], error: null }
    ]);
    const found = await findLiveWaitlistEntriesForAttendee(BIZ, {
      phones: ["+15485773546"]
    });
    expect(found.map((r) => r.id)).toEqual(["wl-target"]);
  });

  it("answers [] with no identifiers matched, a null payload, and on any read error", async () => {
    scriptClient([{ data: [row()], error: null }]);
    expect(
      await findLiveWaitlistEntriesForAttendee(BIZ, { phones: [], email: null })
    ).toEqual([]);

    scriptClient([{ data: null, error: null }]);
    expect(
      await findLiveWaitlistEntriesForAttendee(BIZ, { phones: ["+15485773546"] })
    ).toEqual([]);

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect(
      await findLiveWaitlistEntriesForAttendee(BIZ, { phones: ["+15485773546"] })
    ).toEqual([]);
  });
});

describe("markWaitlistOffered", () => {
  const OFFER = {
    startIso: "2026-08-01T16:00:00.000Z",
    endIso: "2026-08-01T16:30:00.000Z",
    expiresAtIso: "2026-08-01T17:00:00.000Z"
  };

  it("compare-and-sets waiting → offered", async () => {
    const calls = scriptClient([{ data: { id: "wl-1" }, error: null }]);
    expect(await markWaitlistOffered("wl-1", OFFER)).toBe(true);
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({
      status: "offered",
      offered_start_at: OFFER.startIso,
      offered_end_at: OFFER.endIso,
      offer_expires_at: OFFER.expiresAtIso,
      last_offered_start_at: OFFER.startIso
    });
    const statusEq = calls.filter((c) => c.name === "eq").map((c) => c.args);
    expect(statusEq).toContainEqual(["status", "waiting"]);
  });

  it("answers false when the row was not waiting, on errors, and on a thrown client", async () => {
    scriptClient([{ data: null, error: null }]);
    expect(await markWaitlistOffered("wl-1", OFFER)).toBe(false);

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect(await markWaitlistOffered("wl-1", OFFER)).toBe(false);

    brokenClient();
    expect(await markWaitlistOffered("wl-1", OFFER)).toBe(false);
  });
});

describe("revertWaitlistOfferToWaiting", () => {
  it("clears the offer hold; clearLastOffered wipes the slot memory too", async () => {
    let calls = scriptClient([{ data: null, error: null }]);
    await revertWaitlistOfferToWaiting("wl-1");
    let update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ status: "waiting", offered_start_at: null });
    expect(update?.args[0]).not.toHaveProperty("last_offered_start_at");

    calls = scriptClient([{ data: null, error: null }]);
    await revertWaitlistOfferToWaiting("wl-1", { clearLastOffered: true });
    update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ last_offered_start_at: null });
  });

  it("swallows a thrown client (best-effort)", async () => {
    brokenClient();
    await expect(revertWaitlistOfferToWaiting("wl-1")).resolves.toBeUndefined();
  });
});

describe("setWaitlistStatus / updateWaitlistBookingLink", () => {
  it("moves live rows to a terminal status", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await setWaitlistStatus("wl-1", "fulfilled");
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ status: "fulfilled" });
    const inFilter = calls.find((c) => c.name === "in");
    expect(inFilter?.args).toEqual(["status", ["waiting", "offered"]]);
  });

  it("re-points the linked booking, with and without an event id", async () => {
    let calls = scriptClient([{ data: null, error: null }]);
    await updateWaitlistBookingLink("wl-1", {
      currentBookingStartAtIso: "2026-08-02T16:00:00Z",
      currentEventId: "evt-2"
    });
    let update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({
      current_booking_start_at: "2026-08-02T16:00:00Z",
      current_event_id: "evt-2"
    });

    calls = scriptClient([{ data: null, error: null }]);
    await updateWaitlistBookingLink("wl-1", {
      currentBookingStartAtIso: "2026-08-02T16:00:00Z"
    });
    update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).not.toHaveProperty("current_event_id");
    expect(update?.args[0]).not.toHaveProperty("latest_at");

    // A booking-derived window rides along when the caller passes it.
    calls = scriptClient([{ data: null, error: null }]);
    await updateWaitlistBookingLink("wl-1", {
      currentBookingStartAtIso: "2026-08-02T16:00:00Z",
      latestAtIso: "2026-08-02T16:00:00Z"
    });
    update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ latest_at: "2026-08-02T16:00:00Z" });
  });

  it("both swallow thrown clients (best-effort)", async () => {
    brokenClient();
    await expect(setWaitlistStatus("wl-1", "expired")).resolves.toBeUndefined();
    await expect(
      updateWaitlistBookingLink("wl-1", { currentBookingStartAtIso: "2026-08-02T16:00:00Z" })
    ).resolves.toBeUndefined();
  });
});

describe("sweep listings", () => {
  it("lists expired offers and lapsed entries; both throw on read errors", async () => {
    const offers = [row({ status: "offered", offer_expires_at: "2026-07-01T01:00:00Z" })];
    scriptClient([{ data: offers, error: null }]);
    expect(await listExpiredWaitlistOffers("2026-07-01T02:00:00Z")).toEqual(offers);

    const lapsed = [row({ current_booking_start_at: "2026-06-30T00:00:00Z" })];
    scriptClient([{ data: lapsed, error: null }]);
    expect(await listLapsedWaitlistEntries("2026-07-01T02:00:00Z")).toEqual(lapsed);

    // Null payloads default to [].
    scriptClient([{ data: null, error: null }]);
    expect(await listExpiredWaitlistOffers("2026-07-01T02:00:00Z")).toEqual([]);
    scriptClient([{ data: null, error: null }]);
    expect(await listLapsedWaitlistEntries("2026-07-01T02:00:00Z")).toEqual([]);

    scriptClient([{ data: null, error: { message: "boom" } }]);
    await expect(listExpiredWaitlistOffers("2026-07-01T02:00:00Z")).rejects.toThrow(
      "listExpiredWaitlistOffers"
    );
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await expect(listLapsedWaitlistEntries("2026-07-01T02:00:00Z")).rejects.toThrow(
      "listLapsedWaitlistEntries"
    );
  });
});
