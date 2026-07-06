/**
 * Tests for the dedicated shared "NewCoworker" calendar module
 * (src/lib/calendar-tools/shared-calendar.ts): lazy creation via the Nango
 * proxy, metadata persistence on the connection row, employee ACL grants,
 * and the best-effort time-off mirror events.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn(),
  upsertWorkspaceOAuthConnection: vi.fn()
}));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn() }));

import {
  ensureSharedCalendar,
  getSharedCalendar,
  mirrorTimeOffEvent,
  nextDayIsoDate,
  removeTimeOffEvent,
  shareSharedCalendarWithEmployees,
  sharedCalendarStatus
} from "@/lib/calendar-tools/shared-calendar";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import {
  listWorkspaceOAuthConnections,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { listTeamMembers } from "@/lib/db/employees";

const BIZ = "11111111-1111-4111-8111-111111111111";

const GOOGLE_CONN = {
  provider: "google",
  connectionId: "conn-1",
  providerConfigKey: "google-calendar"
} as never;
const MS_CONN = {
  provider: "microsoft",
  connectionId: "conn-2",
  providerConfigKey: "outlook-calendar"
} as never;

function connRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    provider_config_key: "google-calendar",
    connection_id: "conn-1",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  } as never;
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    business_id: BIZ,
    name: "Sam",
    phone_e164: "+15550000001",
    email: "sam@example.com",
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCalendarConnection).mockResolvedValue(GOOGLE_CONN);
  vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([connRow()]);
  vi.mocked(upsertWorkspaceOAuthConnection).mockResolvedValue(connRow());
  vi.mocked(listTeamMembers).mockResolvedValue([]);
});

describe("nextDayIsoDate", () => {
  it("advances one day, including across month and year boundaries", () => {
    expect(nextDayIsoDate("2026-06-12")).toBe("2026-06-13");
    expect(nextDayIsoDate("2026-06-30")).toBe("2026-07-01");
    expect(nextDayIsoDate("2026-12-31")).toBe("2027-01-01");
    expect(nextDayIsoDate("2028-02-28")).toBe("2028-02-29"); // leap year
  });
});

describe("getSharedCalendar", () => {
  it("returns null when no calendar connection exists", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });

  it("returns null when the connection row has no shared calendar yet", async () => {
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });

  it("returns null when no row matches the resolved connection", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ connection_id: "other-conn" })
    ]);
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });

  it("returns the stored calendar id with its connection", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9" } })
    ]);
    expect(await getSharedCalendar(BIZ)).toEqual({ calendarId: "cal-9", conn: GOOGLE_CONN });
  });

  it("ignores a non-string or empty shared_calendar_id", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "" } })
    ]);
    expect(await getSharedCalendar(BIZ)).toBeNull();
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: 42 } })
    ]);
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });

  it("tolerates a row with null metadata", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([connRow({ metadata: null })]);
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });

  it("swallows lookup errors (Error and non-Error)", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockRejectedValue(new Error("db down"));
    expect(await getSharedCalendar(BIZ)).toBeNull();
    vi.mocked(listWorkspaceOAuthConnections).mockRejectedValue("string failure");
    expect(await getSharedCalendar(BIZ)).toBeNull();
  });
});

describe("ensureSharedCalendar", () => {
  it("returns null when no calendar connection exists", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await ensureSharedCalendar(BIZ)).toBeNull();
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("returns the existing calendar without creating a new one", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9" } })
    ]);
    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "cal-9", conn: GOOGLE_CONN });
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("creates a Google calendar and persists its id, preserving other metadata", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { other_key: "keep" } })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "new-cal" } } as never);
    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "new-cal", conn: GOOGLE_CONN });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({
        endpoint: "/calendar/v3/calendars",
        method: "POST",
        data: { summary: "NewCoworker" }
      })
    );
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).toHaveBeenCalledWith({
      businessId: BIZ,
      providerConfigKey: "google-calendar",
      connectionId: "conn-1",
      metadata: { other_key: "keep", shared_calendar_id: "new-cal" }
    });
  });

  it("creates a Microsoft calendar via the Graph endpoint", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ provider_config_key: "outlook-calendar", connection_id: "conn-2" })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ms-cal" } } as never);
    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "ms-cal", conn: MS_CONN });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "outlook-calendar" },
      expect.objectContaining({
        endpoint: "/v1.0/me/calendars",
        method: "POST",
        data: { name: "NewCoworker" }
      })
    );
  });

  it("returns null when creation yields no id (Google and Microsoft)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    expect(await ensureSharedCalendar(BIZ)).toBeNull();

    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await ensureSharedCalendar(BIZ)).toBeNull();

    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ provider_config_key: "outlook-calendar", connection_id: "conn-2" })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await ensureSharedCalendar(BIZ)).toBeNull();
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).not.toHaveBeenCalled();
  });

  it("returns null when the create call throws (Error and non-Error)", async () => {
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    expect(await ensureSharedCalendar(BIZ)).toBeNull();
    vi.mocked(nangoProxyForBusiness).mockRejectedValue("string failure");
    expect(await ensureSharedCalendar(BIZ)).toBeNull();
  });

  it("race loser: prefers the id a concurrent caller stored and deletes its own duplicate", async () => {
    // First meta read: no calendar yet; recheck after create: another caller
    // already persisted "cal-winner".
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([connRow()])
      .mockResolvedValueOnce([connRow({ metadata: { shared_calendar_id: "cal-winner" } })]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "cal-dup" } } as never);

    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "cal-winner", conn: GOOGLE_CONN });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      { endpoint: "/calendar/v3/calendars/cal-dup", method: "DELETE" }
    );
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).not.toHaveBeenCalled();
  });

  it("race loser: deletes the Microsoft duplicate via the Graph endpoint", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([
        connRow({ provider_config_key: "outlook-calendar", connection_id: "conn-2" })
      ])
      .mockResolvedValueOnce([
        connRow({
          provider_config_key: "outlook-calendar",
          connection_id: "conn-2",
          metadata: { shared_calendar_id: "ms-winner" }
        })
      ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ms-dup" } } as never);

    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "ms-winner", conn: MS_CONN });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "outlook-calendar" },
      { endpoint: "/v1.0/me/calendars/ms-dup", method: "DELETE" }
    );
  });

  it("race loser: still returns the winner when the duplicate cleanup delete fails", async () => {
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([connRow()])
      .mockResolvedValueOnce([connRow({ metadata: { shared_calendar_id: "cal-winner" } })]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({ data: { id: "cal-dup" } } as never)
      .mockRejectedValueOnce(new Error("delete 403"));

    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "cal-winner", conn: GOOGLE_CONN });
  });

  it("race loser: tolerates a non-Error cleanup rejection", async () => {
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([connRow()])
      .mockResolvedValueOnce([connRow({ metadata: { shared_calendar_id: "cal-winner" } })]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({ data: { id: "cal-dup" } } as never)
      .mockRejectedValueOnce("string failure");

    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "cal-winner", conn: GOOGLE_CONN });
  });

  it("writes normally when the recheck shows our own id (idempotent double-write)", async () => {
    vi.mocked(listWorkspaceOAuthConnections)
      .mockResolvedValueOnce([connRow()])
      .mockResolvedValueOnce([connRow({ metadata: { shared_calendar_id: "new-cal" } })]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "new-cal" } } as never);

    expect(await ensureSharedCalendar(BIZ)).toEqual({ calendarId: "new-cal", conn: GOOGLE_CONN });
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).toHaveBeenCalled();
  });
});

describe("sharedCalendarStatus", () => {
  it("reports not-connected as null with an empty share list", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await sharedCalendarStatus(BIZ)).toEqual({ calendarId: null, sharedWith: [] });
  });

  it("reports the stored calendar id and ACL, dropping non-string entries", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({
        metadata: { shared_calendar_id: "cal-9", shared_calendar_acl: ["a@x.com", 42, "b@x.com"] }
      })
    ]);
    expect(await sharedCalendarStatus(BIZ)).toEqual({
      calendarId: "cal-9",
      sharedWith: ["a@x.com", "b@x.com"]
    });
  });

  it("treats a non-array ACL as empty", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9", shared_calendar_acl: "nope" } })
    ]);
    expect(await sharedCalendarStatus(BIZ)).toEqual({ calendarId: "cal-9", sharedWith: [] });
  });

  it("degrades to empty status on errors (Error and non-Error)", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockRejectedValue(new Error("db down"));
    expect(await sharedCalendarStatus(BIZ)).toEqual({ calendarId: null, sharedWith: [] });
    vi.mocked(listWorkspaceOAuthConnections).mockRejectedValue("string failure");
    expect(await sharedCalendarStatus(BIZ)).toEqual({ calendarId: null, sharedWith: [] });
  });
});

describe("shareSharedCalendarWithEmployees", () => {
  const withSharedCalendar = (acl: unknown[] = []) => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9", shared_calendar_acl: acl } })
    ]);
  };

  it("fails with calendar_not_connected when the calendar can't be ensured", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null as never);
    expect(await shareSharedCalendarWithEmployees(BIZ)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("grants Google read access to new employee emails and persists the ACL", async () => {
    withSharedCalendar(["old@x.com"]);
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ id: "m-1", email: "Sam@Example.com " }), // trims + lowercases
      member({ id: "m-2", email: "sam@example.com" }), // duplicate → one grant
      member({ id: "m-3", email: "OLD@x.com" }), // already granted → skipped
      member({ id: "m-4", email: null }), // no email → skipped
      member({ id: "m-5", email: "  " }) // blank → skipped
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await shareSharedCalendarWithEmployees(BIZ);
    expect(result).toEqual({
      ok: true,
      calendarId: "cal-9",
      sharedWith: ["old@x.com", "sam@example.com"],
      added: 1,
      failed: 0
    });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({
        endpoint: "/calendar/v3/calendars/cal-9/acl",
        data: { role: "reader", scope: { type: "user", value: "sam@example.com" } }
      })
    );
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          shared_calendar_id: "cal-9",
          shared_calendar_acl: ["old@x.com", "sam@example.com"]
        })
      })
    );
  });

  it("grants Microsoft read access via calendarPermissions", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({
        provider_config_key: "outlook-calendar",
        connection_id: "conn-2",
        metadata: { shared_calendar_id: "ms-cal" }
      })
    ]);
    vi.mocked(listTeamMembers).mockResolvedValue([member({ email: "sam@example.com" })]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const result = await shareSharedCalendarWithEmployees(BIZ);
    expect(result).toMatchObject({ ok: true, added: 1, failed: 0 });
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "outlook-calendar" },
      expect.objectContaining({
        endpoint: "/v1.0/me/calendars/ms-cal/calendarPermissions",
        data: { emailAddress: { address: "sam@example.com" }, role: "read" }
      })
    );
  });

  it("counts per-email failures without aborting the rest (null, Error, non-Error)", async () => {
    withSharedCalendar();
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ id: "m-1", email: "a@x.com" }),
      member({ id: "m-2", email: "b@x.com" }),
      member({ id: "m-3", email: "c@x.com" }),
      member({ id: "m-4", email: "d@x.com" })
    ]);
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce(null as never) // a: proxy returned null
      .mockRejectedValueOnce(new Error("403")) // b: Error
      .mockRejectedValueOnce("string failure" as never) // c: non-Error
      .mockResolvedValueOnce({ data: {} } as never); // d: success
    const result = await shareSharedCalendarWithEmployees(BIZ);
    expect(result).toEqual({
      ok: true,
      calendarId: "cal-9",
      sharedWith: ["d@x.com"],
      added: 1,
      failed: 3
    });
  });

  it("skips the metadata write when nothing new was granted", async () => {
    withSharedCalendar(["sam@example.com"]);
    vi.mocked(listTeamMembers).mockResolvedValue([member({ email: "sam@example.com" })]);
    const result = await shareSharedCalendarWithEmployees(BIZ);
    expect(result).toEqual({
      ok: true,
      calendarId: "cal-9",
      sharedWith: ["sam@example.com"],
      added: 0,
      failed: 0
    });
    expect(vi.mocked(upsertWorkspaceOAuthConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("maps unexpected errors to share_failed (Error and non-Error)", async () => {
    withSharedCalendar();
    vi.mocked(listTeamMembers).mockRejectedValue(new Error("db down"));
    expect(await shareSharedCalendarWithEmployees(BIZ)).toEqual({
      ok: false,
      detail: "share_failed"
    });
    vi.mocked(listTeamMembers).mockRejectedValue("string failure");
    expect(await shareSharedCalendarWithEmployees(BIZ)).toEqual({
      ok: false,
      detail: "share_failed"
    });
  });
});

describe("mirrorTimeOffEvent", () => {
  const withSharedCalendar = () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9" } })
    ]);
  };

  it("skips when there is no shared calendar yet (never creates one)", async () => {
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("creates an all-day Google event with an exclusive end date", async () => {
    withSharedCalendar();
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ev-1" } } as never);
    const id = await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-13");
    expect(id).toBe("ev-1");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      expect.objectContaining({
        endpoint: "/calendar/v3/calendars/cal-9/events",
        data: expect.objectContaining({
          summary: "Sam: out of office",
          start: { date: "2026-06-12" },
          end: { date: "2026-06-14" }
        })
      })
    );
  });

  it("returns null when the Google response carries no id or is null", async () => {
    withSharedCalendar();
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
  });

  it("creates an all-day Microsoft event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({
        provider_config_key: "outlook-calendar",
        connection_id: "conn-2",
        metadata: { shared_calendar_id: "ms-cal" }
      })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "ms-ev" } } as never);
    const id = await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12");
    expect(id).toBe("ms-ev");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "outlook-calendar" },
      expect.objectContaining({
        endpoint: "/v1.0/me/calendars/ms-cal/events",
        data: expect.objectContaining({
          subject: "Sam: out of office",
          isAllDay: true,
          start: { dateTime: "2026-06-12T00:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-06-13T00:00:00", timeZone: "UTC" }
        })
      })
    );
  });

  it("returns null when the Microsoft proxy responds null", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({
        provider_config_key: "outlook-calendar",
        connection_id: "conn-2",
        metadata: { shared_calendar_id: "ms-cal" }
      })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
  });

  it("swallows push failures (Error and non-Error)", async () => {
    withSharedCalendar();
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
    vi.mocked(nangoProxyForBusiness).mockRejectedValue("string failure");
    expect(await mirrorTimeOffEvent(BIZ, "Sam", "2026-06-12", "2026-06-12")).toBeNull();
  });
});

describe("removeTimeOffEvent", () => {
  it("does nothing when there is no shared calendar", async () => {
    await removeTimeOffEvent(BIZ, "ev-1");
    expect(vi.mocked(nangoProxyForBusiness)).not.toHaveBeenCalled();
  });

  it("deletes the Google mirror event", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9" } })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: "" } as never);
    await removeTimeOffEvent(BIZ, "ev-1");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-1", providerConfigKey: "google-calendar" },
      { endpoint: "/calendar/v3/calendars/cal-9/events/ev-1", method: "DELETE" }
    );
  });

  it("deletes the Microsoft mirror event", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(MS_CONN);
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({
        provider_config_key: "outlook-calendar",
        connection_id: "conn-2",
        metadata: { shared_calendar_id: "ms-cal" }
      })
    ]);
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: "" } as never);
    await removeTimeOffEvent(BIZ, "ms-ev");
    expect(vi.mocked(nangoProxyForBusiness)).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "conn-2", providerConfigKey: "outlook-calendar" },
      { endpoint: "/v1.0/me/calendars/ms-cal/events/ms-ev", method: "DELETE" }
    );
  });

  it("swallows delete failures (Error and non-Error)", async () => {
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([
      connRow({ metadata: { shared_calendar_id: "cal-9" } })
    ]);
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("nango 502"));
    await expect(removeTimeOffEvent(BIZ, "ev-1")).resolves.toBeUndefined();
    vi.mocked(nangoProxyForBusiness).mockRejectedValue("string failure");
    await expect(removeTimeOffEvent(BIZ, "ev-1")).resolves.toBeUndefined();
  });
});
