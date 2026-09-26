import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/cal-connections", () => ({
  getCalConnectionById: vi.fn(),
  updateCalTokens: vi.fn(),
  markCalHealthy: vi.fn()
}));
vi.mock("@/lib/connections/reauth", () => ({
  markConnectionNeedsReauth: vi.fn()
}));
vi.mock("@/lib/cal/oauth", () => ({
  refreshCalTokens: vi.fn(),
  CalOAuthError: class CalOAuthError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
}));

import { markConnectionNeedsReauth } from "@/lib/connections/reauth";
import { CalOAuthError, refreshCalTokens } from "@/lib/cal/oauth";
import { markCalHealthy, updateCalTokens } from "@/lib/db/cal-connections";
import {
  CalApiError,
  cancelCalBooking,
  createCalBooking,
  createCalWebhook,
  fetchCalProfile,
  listCalEventTypes,
  listCalSlotStarts,
  rescheduleCalBooking
} from "@/lib/cal/client";

const CONN = {
  id: "cal-1",
  accessToken: "access",
  refreshToken: "refresh",
  token_expires_at: "2099-01-01T00:00:00.000Z",
  needs_reauth: false
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("Cal.com API client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists, books, cancels, reschedules, and registers a webhook", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/event-types")) return jsonResponse({ data: [{ id: 1, title: "Intro", lengthInMinutes: 30 }] });
        if (String(url).includes("/slots")) return jsonResponse({ data: { day: [{ start: "2027-01-01T15:00:00.000Z" }] } });
        if (String(url).includes("/cancel")) return jsonResponse({ status: "success" });
        if (String(url).includes("/reschedule")) return jsonResponse({ data: { uid: "bk_2" } });
        if (String(url).includes("/webhooks")) return jsonResponse({ data: { id: "wh_1" } });
        if (String(url).includes("/bookings")) return jsonResponse({ data: { uid: "bk_1" } });
        return jsonResponse({}, 500);
      })
    );
    await expect(listCalEventTypes(CONN as never)).resolves.toEqual([{ id: "1", title: "Intro", lengthMinutes: 30 }]);
    await expect(
      listCalSlotStarts(CONN as never, {
        eventTypeId: "1",
        startIso: "2027-01-01T00:00:00.000Z",
        endIso: "2027-01-02T00:00:00.000Z",
        timeZone: "UTC"
      })
    ).resolves.toEqual(["2027-01-01T15:00:00.000Z"]);
    await expect(
      createCalBooking(CONN as never, {
        eventTypeId: "1",
        startIso: "2027-01-01T15:00:00.000Z",
        name: "Ada",
        email: "a@b.co",
        timeZone: "UTC",
        phone: "+1555",
        notes: "hi"
      })
    ).resolves.toBe("bk_1");
    await cancelCalBooking(CONN as never, "bk_1");
    await expect(rescheduleCalBooking(CONN as never, "bk_1", "2027-01-02T15:00:00.000Z")).resolves.toBe("bk_2");
    await expect(createCalWebhook(CONN as never, { subscriberUrl: "https://example.com/hook", secret: "s" })).resolves.toBe(
      "wh_1"
    );
    expect(markCalHealthy).toHaveBeenCalled();
  });

  it("refreshes an expiring token and marks reconnect on rejection", async () => {
    const expiring = { ...CONN, token_expires_at: "2000-01-01T00:00:00.000Z" };
    vi.mocked(refreshCalTokens).mockResolvedValue({
      accessToken: "new",
      refreshToken: "new-r",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));
    await listCalEventTypes(expiring as never);
    expect(updateCalTokens).toHaveBeenCalled();

    vi.mocked(refreshCalTokens).mockRejectedValue(new CalOAuthError("invalid_grant", "dead", 400));
    const stillExpired = { ...CONN, token_expires_at: "2000-01-01T00:00:00.000Z" };
    await expect(listCalEventTypes(stillExpired as never)).rejects.toBeInstanceOf(CalApiError);
    expect(markConnectionNeedsReauth).toHaveBeenCalledWith("cal_connections", "cal-1");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "no" }, 401)));
    vi.mocked(refreshCalTokens).mockResolvedValue({
      accessToken: "new",
      refreshToken: "new-r",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    });
    const fresh = { ...CONN, token_expires_at: "2099-01-01T00:00:00.000Z" };
    await expect(listCalEventTypes(fresh as never)).rejects.toMatchObject({ code: "needs_reauth" });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "no" }, 500)));
    await expect(listCalEventTypes(fresh as never)).rejects.toMatchObject({ code: "request_failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })
    );
    await expect(listCalEventTypes(fresh as never)).rejects.toMatchObject({ code: "upstream_timeout" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      })
    );
    await expect(listCalEventTypes(fresh as never)).rejects.toMatchObject({ code: "upstream_unreachable" });
    vi.mocked(refreshCalTokens).mockRejectedValue(new Error("blip"));
    await expect(listCalEventTypes(stillExpired as never)).rejects.toThrow("blip");

    await expect(listCalEventTypes({ ...CONN, needs_reauth: true, accessToken: "" } as never)).rejects.toMatchObject({
      code: "needs_reauth"
    });
  });

  it("reads a profile and loads a stored connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { id: 3, email: "a@b.co", name: "Ada" } })));
    await expect(fetchCalProfile("tok")).resolves.toMatchObject({ email: "a@b.co" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(fetchCalProfile("tok")).resolves.toMatchObject({ email: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      })
    );
    await expect(fetchCalProfile("tok")).resolves.toMatchObject({ id: null });
  });
});
