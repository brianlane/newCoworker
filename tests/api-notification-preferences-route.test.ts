import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/notification-preferences", () => ({
  getOrCreateNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn()
}));

import { GET, POST } from "@/app/api/notifications/preferences/route";
import {
  getOrCreateNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { getAuthUser, requireOwner } from "@/lib/auth";

const OWNER = {
  userId: "user-1",
  email: "owner@example.com",
  isAdmin: false
};

const PREFS = {
  business_id: "11111111-1111-4111-8111-111111111111",
  sms_urgent: true,
  email_digest: true,
  email_urgent: true,
  dashboard_alerts: true,
  phone_number: null,
  alert_email: null,
  updated_at: "2026-01-01T00:00:00Z"
};

describe("api/notifications/preferences route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireOwner).mockResolvedValue(OWNER as never);
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS as never);
    vi.mocked(updateNotificationPreferences).mockResolvedValue(PREFS as never);
  });

  it("gets preferences", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/notifications/preferences?businessId=${PREFS.business_id}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(requireOwner).toHaveBeenCalledWith(PREFS.business_id);
  });

  it("returns 400 for invalid POST payloads", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "not-a-uuid",
          sms_urgent: "yes"
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
