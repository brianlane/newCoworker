/**
 * The email coworker's thread ledger: ownership writes (best-effort by
 * design), the active-thread listing the poller works from, the daily turn
 * budget, and the seen ledger that keeps a crash from double-answering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  EMAIL_COWORKER_MAX_TURNS_PER_DAY,
  EMAIL_COWORKER_THREAD_ACTIVE_DAYS,
  filterUnseenMessages,
  listActiveThreads,
  markMessagesSeen,
  markThreadHandedOff,
  recordThreadTurn,
  rememberSentThread,
  turnsToday
} from "@/lib/email-coworker/threads";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rememberSentThread", () => {
  it("upserts ownership keyed on (business, thread), lower casing the correspondent", async () => {
    const calls: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
    const upsert = vi.fn((row, opts) => {
      calls.push([row, opts]);
      return Promise.resolve({ error: null });
    });
    const client = { from: vi.fn(() => ({ upsert })) } as never;
    await rememberSentThread(
      {
        businessId: BIZ,
        provider: "google",
        threadId: "t-1",
        subject: "NC Discovery Call w/ Liz",
        correspondentEmail: "  Beth@LizDev.com ",
        sentMessageRef: "<abc@mail>"
      },
      client
    );
    expect(calls[0][0]).toMatchObject({
      business_id: BIZ,
      provider: "google",
      thread_id: "t-1",
      subject: "NC Discovery Call w/ Liz",
      correspondent_email: "beth@lizdev.com",
      last_sent_message_ref: "<abc@mail>"
    });
    expect(calls[0][1]).toEqual({ onConflict: "business_id,thread_id" });
  });

  it("blanks an empty correspondent and a missing ref rather than storing junk", async () => {
    // Through the DEFAULT service client (the production path); the explicit
    // client parameter is exercised by the tests either side of this one.
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mockClientFactory.mockResolvedValueOnce({ from: vi.fn(() => ({ upsert })) } as never);
    await rememberSentThread({
      businessId: BIZ,
      provider: "microsoft",
      threadId: "t-2",
      correspondentEmail: "   "
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      subject: null,
      correspondent_email: null,
      last_sent_message_ref: null
    });
  });

  it("never throws: a bookkeeping failure must not fail the send that triggered it", async () => {
    const client = {
      from: vi.fn(() => ({ upsert: vi.fn().mockResolvedValue({ error: { message: "denied" } }) }))
    } as never;
    await rememberSentThread({ businessId: BIZ, provider: "google", threadId: "t" }, client);
    expect(logger.warn).toHaveBeenCalledWith(
      "email-coworker: thread ownership write failed",
      expect.objectContaining({ error: "denied" })
    );

    mockClientFactory.mockRejectedValueOnce("factory boom" as never);
    await rememberSentThread({ businessId: BIZ, provider: "google", threadId: "t" });
    expect(logger.warn).toHaveBeenCalledWith(
      "email-coworker: thread ownership write failed",
      expect.objectContaining({ error: "factory boom" })
    );
  });
});

describe("listActiveThreads", () => {
  function listDb(result: { data: unknown; error: { message: string } | null }) {
    const order = vi.fn().mockResolvedValue(result);
    const gte = vi.fn((_col: string, _v: string) => ({ order }));
    const eq = vi.fn((_col: string, _v: boolean) => ({ gte }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return { db: { from } as never, eq, gte };
  }

  it("returns mapped threads, excluding handed-off and stale ones", async () => {
    const { db, eq, gte } = listDb({
      data: [
        {
          id: "row-1",
          business_id: BIZ,
          provider: "google",
          thread_id: "t-1",
          subject: "Discovery",
          correspondent_email: "beth@lizdev.com",
          last_sent_message_ref: "<a@b>",
          turns: 2,
          turns_day: "2026-07-25",
          handed_off: false
        }
      ],
      error: null
    });
    const out = await listActiveThreads(db);
    expect(eq).toHaveBeenCalledWith("handed_off", false);
    const since = new Date(String(gte.mock.calls[0][1])).getTime();
    const expected = Date.now() - EMAIL_COWORKER_THREAD_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(since - expected)).toBeLessThan(5_000);
    expect(out).toEqual([
      {
        id: "row-1",
        businessId: BIZ,
        provider: "google",
        threadId: "t-1",
        subject: "Discovery",
        correspondentEmail: "beth@lizdev.com",
        lastSentMessageRef: "<a@b>",
        turns: 2,
        turnsDay: "2026-07-25",
        handedOff: false
      }
    ]);
  });

  it("maps providers (microsoft kept, anything else read as google) and tolerates an empty result", async () => {
    const row = (provider: string, id: string) => ({
      id,
      business_id: BIZ,
      provider,
      thread_id: "t-2",
      subject: null,
      correspondent_email: null,
      last_sent_message_ref: null,
      turns: 0,
      turns_day: null,
      handed_off: false
    });
    const { db } = listDb({
      data: [row("microsoft", "row-ms"), row("whatever", "row-junk")],
      error: null
    });
    const mapped = await listActiveThreads(db);
    expect(mapped.map((t) => t.provider)).toEqual(["microsoft", "google"]);

    const { db: empty } = listDb({ data: null, error: null });
    expect(await listActiveThreads(empty)).toEqual([]);
  });

  it("throws on a read error (the poller cannot proceed blind)", async () => {
    const { db } = listDb({ data: null, error: { message: "rls" } });
    await expect(listActiveThreads(db)).rejects.toThrow(/listActiveThreads: rls/);
  });

  it("falls back to the service client", async () => {
    const { db } = listDb({ data: [], error: null });
    mockClientFactory.mockResolvedValue(db);
    expect(await listActiveThreads()).toEqual([]);
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("turn budget", () => {
  const base = {
    id: "row-1",
    businessId: BIZ,
    provider: "google" as const,
    threadId: "t-1",
    subject: null,
    correspondentEmail: null,
    lastSentMessageRef: null,
    handedOff: false
  };

  it("counts only turns spent today, so a new day restores the budget", () => {
    expect(turnsToday({ ...base, turns: 3, turnsDay: "2026-07-25" }, "2026-07-25")).toBe(3);
    expect(turnsToday({ ...base, turns: 3, turnsDay: "2026-07-24" }, "2026-07-25")).toBe(0);
    expect(turnsToday({ ...base, turns: 3, turnsDay: null }, "2026-07-25")).toBe(0);
    // Default day argument reads "today".
    const today = new Date().toISOString().slice(0, 10);
    expect(turnsToday({ ...base, turns: 1, turnsDay: today })).toBe(1);
    expect(EMAIL_COWORKER_MAX_TURNS_PER_DAY).toBeGreaterThan(0);
  });

  it("records a turn against the day, stamping the sent ref when there is one", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn((_row: Record<string, unknown>) => ({ eq }));
    const db = { from: vi.fn(() => ({ update })) } as never;
    await recordThreadTurn("row-1", { sentMessageRef: "<x@y>", day: "2026-07-25" }, 2, db);
    expect(update.mock.calls[0][0]).toMatchObject({
      turns: 3,
      turns_day: "2026-07-25",
      last_sent_message_ref: "<x@y>"
    });
    expect(eq).toHaveBeenCalledWith("id", "row-1");

    await recordThreadTurn("row-1", {}, 0, db);
    expect(update.mock.calls[1][0]).not.toHaveProperty("last_sent_message_ref");
    expect(update.mock.calls[1][0]).toMatchObject({ turns: 1 });
  });

  it("throws when the turn write fails, and when the handoff write fails", async () => {
    const failing = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: { message: "nope" } }) }))
      }))
    } as never;
    await expect(recordThreadTurn("row-1", {}, 0, failing)).rejects.toThrow(/recordThreadTurn/);
    await expect(markThreadHandedOff("row-1", failing)).rejects.toThrow(/markThreadHandedOff/);
  });

  it("marks a thread handed off", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn((_row: Record<string, unknown>) => ({ eq }));
    const db = { from: vi.fn(() => ({ update })) } as never;
    await markThreadHandedOff("row-9", db);
    expect(update.mock.calls[0][0]).toMatchObject({ handed_off: true });
    expect(eq).toHaveBeenCalledWith("id", "row-9");
  });

  it("uses the service client and today's date by default", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn((_row: Record<string, unknown>) => ({ eq }));
    mockClientFactory.mockResolvedValue({ from: vi.fn(() => ({ update })) } as never);
    await recordThreadTurn("row-1", {}, 0);
    expect(String(update.mock.calls[0][0].turns_day)).toBe(new Date().toISOString().slice(0, 10));
    await markThreadHandedOff("row-1");
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("seen ledger", () => {
  function seenDb(rows: Array<{ message_id: string }>, error: { message: string } | null = null) {
    const inMessage = vi.fn().mockResolvedValue({ data: rows, error });
    const inChain = vi.fn(() => ({ in: inMessage }));
    const eq = vi.fn(() => ({ in: inMessage }));
    const select = vi.fn(() => ({ eq }));
    const upsert = vi.fn().mockResolvedValue({ error });
    return {
      db: { from: vi.fn(() => ({ select, upsert })) } as never,
      upsert,
      inMessage,
      inChain
    };
  }

  it("returns only unseen ids, chunking large batches", async () => {
    const { db, inMessage } = seenDb([{ message_id: "m-2" }]);
    const ids = Array.from({ length: 150 }, (_, i) => `m-${i}`);
    const out = await filterUnseenMessages(BIZ, ids, db);
    expect(inMessage).toHaveBeenCalledTimes(2); // 150 ids ⇒ chunks of 100
    expect(out).not.toContain("m-2");
    expect(out.length).toBe(ids.length - 1);
  });

  it("short-circuits an empty list, tolerates a null data page, and throws on a read error", async () => {
    const { db, inMessage } = seenDb([]);
    expect(await filterUnseenMessages(BIZ, [], db)).toEqual([]);
    expect(inMessage).not.toHaveBeenCalled();

    // A driver that answers { data: null } must read as "nothing seen".
    const { db: nullData } = seenDb(null as never);
    expect(await filterUnseenMessages(BIZ, ["m-1"], nullData)).toEqual(["m-1"]);

    const { db: failing } = seenDb([], { message: "boom" });
    await expect(filterUnseenMessages(BIZ, ["m-1"], failing)).rejects.toThrow(
      /filterUnseenMessages: boom/
    );
  });

  it("upserts markers ignoring duplicates, and no-ops on an empty list", async () => {
    const { db, upsert } = seenDb([]);
    await markMessagesSeen(BIZ, ["m-1", "m-2"], db);
    expect(upsert).toHaveBeenCalledWith(
      [
        { business_id: BIZ, message_id: "m-1" },
        { business_id: BIZ, message_id: "m-2" }
      ],
      { onConflict: "business_id,message_id", ignoreDuplicates: true }
    );

    upsert.mockClear();
    await markMessagesSeen(BIZ, [], db);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("throws when the marker write fails (a lost marker would double-answer)", async () => {
    const { db } = seenDb([], { message: "denied" });
    await expect(markMessagesSeen(BIZ, ["m-1"], db)).rejects.toThrow(/markMessagesSeen: denied/);
  });

  it("falls back to the service client for both helpers", async () => {
    const { db, upsert } = seenDb([]);
    mockClientFactory.mockResolvedValue(db);
    expect(await filterUnseenMessages(BIZ, ["m-1"])).toEqual(["m-1"]);
    await markMessagesSeen(BIZ, ["m-1"]);
    expect(upsert).toHaveBeenCalled();
  });
});
