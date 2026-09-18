/**
 * Permanent Calendly rejection: flip needs_reauth, email once then once more
 * after a day, stamp last_healthy_at, never flag a sibling healthy account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusinessTimezone: vi.fn(async () => "America/Phoenix")
}));
vi.mock("@/lib/db/calendly-connections", () => ({
  calendlyCalendarPauseState: vi.fn()
}));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn()
}));

import {
  calendlyDashboardPauseCopy,
  listCalendlyReauthBannerState,
  markCalendlyConnectionNeedsReauth,
  processCalendlyReauthReminders,
  stampCalendlyConnectionHealthy
} from "@/lib/calendly/reauth";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { calendlyCalendarPauseState } from "@/lib/db/calendly-connections";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CONN_B = "bbbbbbbb-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-17T02:11:00.000Z");
const CALENDLY_REAUTH_KIND = "calendly_needs_reauth";
const CALENDLY_REAUTH_MAX_EMAILS = 2;
const CALENDLY_REAUTH_REMINDER_MS = 24 * 60 * 60 * 1000;

type Chain = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    update: vi.fn(() => c),
    eq: vi.fn(() => c),
    lt: vi.fn(() => c),
    or: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  };
  return c as never;
}

function makeDb(handler: (table: string) => Chain) {
  return { from: vi.fn((table: string) => handler(table)) } as never;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: CONN_A,
    business_id: BIZ,
    account_name: "James Lee",
    account_email: "james@kyp.test",
    last_healthy_at: "2026-09-16T12:01:00.000Z",
    reauth_email_count: 0,
    reauth_email_last_sent_at: null,
    needs_reauth: false,
    ...over
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchUrgentNotification).mockResolvedValue({
    results: [{ channel: "email", status: "sent", notificationId: "n1" }]
  } as never);
});

describe("markCalendlyConnectionNeedsReauth", () => {
  it("flips the row, emails once, and does not touch a second account", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: row({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: { id: CONN_A }, error: null });
    const db = makeDb((table) => {
      expect(table).toBe("calendly_connections");
      return read.maybeSingle.mock.calls.length === 0 ? read : write;
    });
    // First from() is the read, subsequent are the update + email stamp.
    let calls = 0;
    const sequenced = {
      from: vi.fn(() => {
        calls += 1;
        return calls === 1 ? read : write;
      })
    } as never;

    const result = await markCalendlyConnectionNeedsReauth(CONN_A, {
      client: sequenced,
      now: () => NOW
    });
    expect(result).toEqual({ flipped: true, emailed: true });
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({ needs_reauth: true })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(dispatched.kind).toBe(CALENDLY_REAUTH_KIND);
    expect(dispatched.ctaPath).toContain(CONN_A);
    expect(dispatched.summary).toContain("James Lee");
    expect(dispatched.emailTemplate?.("en").subject).toBe("Calendly needs a reconnect");
    expect(dispatched.emailTemplate?.("en").body).toContain("5:01 AM");
    expect(dispatched.emailTemplate?.("en").body.toLowerCase()).not.toContain("token rejected");
    expect(dispatched.emailTemplate?.("es").body).toContain("5:01");
    expect(getBusinessTimezone).toHaveBeenCalledWith(BIZ);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "calendly_connection_needs_reauth",
        businessId: BIZ
      })
    );
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({ reauth_email_count: 1 })
    );
    expect(write.eq).not.toHaveBeenCalledWith("id", CONN_B);
  });

  it("is a no-op (no second email) when the row is already flagged", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({
      data: row({ needs_reauth: true, reauth_email_count: 1 }),
      error: null
    });
    const result = await markCalendlyConnectionNeedsReauth(CONN_A, {
      client: makeDb(() => read),
      now: () => NOW
    });
    expect(result).toEqual({ flipped: false, emailed: false });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("returns flipped:false when the row is gone", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(
      await markCalendlyConnectionNeedsReauth(CONN_A, { client: makeDb(() => read) })
    ).toEqual({ flipped: false, emailed: false });
  });

  it("throws on a read error", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      markCalendlyConnectionNeedsReauth(CONN_A, { client: makeDb(() => read) })
    ).rejects.toThrow("markCalendlyConnectionNeedsReauth: boom");
  });

  it("throws on a flip write error", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: { message: "locked" } });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(markCalendlyConnectionNeedsReauth(CONN_A, { client: db })).rejects.toThrow(
      "markCalendlyConnectionNeedsReauth: locked"
    );
  });

  it("treats a lost flip race as already flagged", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    expect(await markCalendlyConnectionNeedsReauth(CONN_A, { client: db })).toEqual({
      flipped: false,
      emailed: false
    });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("does not increment the email count when dispatch throws", async () => {
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce(new Error("resend down"));
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: row({ needs_reauth: true }), error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    const result = await markCalendlyConnectionNeedsReauth(CONN_A, { client: db, now: () => NOW });
    expect(result).toEqual({ flipped: true, emailed: false });
    expect(logger.warn).toHaveBeenCalled();
    expect(write.update.mock.calls.some((c) => "reauth_email_count" in (c[0] as object))).toBe(
      false
    );
  });

  it("skips the first email when the row already hit the cap (belt)", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({
      data: row({ needs_reauth: true, reauth_email_count: CALENDLY_REAUTH_MAX_EMAILS }),
      error: null
    });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    const result = await markCalendlyConnectionNeedsReauth(CONN_A, { client: db, now: () => NOW });
    expect(result).toEqual({ flipped: true, emailed: false });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("throws when the email-count stamp matches zero rows", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: row({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(
      markCalendlyConnectionNeedsReauth(CONN_A, { client: db, now: () => NOW })
    ).rejects.toThrow("stampCalendlyReauthEmail: no row updated");
  });

  it("throws when the email-count stamp errors", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: row({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "stamp fail" } });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(
      markCalendlyConnectionNeedsReauth(CONN_A, { client: db, now: () => NOW })
    ).rejects.toThrow("stampCalendlyReauthEmail: stamp fail");
  });

  it("resolves the service client when none is injected", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(() => read));
    expect(await markCalendlyConnectionNeedsReauth(CONN_A)).toEqual({
      flipped: false,
      emailed: false
    });
  });
});

describe("stampCalendlyConnectionHealthy", () => {
  it("stamps last_healthy_at only on a row that is not flagged", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: CONN_A }, error: null });
    await stampCalendlyConnectionHealthy(CONN_A, { client: makeDb(() => c), now: () => NOW });
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_healthy_at: new Date(NOW).toISOString() })
    );
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
    expect(c.eq).toHaveBeenCalledWith("needs_reauth", false);
  });

  it("is a no-op when the row is flagged or gone", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await stampCalendlyConnectionHealthy(CONN_A, { client: makeDb(() => c), now: () => NOW });
  });

  it("throws on a write error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(
      stampCalendlyConnectionHealthy(CONN_A, { client: makeDb(() => c) })
    ).rejects.toThrow("stampCalendlyConnectionHealthy: down");
  });

  it("resolves the service client when none is injected", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(() => c));
    await stampCalendlyConnectionHealthy(CONN_A);
  });
});

describe("processCalendlyReauthReminders", () => {
  it("sends the day-later reminder, then never a third", async () => {
    const list = chain();
    list.limit.mockResolvedValue({
      data: [
        row({
          needs_reauth: true,
          reauth_email_count: 1,
          reauth_email_last_sent_at: new Date(NOW - CALENDLY_REAUTH_REMINDER_MS - 1000).toISOString()
        })
      ],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: CONN_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? list : stamp)) } as never;
    const first = await processCalendlyReauthReminders({ client: db, now: () => NOW });
    expect(first).toEqual({ considered: 1, emailed: 1 });
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);
    expect(stamp.update).toHaveBeenCalledWith(expect.objectContaining({ reauth_email_count: 2 }));
    expect(list.or).toHaveBeenCalledWith(
      expect.stringMatching(/reauth_email_last_sent_at\.lt\."20/)
    );

    // A later tick listing a count=2 row is filtered by the query (lt 2).
    list.limit.mockResolvedValue({ data: [], error: null });
    const later = await processCalendlyReauthReminders({
      client: { from: vi.fn(() => list) } as never,
      now: () => NOW + CALENDLY_REAUTH_REMINDER_MS
    });
    expect(later).toEqual({ considered: 0, emailed: 0 });
  });

  it("does not send the reminder before 24 hours", async () => {
    const list = chain();
    list.limit.mockResolvedValue({
      data: [
        row({
          needs_reauth: true,
          reauth_email_count: 1,
          reauth_email_last_sent_at: new Date(NOW - 23 * 60 * 60 * 1000).toISOString()
        })
      ],
      error: null
    });
    const result = await processCalendlyReauthReminders({
      client: { from: vi.fn(() => list) } as never,
      now: () => NOW
    });
    expect(result.emailed).toBe(0);
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("retries the first email when the flip send never landed (count 0)", async () => {
    const list = chain();
    list.limit.mockResolvedValue({
      data: [row({ needs_reauth: true, reauth_email_count: 0, reauth_email_last_sent_at: null })],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: CONN_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? list : stamp)) } as never;
    const result = await processCalendlyReauthReminders({ client: db, now: () => NOW });
    expect(result.emailed).toBe(1);
    expect(stamp.update).toHaveBeenCalledWith(expect.objectContaining({ reauth_email_count: 1 }));
  });

  it("treats a garbage last_sent_at as due (null-count first email too)", async () => {
    const list = chain();
    list.limit.mockResolvedValue({
      data: [
        row({
          needs_reauth: true,
          reauth_email_count: 1,
          reauth_email_last_sent_at: "not-a-date"
        })
      ],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: CONN_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? list : stamp)) } as never;
    const result = await processCalendlyReauthReminders({ client: db, now: () => NOW });
    expect(result.emailed).toBe(1);
  });

  it("skips a listed row already at the cap and a send that fails", async () => {
    const list = chain();
    list.limit.mockResolvedValue({
      data: [
        row({ id: CONN_B, needs_reauth: true, reauth_email_count: 2 }),
        row({ needs_reauth: true, reauth_email_count: 0 })
      ],
      error: null
    });
    vi.mocked(dispatchUrgentNotification).mockResolvedValueOnce({ results: [] } as never);
    const result = await processCalendlyReauthReminders({
      client: { from: vi.fn(() => list) } as never,
      now: () => NOW
    });
    expect(result).toEqual({ considered: 2, emailed: 0 });
  });

  it("throws on a list error", async () => {
    const list = chain();
    list.limit.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      processCalendlyReauthReminders({ client: { from: vi.fn(() => list) } as never })
    ).rejects.toThrow("processCalendlyReauthReminders: boom");
  });

  it("null-coalesces an empty list and uses the default client", async () => {
    const list = chain();
    list.limit.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue({ from: vi.fn(() => list) });
    expect(await processCalendlyReauthReminders({ now: () => NOW })).toEqual({
      considered: 0,
      emailed: 0
    });
  });
});

describe("listCalendlyReauthBannerState", () => {
  it("returns banner payloads for every flagged connection", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [row({ needs_reauth: true })],
      error: null
    });
    const banners = await listCalendlyReauthBannerState(BIZ, makeDb(() => c));
    expect(banners).toHaveLength(1);
    expect(banners[0].accountLabel).toBe("James Lee");
    expect(banners[0].reconnectPath).toContain(CONN_A);
    expect(banners[0].lastHealthyAt).toBe("2026-09-16T12:01:00.000Z");
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("needs_reauth", true);
  });

  it("empty data is an empty list; errors throw; default client works", async () => {
    const empty = chain();
    empty.limit.mockResolvedValue({ data: null, error: null });
    expect(await listCalendlyReauthBannerState(BIZ, makeDb(() => empty))).toEqual([]);

    const boom = chain();
    boom.limit.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(listCalendlyReauthBannerState(BIZ, makeDb(() => boom))).rejects.toThrow(
      "listCalendlyReauthBannerState: nope"
    );

    defaultClientSpy.mockReturnValue(makeDb(() => empty));
    expect(await listCalendlyReauthBannerState(BIZ)).toEqual([]);
  });
});

describe("reauth email timezone", () => {
  async function flipAndDispatch(over: {
    getTimezone?: (businessId: string) => Promise<string | null>;
  }) {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: row({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: { id: CONN_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await markCalendlyConnectionNeedsReauth(CONN_A, {
      client: db,
      now: () => NOW,
      getTimezone: over.getTimezone
    });
    return vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
  }

  it("falls back to UTC when the business timezone is missing", async () => {
    const dispatched = await flipAndDispatch({ getTimezone: async () => null });
    expect(dispatched.emailTemplate?.("en").body).toContain("12:01 PM");
  });

  it("falls back to UTC when the timezone lookup throws or is blank", async () => {
    const thrown = await flipAndDispatch({
      getTimezone: async () => {
        throw new Error("timezone down");
      }
    });
    expect(thrown.emailTemplate?.("en").body).toContain("12:01 PM");

    vi.mocked(dispatchUrgentNotification).mockClear();
    const blank = await flipAndDispatch({ getTimezone: async () => "  " });
    expect(blank.emailTemplate?.("en").body).toContain("12:01 PM");
  });
});

describe("calendlyDashboardPauseCopy", () => {
  const paused = "Paused until Calendly is reconnected.";

  it("shows the pause only when Calendly is the resolved calendar (or none)", async () => {
    expect(
      await calendlyDashboardPauseCopy(BIZ, {
        pauseState: async () => ({ pausedCopy: paused, needingReauth: [] }),
        resolveCalendar: async () =>
          ({ provider: "calendly", providerConfigKey: "calendly-direct", connectionId: CONN_A })
      })
    ).toBe(paused);
    expect(
      await calendlyDashboardPauseCopy(BIZ, {
        pauseState: async () => ({ pausedCopy: paused, needingReauth: [] }),
        resolveCalendar: async () => null
      })
    ).toBe(paused);
    expect(
      await calendlyDashboardPauseCopy(BIZ, {
        pauseState: async () => ({ pausedCopy: paused, needingReauth: [] }),
        resolveCalendar: async () =>
          ({ provider: "google", providerConfigKey: "google-calendar", connectionId: "g1" })
      })
    ).toBeNull();
  });

  it("uses the default pause-state and calendar resolvers", async () => {
    vi.mocked(calendlyCalendarPauseState).mockResolvedValue({
      pausedCopy: paused,
      needingReauth: []
    } as never);
    vi.mocked(resolveCalendarConnection).mockResolvedValue({
      provider: "vagaro",
      providerConfigKey: "vagaro",
      connectionId: "v1"
    } as never);
    expect(await calendlyDashboardPauseCopy(BIZ)).toBeNull();
    expect(calendlyCalendarPauseState).toHaveBeenCalledWith(BIZ);
    expect(resolveCalendarConnection).toHaveBeenCalledWith(BIZ);
  });
});
