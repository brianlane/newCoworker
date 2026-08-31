import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listRecentAlertsAbout,
  insertNotification,
  getNotifications,
  getUnreadNotificationCount,
  hasRecentNotificationForContact,
  markNotificationRead,
  notificationBusinessId,
  markAllNotificationsRead,
  markWhatsAppAlertUndelivered,
  softDeleteNotification
} from "@/lib/db/notifications";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/residency/row-delete", () => ({
  softDeleteContentRows: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { softDeleteContentRows } from "@/lib/residency/row-delete";

const MOCK_NOTIF = {
  id: "notif-uuid-1",
  business_id: "biz-uuid-1",
  delivery_channel: "sms",
  status: "sent",
  payload: { summary: "Urgent event" },
  created_at: "2026-01-01T00:00:00Z",
  read_at: null,
  kind: "urgent_alert",
  summary: "Urgent event"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: MOCK_NOTIF, error: null }),
    single: vi.fn().mockResolvedValue({ data: MOCK_NOTIF, error: null }),
    ...overrides
  };
}

describe("db/notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertNotification inserts and returns row", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await insertNotification({
      id: "notif-uuid-1",
      business_id: "biz-uuid-1",
      delivery_channel: "sms",
      status: "sent",
      payload: { summary: "Urgent event" }
    });
    expect(result.delivery_channel).toBe("sms");
  });

  it("insertNotification accepts new optional kind/summary/read_at fields", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await insertNotification({
      id: "notif-uuid-1",
      business_id: "biz-uuid-1",
      delivery_channel: "email",
      status: "skipped",
      payload: { reason: "unsubscribed" },
      kind: "urgent_alert",
      summary: "URGENT call"
    });
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "urgent_alert", summary: "URGENT call" })
    );
  });

  it("insertNotification throws on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(insertNotification({
      id: "x",
      business_id: "y",
      delivery_channel: "email",
      status: "queued",
      payload: {}
    })).rejects.toThrow("insertNotification");
  });

  it("getNotifications returns array", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null });
    const db = { ...mockDb(), limit };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getNotifications("biz-uuid-1");
    expect(result).toHaveLength(1);
  });

  it("getNotifications throws on error", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "err" } });
    const db = { ...mockDb(), limit };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getNotifications("biz-uuid-1")).rejects.toThrow("getNotifications");
  });

  it("getNotifications returns empty array when data is null with no error", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = { ...mockDb(), limit };
    const result = await getNotifications("biz-uuid-1", 20, db as never);
    expect(result).toEqual([]);
  });

  it("getNotifications uses provided client (legacy number signature)", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null });
    const db = { ...mockDb(), limit };
    const result = await getNotifications("biz-uuid-1", 5, db as never);
    expect(result).toHaveLength(1);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("getNotifications options object: applies unreadOnly filter via .is()", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const is = vi.fn().mockReturnThis();
    const db = { ...mockDb(), is, limit };
    await getNotifications("biz-uuid-1", { unreadOnly: true, limit: 10 }, db as never);
    expect(is).toHaveBeenCalledWith("read_at", null);
    expect(limit).toHaveBeenCalledWith(10);
  });

  it("getNotifications options bag: defaults limit to 20 when omitted", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { ...mockDb(), limit };
    await getNotifications("biz-uuid-1", { unreadOnly: false }, db as never);
    expect(limit).toHaveBeenCalledWith(20);
  });

  it("hasRecentNotificationForContact: true when a sent alert exists in the window", async () => {
    const gte = vi.fn().mockResolvedValue({ count: 1, error: null });
    const db = { ...mockDb(), gte };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const recent = await hasRecentNotificationForContact(
      "biz-uuid-1",
      "link_click",
      "+16478879033",
      60 * 60 * 1000
    );
    expect(recent).toBe(true);
    expect(db.eq).toHaveBeenCalledWith("payload->>to_e164", "+16478879033");
    expect(db.eq).toHaveBeenCalledWith("kind", "link_click");
    expect(db.eq).toHaveBeenCalledWith("status", "sent");
  });

  it("hasRecentNotificationForContact: false on zero/null count; explicit client honored", async () => {
    const gte = vi.fn().mockResolvedValue({ count: 0, error: null });
    const db = { ...mockDb(), gte };
    expect(
      await hasRecentNotificationForContact("b", "link_click", "+1", 1000, db as never)
    ).toBe(false);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();

    const gteNull = vi.fn().mockResolvedValue({ count: null, error: null });
    const dbNull = { ...mockDb(), gte: gteNull };
    expect(
      await hasRecentNotificationForContact("b", "link_click", "+1", 1000, dbNull as never)
    ).toBe(false);
  });

  it("hasRecentNotificationForContact throws on query error", async () => {
    const gte = vi.fn().mockResolvedValue({ count: null, error: { message: "denied" } });
    const db = { ...mockDb(), gte };
    await expect(
      hasRecentNotificationForContact("b", "link_click", "+1", 1000, db as never)
    ).rejects.toThrow("hasRecentNotificationForContact: denied");
  });

  /**
   * The unread-count chain now ends with TWO .is() calls
   * (read_at, then deleted_at): the first must return the chain,
   * the second resolves the query.
   */
  function unreadCountChain(result: { count: number | null; error: { message: string } | null }) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      // Residency-mode lookup (from("businesses")…maybeSingle) shares this
      // mock; null data resolves to central ("supabase") mode.
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      is: vi.fn()
    };
    chain.is.mockReturnValueOnce(chain).mockResolvedValueOnce(result);
    return chain;
  }

  it("getUnreadNotificationCount returns count and filters by status='sent'", async () => {
    const chain = unreadCountChain({ count: 4, error: null });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getUnreadNotificationCount("biz-uuid-1")).toBe(4);
    // Bell badge must NOT count audit-only skipped/failed rows.
    expect(chain.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(chain.eq).toHaveBeenCalledWith("status", "sent");
    expect(chain.is).toHaveBeenCalledWith("read_at", null);
    // Soft-deleted rows must never inflate the bell badge.
    expect(chain.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("getUnreadNotificationCount returns 0 when count is null", async () => {
    const chain = unreadCountChain({ count: null, error: null });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getUnreadNotificationCount("biz-uuid-1")).toBe(0);
  });

  it("getUnreadNotificationCount throws on error", async () => {
    const chain = unreadCountChain({ count: null, error: { message: "boom" } });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getUnreadNotificationCount("biz-uuid-1")).rejects.toThrow(
      "getUnreadNotificationCount"
    );
  });

  /**
   * The push receipt uses this to answer "which scope did this tap belong
   * to?" when one browser holds subscriptions under two scopes on the same
   * endpoint. Guessing there would file a platform alert as a tenant's
   * liveness evidence, which is the exact failure the liveness check exists
   * to prevent, so the notification is asked rather than inferred.
   */
  it("notificationBusinessId resolves the owning business", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { business_id: "biz-uuid-1" }, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    expect(await notificationBusinessId("notif-uuid-1")).toBe("biz-uuid-1");
    expect(chain.eq).toHaveBeenCalledWith("id", "notif-uuid-1");
  });

  it("notificationBusinessId returns null for an unknown notification", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn().mockReturnValue(chain)
    } as never);
    expect(await notificationBusinessId("nope")).toBeNull();
  });

  it("notificationBusinessId throws with context on error", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn().mockReturnValue(chain)
    } as never);
    await expect(notificationBusinessId("x")).rejects.toThrow("notificationBusinessId: boom");
  });

  it("markNotificationRead returns the updated row", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { ...MOCK_NOTIF, read_at: "2026-05-01T00:00:00Z" },
        error: null
      })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await markNotificationRead("notif-uuid-1", "biz-uuid-1");
    expect(row?.read_at).toBe("2026-05-01T00:00:00Z");
    expect(chain.eq).toHaveBeenCalledWith("id", "notif-uuid-1");
    expect(chain.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(chain.is).toHaveBeenCalledWith("read_at", null);
  });

  it("markNotificationRead stamps the actor, defaulting to system rather than owner", async () => {
    // Fail-closed on purpose: an unlabelled caller must not be able to vouch
    // for the customer, because the channel-liveness check reads this column
    // as evidence the alert audience is alive.
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: MOCK_NOTIF, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await markNotificationRead("n", "b");
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ read_by_actor: "system" })
    );

    await markNotificationRead("n", "b", "owner");
    expect(chain.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ read_by_actor: "owner" })
    );
  });

  it("markAllNotificationsRead stamps the actor the same way", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: "1" }], error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await markAllNotificationsRead("biz");
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ read_by_actor: "system" })
    );

    await markAllNotificationsRead("biz", "admin");
    expect(chain.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ read_by_actor: "admin" })
    );
  });

  it("markNotificationRead returns null when no row matched (already read or wrong owner)", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markNotificationRead("nope", "biz")).toBeNull();
  });

  it("markNotificationRead throws on db error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markNotificationRead("n", "b")).rejects.toThrow("markNotificationRead");
  });

  it("markAllNotificationsRead returns count of rows updated", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: "1" }, { id: "2" }], error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markAllNotificationsRead("biz")).toBe(2);
    // Soft-deleted rows must never be mutated by mark-all.
    expect(chain.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("markNotificationRead never touches soft-deleted rows", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await markNotificationRead("n1", "biz");
    expect(chain.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("markAllNotificationsRead returns 0 when supabase returns null with no error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markAllNotificationsRead("biz")).toBe(0);
  });

  it("markAllNotificationsRead throws on db error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markAllNotificationsRead("biz")).rejects.toThrow("markAllNotificationsRead");
  });

  it("getNotifications filters out soft-deleted rows", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const is = vi.fn().mockReturnThis();
    const db = { ...mockDb(), is, limit };
    await getNotifications("biz-uuid-1", 20, db as never);
    expect(is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("softDeleteNotification delegates to the residency-aware soft delete", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 1, box: null });
    const db = mockDb();
    const count = await softDeleteNotification("biz-uuid-1", "notif-uuid-1", "user-1", db as never);
    expect(count).toBe(1);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz-uuid-1",
      "notifications",
      [{ column: "id", op: "eq", value: "notif-uuid-1" }],
      "user-1",
      { client: db }
    );
  });

  it("softDeleteNotification counts box-only stamps (vps-mode purged central)", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 0, box: 1 });
    expect(await softDeleteNotification("biz", "n1", null)).toBe(1);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz",
      "notifications",
      [{ column: "id", op: "eq", value: "n1" }],
      null,
      {}
    );
  });

  it("listRecentAlertsAbout counts distinct dispatch events, not channel rows", async () => {
    // One dispatch writes a row per channel. Three rows sharing a
    // dispatch_id are ONE alert event; a pre-stamp row with none counts as
    // its own event (over-counting is the safe direction for a flood cap).
    const rows = [
      { dispatch_id: "d1", summary: "Joy is waiting on the Zoom" },
      { dispatch_id: "d1", summary: "Joy is waiting on the Zoom" },
      { dispatch_id: "d1", summary: "Joy is waiting on the Zoom" },
      { dispatch_id: "d2", summary: "Joy needs a call before noon" },
      { dispatch_id: null, summary: "pre-stamp row" },
      // Rows can carry no usable summary; they still COUNT as events but
      // contribute nothing for the duplicate check to compare against.
      { dispatch_id: "d3" },
      { dispatch_id: null, summary: 42 },
      // A dispatch the gate suppressed: its dashboard row is genuinely sent,
      // but it is not a delivered alert and must not eat the backstop budget.
      { dispatch_id: "d4", suppressed: "contact_alert_duplicate", summary: "a repeat" }
    ];
    const db = mockDb({
      limit: vi.fn().mockReturnThis(),
      gte: vi.fn().mockImplementation(function (this: unknown) {
        return { limit: vi.fn().mockResolvedValue({ data: rows, error: null }) };
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const recent = await listRecentAlertsAbout(
      "biz-uuid-1",
      "sms_team_notify",
      "+16025550000",
      1800000
    );
    expect(recent.events).toBe(5);
    // One summary per dispatch: the per-channel fan-out repeats it, and the
    // duplicate check compares ALERTS, not rows.
    expect(recent.summaries).toEqual([
      "Joy is waiting on the Zoom",
      "Joy needs a call before noon",
      "pre-stamp row"
    ]);
  });

  it("listRecentAlertsAbout returns no events on empty and throws on error", async () => {
    const empty = mockDb({
      gte: vi.fn().mockImplementation(function (this: unknown) {
        return { limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    expect(await listRecentAlertsAbout("b", "k", "+1", 1000)).toEqual({
      events: 0,
      summaries: []
    });

    // PostgREST can return null data with no error; that is zero events.
    const nullData = mockDb({
      gte: vi.fn().mockImplementation(function (this: unknown) {
        return { limit: vi.fn().mockResolvedValue({ data: null, error: null }) };
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(nullData as never);
    expect(await listRecentAlertsAbout("b", "k", "+1", 1000)).toEqual({ events: 0, summaries: [] });

    const failing = mockDb({
      gte: vi.fn().mockImplementation(function (this: unknown) {
        return { limit: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) };
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(failing as never);
    await expect(listRecentAlertsAbout("b", "k", "+1", 1000)).rejects.toThrow(
      "listRecentAlertsAbout: boom"
    );
  });
});

/**
 * Correcting a WhatsApp alert row that Meta accepted and then dropped.
 *
 * The dispatcher writes `sent` on Meta's acceptance, which is not delivery.
 * KYP Ads carried twenty such rows, every one dropped ~15s later on billing
 * error 131042, and the dashboard, the unread badge and the liveness sweep
 * all read them as delivered.
 */
describe("markWhatsAppAlertUndelivered", () => {
  const BIZ = "biz-uuid-1";
  const WAMID = "wamid.HBgLMTUxNDUxODgxOTIVAgAR";
  const REASON = "whatsapp_131042:Business eligibility payment issue";

  type Result = { data: unknown; error: { message: string } | null };

  /**
   * Two chains, handed out in call order: the lookup (ends in maybeSingle)
   * then the correcting update (ends in an awaited select).
   */
  function reconcileDb(read: Result, write: Result = { data: [{ id: "n1" }], error: null }) {
    const readChain: Record<string, unknown> = {
      maybeSingle: vi.fn().mockResolvedValue(read)
    };
    readChain.select = vi.fn(() => readChain);
    readChain.eq = vi.fn(() => readChain);

    const writeChain: Record<string, unknown> = {
      select: vi.fn().mockResolvedValue(write)
    };
    writeChain.update = vi.fn(() => writeChain);
    writeChain.eq = vi.fn(() => writeChain);

    let call = 0;
    return {
      db: { from: vi.fn(() => (call++ === 0 ? readChain : writeChain)) },
      readChain,
      writeChain
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("flips the accepted row to failed and records why", async () => {
    const { db, readChain, writeChain } = reconcileDb({
      data: { id: "n1", payload: { summary: "New lead", wamid: WAMID } },
      error: null
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(true);
    // Matched on the wamid the dispatcher stamped, scoped to this tenant's
    // WhatsApp leg, and only against a row still claiming delivery.
    expect(readChain.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(readChain.eq).toHaveBeenCalledWith("delivery_channel", "whatsapp");
    expect(readChain.eq).toHaveBeenCalledWith("status", "sent");
    expect(readChain.eq).toHaveBeenCalledWith("payload->>wamid", WAMID);

    const update = vi.mocked(writeChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(update.status).toBe("failed");
    expect(update.payload.reason).toBe(REASON);
    // The rest of the payload survives: the summary and the routing stamps
    // are what the dashboard row is made of.
    expect(update.payload.summary).toBe("New lead");
    expect(typeof update.payload.delivery_reconciled_at).toBe("string");
  });

  it("reports no correction for a receipt with no alert row behind it", async () => {
    // The common case by volume: a dropped reply to a lead, or any message a
    // human sent from the Meta inbox. Not a fault.
    const { db, writeChain } = reconcileDb({ data: null, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(false);
    expect(writeChain.update).not.toHaveBeenCalled();
  });

  it("treats a row without an id as no row, rather than updating by undefined", async () => {
    const { db, writeChain } = reconcileDb({ data: { payload: {} }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(false);
    expect(writeChain.update).not.toHaveBeenCalled();
  });

  it("tolerates a row whose payload is null", async () => {
    const { db, writeChain } = reconcileDb({ data: { id: "n1", payload: null }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(true);
    const update = vi.mocked(writeChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(update.payload.reason).toBe(REASON);
  });

  it("is idempotent: a redelivered receipt corrects nothing twice", async () => {
    // The update re-asserts status='sent', so the second receipt matches zero
    // rows. PostgREST returns no error for that, so the returned rows are the
    // only proof the correction landed.
    const { db } = reconcileDb(
      { data: { id: "n1", payload: {} }, error: null },
      { data: [], error: null }
    );
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(false);
  });

  it("treats a null update result as no correction", async () => {
    const { db } = reconcileDb(
      { data: { id: "n1", payload: {} }, error: null },
      { data: null, error: null }
    );
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).toBe(false);
  });

  it("throws on a failed lookup rather than reporting a clean miss", async () => {
    const { db } = reconcileDb({ data: null, error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).rejects.toThrow(
      "markWhatsAppAlertUndelivered: boom"
    );
  });

  it("throws on a failed update", async () => {
    const { db } = reconcileDb(
      { data: { id: "n1", payload: {} }, error: null },
      { data: null, error: { message: "write denied" } }
    );
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markWhatsAppAlertUndelivered(BIZ, WAMID, REASON)).rejects.toThrow(
      "markWhatsAppAlertUndelivered: write denied"
    );
  });

  it("uses an injected client instead of building one", async () => {
    const { db } = reconcileDb({ data: { id: "n1", payload: {} }, error: null });
    vi.mocked(createSupabaseServiceClient).mockReset();
    expect(await markWhatsAppAlertUndelivered(BIZ, WAMID, REASON, db as never)).toBe(true);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
