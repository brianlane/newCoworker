/**
 * Shared needs_reauth loop for stored grants other than Calendly.
 *
 * Permanent reject flips THAT connection and emails once, then once more
 * after a day, then stops. A sibling on the same business stays healthy.
 * Transient 5xx never calls mark. Reconnect is "clear flags on the same
 * row", not a new row, and does not backfill missed hours.
 *
 * Wired tables in this file: Zoom and Google (workspace_oauth_connections).
 * Calendly behavior from #1868 is asserted separately so this PR cannot
 * silently rewrite it.
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

import {
  CONNECTION_REAUTH_KIND,
  CONNECTION_REAUTH_MAX_EMAILS,
  CONNECTION_REAUTH_REMINDER_MS,
  labelsForReauthRow,
  listConnectionReauthBannerState,
  markConnectionNeedsReauth,
  processConnectionReauthReminders,
  stampConnectionHealthy
} from "@/lib/connections/reauth";
import { clearedReauthFields } from "@/lib/connections/reauth-copy";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordSystemLog } from "@/lib/db/system-logs";
import {
  CALENDLY_REAUTH_KIND,
  CALENDLY_REAUTH_MAX_EMAILS,
  markCalendlyConnectionNeedsReauth
} from "@/lib/calendly/reauth";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ZOOM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ZOOM_B = "bbbbbbbb-1111-4111-8111-111111111111";
const GOOGLE_A = "cccccccc-1111-4111-8111-111111111111";
const GOOGLE_B = "dddddddd-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-17T02:11:00.000Z");

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
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve)
  };
  return c as never;
}

function zoomRow(over: Record<string, unknown> = {}) {
  return {
    id: ZOOM_A,
    business_id: BIZ,
    account_name: "Acme Zoom",
    account_email: "zoom@acme.test",
    last_healthy_at: "2026-09-16T12:01:00.000Z",
    reauth_email_count: 0,
    reauth_email_last_sent_at: null,
    needs_reauth: false,
    ...over
  };
}

function googleRow(over: Record<string, unknown> = {}) {
  return {
    id: GOOGLE_A,
    business_id: BIZ,
    provider_config_key: "google",
    metadata: {
      provider_account_email: "james@kyp.test",
      provider_account_display_name: "James Lee"
    },
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

describe("Calendly #1868 still holds", () => {
  it("keeps its own kind, two-email cap, and calendly_connections table", async () => {
    expect(CALENDLY_REAUTH_KIND).toBe("calendly_needs_reauth");
    expect(CALENDLY_REAUTH_KIND).not.toBe(CONNECTION_REAUTH_KIND);
    expect(CALENDLY_REAUTH_MAX_EMAILS).toBe(2);
    expect(CONNECTION_REAUTH_MAX_EMAILS).toBe(2);

    const read = chain();
    read.maybeSingle.mockResolvedValue({
      data: {
        id: ZOOM_A,
        business_id: BIZ,
        account_name: "James Lee",
        account_email: "james@kyp.test",
        last_healthy_at: "2026-09-16T12:01:00.000Z",
        reauth_email_count: 0,
        reauth_email_last_sent_at: null,
        needs_reauth: false
      },
      error: null
    });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: ZOOM_A,
          business_id: BIZ,
          account_name: "James Lee",
          account_email: "james@kyp.test",
          last_healthy_at: "2026-09-16T12:01:00.000Z",
          reauth_email_count: 0,
          reauth_email_last_sent_at: null,
          needs_reauth: true
        },
        error: null
      })
      .mockResolvedValueOnce({ data: { id: ZOOM_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) };
    const result = await markCalendlyConnectionNeedsReauth(ZOOM_A, {
      client: db as never,
      now: () => NOW
    });
    expect(result).toEqual({ flipped: true, emailed: true });
    expect(db.from).toHaveBeenCalledWith("calendly_connections");
    const dispatched = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(dispatched.kind).toBe("calendly_needs_reauth");
    expect(dispatched.emailTemplate?.("en").subject).toBe("Calendly needs a reconnect");
    expect(dispatched.emailTemplate?.("en").body.toLowerCase()).not.toContain("token rejected");
  });
});

describe("markConnectionNeedsReauth (Zoom)", () => {
  it("flips the row, emails once, and does not touch a second account", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: zoomRow({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: { id: ZOOM_A }, error: null });
    let calls = 0;
    const db = {
      from: vi.fn(() => {
        calls += 1;
        return calls === 1 ? read : write;
      })
    };

    const result = await markConnectionNeedsReauth("zoom_connections", ZOOM_A, {
      client: db as never,
      now: () => NOW
    });
    expect(result).toEqual({ flipped: true, emailed: true });
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ needs_reauth: true }));
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(dispatched.kind).toBe(CONNECTION_REAUTH_KIND);
    expect(dispatched.ctaPath).toContain(ZOOM_A);
    expect(dispatched.summary).toContain("Acme Zoom");
    expect(dispatched.emailTemplate?.("en").subject).toBe("Zoom needs to be reconnected");
    expect(dispatched.emailTemplate?.("es").subject).toContain("Zoom");
    expect(dispatched.emailTemplate?.("en").body.toLowerCase()).not.toContain("token rejected");
    expect(dispatched.emailTemplate?.("en").body.toLowerCase()).not.toContain("invalid_grant");
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "zoom_connection_needs_reauth",
        businessId: BIZ
      })
    );
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ reauth_email_count: 1 }));
    expect(write.eq).not.toHaveBeenCalledWith("id", ZOOM_B);
    expect(db.from).toHaveBeenCalledWith("zoom_connections");
  });

  it("is a no-op (no second email) when the row is already flagged", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({
      data: zoomRow({ needs_reauth: true, reauth_email_count: 1 }),
      error: null
    });
    const result = await markConnectionNeedsReauth("zoom_connections", ZOOM_A, {
      client: { from: vi.fn(() => read) } as never,
      now: () => NOW
    });
    expect(result).toEqual({ flipped: false, emailed: false });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("returns flipped:false when the row is gone", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(
      await markConnectionNeedsReauth("zoom_connections", ZOOM_A, {
        client: { from: vi.fn(() => read) } as never
      })
    ).toEqual({ flipped: false, emailed: false });
  });
});

describe("markConnectionNeedsReauth (Google sibling stays healthy)", () => {
  it("flips only the rejected Google mailbox and names Google, not Workspace", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: googleRow(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: googleRow({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: { id: GOOGLE_A }, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;

    const result = await markConnectionNeedsReauth("workspace_oauth_connections", GOOGLE_A, {
      client: db,
      now: () => NOW
    });
    expect(result).toEqual({ flipped: true, emailed: true });
    expect(write.eq).not.toHaveBeenCalledWith("id", GOOGLE_B);
    const dispatched = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(dispatched.emailTemplate?.("en").subject).toBe("Google needs to be reconnected");
    expect(dispatched.ctaPath).toBe(
      `/dashboard/integrations/google?reconnect=${GOOGLE_A}`
    );
    expect(dispatched.summary).toContain("James Lee");
    expect(dispatched.payload).toEqual(
      expect.objectContaining({
        connection_id: GOOGLE_A,
        provider: "Google"
      })
    );
  });
});

describe("stampConnectionHealthy", () => {
  it("stamps last_healthy_at only while needs_reauth is false", async () => {
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: { id: ZOOM_A }, error: null });
    const db = { from: vi.fn(() => write) } as never;
    await stampConnectionHealthy("zoom_connections", ZOOM_A, {
      client: db,
      now: () => NOW
    });
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_healthy_at: new Date(NOW).toISOString() })
    );
    expect(write.eq).toHaveBeenCalledWith("needs_reauth", false);
  });

  it("is a no-op when the row is already flagged (dead grant is not healthy)", async () => {
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    await stampConnectionHealthy("zoom_connections", ZOOM_A, {
      client: { from: vi.fn(() => write) } as never,
      now: () => NOW
    });
    expect(write.update).toHaveBeenCalled();
  });
});

describe("processConnectionReauthReminders", () => {
  function emptyList(): Chain {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    return c;
  }

  it("emails the next day, then stops (Zoom)", async () => {
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({
      data: [zoomRow({ needs_reauth: true, reauth_email_count: 1, reauth_email_last_sent_at: new Date(NOW - CONNECTION_REAUTH_REMINDER_MS).toISOString() })],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: ZOOM_A }, error: null });
    const db = {
      from: vi.fn((table: string) => (table === "zoom_connections" ? (stamp.update.mock.calls.length === 0 && zoomList.limit.mock.calls.length === 0 ? zoomList : (zoomList.limit.mock.calls.length > 0 ? stamp : zoomList)) : emptyList()))
    };

    // Simpler sequencing: first from(zoom) is the list, later zoom from is stamp.
    let zoomCalls = 0;
    const sequenced = {
      from: vi.fn((table: string) => {
        if (table !== "zoom_connections") return emptyList();
        zoomCalls += 1;
        return zoomCalls === 1 ? zoomList : stamp;
      })
    } as never;

    const first = await processConnectionReauthReminders({
      client: sequenced,
      now: () => NOW
    });
    expect(first.emailed).toBe(1);
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);

    vi.mocked(dispatchUrgentNotification).mockClear();
    const alreadyTwo = chain();
    alreadyTwo.limit.mockResolvedValue({ data: [], error: null });
    const stopped = {
      from: vi.fn(() => emptyList())
    } as never;
    const later = await processConnectionReauthReminders({
      client: stopped,
      now: () => NOW + CONNECTION_REAUTH_REMINDER_MS
    });
    expect(later.emailed).toBe(0);
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("does not email again the same day", async () => {
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({
      data: [
        zoomRow({
          needs_reauth: true,
          reauth_email_count: 1,
          reauth_email_last_sent_at: new Date(NOW - 60_000).toISOString()
        })
      ],
      error: null
    });
    const db = {
      from: vi.fn((table: string) => (table === "zoom_connections" ? zoomList : emptyList()))
    } as never;
    const result = await processConnectionReauthReminders({ client: db, now: () => NOW });
    expect(result.emailed).toBe(0);
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });
});

describe("listConnectionReauthBannerState", () => {
  it("names Zoom and the account, with a Reconnect path on that row", async () => {
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({
      data: [zoomRow({ needs_reauth: true })],
      error: null
    });
    const empty = chain();
    empty.limit.mockResolvedValue({ data: [], error: null });
    const db = {
      from: vi.fn((table: string) => (table === "zoom_connections" ? zoomList : empty))
    } as never;
    const banners = await listConnectionReauthBannerState(BIZ, db);
    expect(banners).toHaveLength(1);
    expect(banners[0].provider).toBe("Zoom");
    expect(banners[0].accountLabel).toBe("Acme Zoom");
    expect(banners[0].reconnectPath).toContain(ZOOM_A);
    expect(banners[0].bannerBody.toLowerCase()).not.toContain("token rejected");
    expect(banners[0].bannerBody).toContain("Meetings and transcripts");
  });
});

describe("clearedReauthFields (reconnect same row, no backfill)", () => {
  it("clears the flags so the next poll uses the new grant from now", () => {
    const nowIso = new Date(NOW).toISOString();
    expect(clearedReauthFields(nowIso)).toEqual({
      needs_reauth: false,
      reauth_email_count: 0,
      reauth_email_last_sent_at: null,
      last_healthy_at: nowIso
    });
  });
});

describe("labelsForReauthRow", () => {
  it("names every wired provider and deep-links that product page", () => {
    expect(labelsForReauthRow("zoom_connections", zoomRow())).toMatchObject({
      provider: "Zoom",
      slug: "zoom",
      accountLabel: "Acme Zoom"
    });
    expect(
      labelsForReauthRow("workspace_oauth_connections", googleRow())
    ).toMatchObject({ provider: "Google", slug: "google" });
    expect(
      labelsForReauthRow("workspace_oauth_connections", {
        ...googleRow(),
        provider_config_key: "outlook",
        metadata: { provider_account_email: "sam@acme.com" }
      })
    ).toMatchObject({ provider: "Microsoft 365", slug: "microsoft" });
    expect(
      labelsForReauthRow("workspace_oauth_connections", {
        ...googleRow(),
        provider_config_key: "hubspot"
      })
    ).toMatchObject({ provider: "Workspace", slug: "workspace" });
    expect(
      labelsForReauthRow("workspace_oauth_connections", {
        ...googleRow(),
        provider_config_key: null
      })
    ).toMatchObject({ provider: "Workspace", slug: "workspace" });
    expect(
      labelsForReauthRow("acuity_connections", {
        ...zoomRow(),
        account_name: null,
        account_email: null,
        user_id: "12345"
      })
    ).toMatchObject({ provider: "Acuity", slug: "acuity", accountLabel: "12345" });
    expect(
      labelsForReauthRow("caldav_connections", {
        ...zoomRow(),
        username: "james@icloud.com",
        calendar_name: null,
        account_name: null,
        account_email: null
      })
    ).toMatchObject({ provider: "CalDAV", slug: "caldav", accountLabel: "james@icloud.com" });
    expect(
      labelsForReauthRow("vagaro_connections", {
        ...zoomRow(),
        client_id: "cid-1",
        account_name: null,
        account_email: null
      })
    ).toMatchObject({ provider: "Vagaro", slug: "vagaro", accountLabel: "cid-1" });
    expect(
      labelsForReauthRow("meta_connections", {
        ...zoomRow(),
        page_name: "KYP Ads",
        account_name: null
      })
    ).toMatchObject({ provider: "Facebook", slug: "meta", accountLabel: "KYP Ads" });
    expect(
      labelsForReauthRow("slack_connections", {
        ...zoomRow(),
        team_name: "KYP",
        account_name: null
      })
    ).toMatchObject({ provider: "Slack", slug: "slack", accountLabel: "KYP" });
    expect(
      labelsForReauthRow("whatsapp_connections", {
        ...zoomRow(),
        display_phone_number: "+1 555-0100",
        account_name: null,
        account_email: null
      })
    ).toMatchObject({ provider: "WhatsApp", slug: "whatsapp", accountLabel: "+1 555-0100" });
  });
});

describe("markConnectionNeedsReauth error paths", () => {
  it("throws when the read fails", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(
      markConnectionNeedsReauth("zoom_connections", ZOOM_A, {
        client: { from: vi.fn(() => read) } as never
      })
    ).rejects.toThrow("markConnectionNeedsReauth: down");
  });

  it("throws when the flip write fails", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: { message: "locked" } });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(
      markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).rejects.toThrow("markConnectionNeedsReauth: locked");
  });

  it("returns flipped:false when a concurrent writer already flipped", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    expect(
      await markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).toEqual({ flipped: false, emailed: false });
  });

  it("flips without emailing when the row is already at the two-email cap", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({
      data: zoomRow({ reauth_email_count: CONNECTION_REAUTH_MAX_EMAILS }),
      error: null
    });
    const write = chain();
    write.maybeSingle.mockResolvedValue({
      data: zoomRow({
        needs_reauth: true,
        reauth_email_count: CONNECTION_REAUTH_MAX_EMAILS
      }),
      error: null
    });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    expect(
      await markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).toEqual({ flipped: true, emailed: false });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("still flips when the product email throws", async () => {
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce(new Error("ses down"));
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: zoomRow({ needs_reauth: true }), error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    expect(
      await markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).toEqual({ flipped: true, emailed: false });
  });

  it("throws when the email-sent stamp cannot write", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: zoomRow({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "stamp fail" } });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(
      markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).rejects.toThrow("stampConnectionReauthEmail: stamp fail");
  });

  it("throws when the email-sent stamp matches zero rows", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: zoomRow(), error: null });
    const write = chain();
    write.maybeSingle
      .mockResolvedValueOnce({ data: zoomRow({ needs_reauth: true }), error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    let n = 0;
    const db = { from: vi.fn(() => ((n += 1) === 1 ? read : write)) } as never;
    await expect(
      markConnectionNeedsReauth("zoom_connections", ZOOM_A, { client: db, now: () => NOW })
    ).rejects.toThrow(`stampConnectionReauthEmail: no row updated for ${ZOOM_A}`);
  });
});

describe("stampConnectionHealthy / list / reminders error paths", () => {
  it("throws when last_healthy_at cannot be written", async () => {
    const write = chain();
    write.maybeSingle.mockResolvedValue({ data: null, error: { message: "busy" } });
    await expect(
      stampConnectionHealthy("zoom_connections", ZOOM_A, {
        client: { from: vi.fn(() => write) } as never,
        now: () => NOW
      })
    ).rejects.toThrow("stampConnectionHealthy: busy");
  });

  it("throws when the banner list query fails", async () => {
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({ data: null, error: { message: "list down" } });
    const db = { from: vi.fn(() => zoomList) } as never;
    await expect(listConnectionReauthBannerState(BIZ, db)).rejects.toThrow(
      "listConnectionReauthBannerState: list down"
    );
  });

  it("throws when a reminder list query fails", async () => {
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({ data: null, error: { message: "remind down" } });
    const db = { from: vi.fn(() => zoomList) } as never;
    await expect(processConnectionReauthReminders({ client: db, now: () => NOW })).rejects.toThrow(
      "processConnectionReauthReminders: remind down"
    );
  });

  it("sends a missed first email (count 0) and skips a send that returns no channels", async () => {
    function emptyList() {
      const c = chain();
      c.limit.mockResolvedValue({ data: [], error: null });
      return c;
    }
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({
      data: [
        zoomRow({ needs_reauth: true, reauth_email_count: 0, reauth_email_last_sent_at: null })
      ],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: ZOOM_A }, error: null });
    let zoomCalls = 0;
    const db = {
      from: vi.fn((table: string) => {
        if (table !== "zoom_connections") return emptyList();
        zoomCalls += 1;
        return zoomCalls === 1 ? zoomList : stamp;
      })
    } as never;
    const first = await processConnectionReauthReminders({ client: db, now: () => NOW });
    expect(first.emailed).toBe(1);

    vi.mocked(dispatchUrgentNotification).mockResolvedValueOnce({ results: [] } as never);
    zoomCalls = 0;
    const skipped = await processConnectionReauthReminders({ client: db, now: () => NOW });
    expect(skipped.emailed).toBe(0);
  });

  it("treats an unparseable last-sent stamp as due, and skips a row already at the cap", async () => {
    function emptyList() {
      const c = chain();
      c.limit.mockResolvedValue({ data: [], error: null });
      return c;
    }
    const zoomList = chain();
    zoomList.limit.mockResolvedValue({
      data: [
        zoomRow({
          needs_reauth: true,
          reauth_email_count: CONNECTION_REAUTH_MAX_EMAILS,
          reauth_email_last_sent_at: "2026-09-16T12:01:00.000Z"
        }),
        zoomRow({
          id: ZOOM_B,
          needs_reauth: true,
          reauth_email_count: 1,
          reauth_email_last_sent_at: "not-a-date"
        })
      ],
      error: null
    });
    const stamp = chain();
    stamp.maybeSingle.mockResolvedValue({ data: { id: ZOOM_B }, error: null });
    let zoomCalls = 0;
    const db = {
      from: vi.fn((table: string) => {
        if (table !== "zoom_connections") return emptyList();
        zoomCalls += 1;
        return zoomCalls === 1 ? zoomList : stamp;
      })
    } as never;
    const result = await processConnectionReauthReminders({ client: db, now: () => NOW });
    expect(result.considered).toBe(2);
    expect(result.emailed).toBe(1);
  });

  it("uses the default service client when none is passed", async () => {
    const read = chain();
    read.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue({ from: vi.fn(() => read) });
    expect(await markConnectionNeedsReauth("zoom_connections", ZOOM_A)).toEqual({
      flipped: false,
      emailed: false
    });
    const empty = chain();
    empty.limit.mockResolvedValue({ data: [], error: null });
    empty.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue({ from: vi.fn(() => empty) });
    await stampConnectionHealthy("zoom_connections", ZOOM_A, { now: () => NOW });
    expect(await listConnectionReauthBannerState(BIZ)).toEqual([]);
    expect(await processConnectionReauthReminders({ now: () => NOW })).toEqual({
      considered: 0,
      emailed: 0
    });
    expect(defaultClientSpy).toHaveBeenCalled();
  });

  it("defaults reminder now to Date.now and treats a null list as empty", async () => {
    const empty = chain();
    empty.limit.mockResolvedValue({ data: null, error: null });
    const db = { from: vi.fn(() => empty) } as never;
    expect(await processConnectionReauthReminders({ client: db })).toEqual({
      considered: 0,
      emailed: 0
    });
    expect(await listConnectionReauthBannerState(BIZ, db)).toEqual([]);
  });
});
