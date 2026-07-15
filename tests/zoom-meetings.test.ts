/**
 * Tests for the dual-transport Zoom meeting operations
 * (src/lib/zoom/meetings.ts): direct-first resolution with the legacy Nango
 * fallback, and the best-effort create/update/delete contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const getActiveZoomConnectionId = vi.fn();
vi.mock("@/lib/db/zoom-connections", () => ({
  getActiveZoomConnectionId: (...args: unknown[]) => getActiveZoomConnectionId(...args)
}));

const listWorkspaceOAuthConnections = vi.fn();
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: (...args: unknown[]) =>
    listWorkspaceOAuthConnections(...args)
}));

const nangoProxyForBusiness = vi.fn();
vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: (...args: unknown[]) => nangoProxyForBusiness(...args)
}));

const zoomRequestForBusiness = vi.fn();
vi.mock("@/lib/zoom/client", () => ({
  zoomRequestForBusiness: (...args: unknown[]) => zoomRequestForBusiness(...args)
}));

import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking,
  resolveZoomTransport,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";

const BIZ = "11111111-1111-4111-8111-111111111111";
const BOOKING = {
  topic: "Estimate call",
  startIso: "2026-07-20T17:00:00.000Z",
  endIso: "2026-07-20T17:30:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  getActiveZoomConnectionId.mockResolvedValue(null);
  listWorkspaceOAuthConnections.mockResolvedValue([]);
  process.env.NANGO_SECRET_KEY = "nango-secret";
});

afterEach(() => {
  delete process.env.NANGO_SECRET_KEY;
});

describe("resolveZoomTransport", () => {
  it("prefers the first-party connection", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    expect(await resolveZoomTransport(BIZ)).toEqual({ kind: "direct" });
    expect(listWorkspaceOAuthConnections).not.toHaveBeenCalled();
  });

  it("falls back to a legacy Nango zoom row", async () => {
    listWorkspaceOAuthConnections.mockResolvedValue([
      { provider_config_key: "google-mail", connection_id: "g-1" },
      { provider_config_key: "zoom", connection_id: "legacy-1" }
    ]);
    expect(await resolveZoomTransport(BIZ)).toEqual({
      kind: "nango",
      connectionId: "legacy-1",
      providerConfigKey: "zoom"
    });
  });

  it("returns null with no connection of either kind", async () => {
    expect(await resolveZoomTransport(BIZ)).toBeNull();
  });

  it("ignores legacy rows when NANGO_SECRET_KEY is unset (degrades, never errors)", async () => {
    delete process.env.NANGO_SECRET_KEY;
    expect(await resolveZoomTransport(BIZ)).toBeNull();
    expect(listWorkspaceOAuthConnections).not.toHaveBeenCalled();
  });
});

describe("createZoomMeetingForBooking", () => {
  it("creates a scheduled meeting over the direct transport", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue({
      data: { id: 987654, join_url: "https://zoom.us/j/987654" }
    });

    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toEqual({
      meetingId: "987654",
      joinUrl: "https://zoom.us/j/987654"
    });
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/users/me/meetings",
      method: "POST",
      data: {
        topic: "Estimate call",
        type: 2,
        start_time: "2026-07-20T17:00:00.000Z",
        duration: 30
      }
    });
  });

  it("includes the agenda when provided and floors duration at 1 minute", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue({
      data: { id: "abc", join_url: "https://zoom.us/j/abc" }
    });
    await createZoomMeetingForBooking(BIZ, {
      ...BOOKING,
      endIso: BOOKING.startIso,
      agenda: "Kitchen sink"
    });
    const [, req] = zoomRequestForBusiness.mock.calls[0] as [string, { data: Record<string, unknown> }];
    expect(req.data.agenda).toBe("Kitchen sink");
    expect(req.data.duration).toBe(1);
  });

  it("routes through the Nango proxy for a legacy connection (with /v2 prefix)", async () => {
    listWorkspaceOAuthConnections.mockResolvedValue([
      { provider_config_key: "zoom", connection_id: "legacy-1" }
    ]);
    nangoProxyForBusiness.mockResolvedValue({
      data: { id: 123, join_url: "https://zoom.us/j/123" }
    });

    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toEqual({
      meetingId: "123",
      joinUrl: "https://zoom.us/j/123"
    });
    expect(nangoProxyForBusiness).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "legacy-1", providerConfigKey: "zoom" },
      expect.objectContaining({ endpoint: "/v2/users/me/meetings", method: "POST" })
    );
    expect(zoomRequestForBusiness).not.toHaveBeenCalled();
  });

  it("returns null when no transport, when the token is dead, or on a junk body", async () => {
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue(null);
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: { id: 1 } }); // no join_url
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockResolvedValue({ data: null });
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();
  });

  it("returns null when the legacy proxy has no usable connection", async () => {
    listWorkspaceOAuthConnections.mockResolvedValue([
      { provider_config_key: "zoom", connection_id: "legacy-1" }
    ]);
    nangoProxyForBusiness.mockResolvedValue(null);
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();
  });

  it("never throws: transport failures (Error and non-Error) degrade to null", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockRejectedValue(new Error("zoom 500"));
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await createZoomMeetingForBooking(BIZ, BOOKING)).toBeNull();
  });
});

describe("updateZoomMeetingForBooking", () => {
  it("PATCHes the meeting time over the live transport", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue({ data: null }); // 204
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(true);
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/meetings/zm-1",
      method: "PATCH",
      data: { start_time: "2026-07-20T17:00:00.000Z", duration: 30 }
    });
  });

  it("reports false with no transport, a dead token, or a transport failure", async () => {
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);

    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue(null);
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);

    zoomRequestForBusiness.mockRejectedValue(new Error("down"));
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await updateZoomMeetingForBooking(BIZ, "zm-1", BOOKING)).toBe(false);
  });
});

describe("deleteZoomMeetingForBooking", () => {
  it("DELETEs a legacy meeting through the Nango proxy without a request body", async () => {
    listWorkspaceOAuthConnections.mockResolvedValue([
      { provider_config_key: "zoom", connection_id: "legacy-1" }
    ]);
    nangoProxyForBusiness.mockResolvedValue({ data: null });
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(true);
    expect(nangoProxyForBusiness).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "legacy-1", providerConfigKey: "zoom" },
      { endpoint: "/v2/meetings/zm-1", method: "DELETE" }
    );
  });

  it("DELETEs the meeting over the live transport", async () => {
    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue({ data: null });
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(true);
    expect(zoomRequestForBusiness).toHaveBeenCalledWith(BIZ, {
      endpoint: "/meetings/zm-1",
      method: "DELETE"
    });
  });

  it("reports false with no transport, a dead token, or a transport failure", async () => {
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);

    getActiveZoomConnectionId.mockResolvedValue("zc-1");
    zoomRequestForBusiness.mockResolvedValue(null);
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);

    zoomRequestForBusiness.mockRejectedValue(new Error("down"));
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);

    zoomRequestForBusiness.mockRejectedValue("raw string failure");
    expect(await deleteZoomMeetingForBooking(BIZ, "zm-1")).toBe(false);
  });
});
