import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
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
import { getAuthUser, requireBusinessRole } from "@/lib/auth";

const OWNER = {
  userId: "user-1",
  email: "owner@example.com",
  isAdmin: false
};

const PREFS = {
  business_id: "11111111-1111-4111-8111-111111111111",
  sms_urgent: true,
  email_digest: true,
  email_digest_weekly: true,
  email_urgent: true,
  dashboard_alerts: true,
  phone_number: null,
  alert_email: null,
  unsubscribed_at: null,
  updated_at: "2026-01-01T00:00:00Z"
};

describe("api/notifications/preferences route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
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
    expect(requireBusinessRole).toHaveBeenCalledWith(PREFS.business_id, "manage_settings");
  });

  it("GET mints the row on first read, for an impersonating admin too", async () => {
    // The row is business-scoped and the businessId is explicit, so there is
    // no wrong-tenant hazard to suppress: an admin in view-as gets the same
    // create-if-missing behavior as the owner's first visit, and lands on a
    // working page instead of a preview built from in-memory defaults.
    const response = await GET(
      new Request(
        `http://localhost/api/notifications/preferences?businessId=${PREFS.business_id}`
      )
    );
    expect(response.status).toBe(200);
    expect(getOrCreateNotificationPreferences).toHaveBeenCalledWith(PREFS.business_id);
  });

  it("POST saves against the businessId in the body, not the caller", async () => {
    // What keeps view-as writes on the right tenant: the patch target is the
    // request's businessId (role-checked through requireBusinessRole, which
    // admins pass), never a business re-derived from the signed-in user.
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: PREFS.business_id, sms_urgent: false })
      })
    );

    expect(response.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(PREFS.business_id, "manage_settings");
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ sms_urgent: false })
    );
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

  it("normalizes empty phone_number and alert_email to null", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          phone_number: "   ",
          alert_email: ""
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({
        phone_number: null,
        alert_email: null
      })
    );
  });

  it("coerces a bare 10-digit US/Canada phone to E.164 before persisting (Amy's '6026951142' failed its first urgent SMS as Telnyx 40310)", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          phone_number: "602-695-1142"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ phone_number: "+16026951142" })
    );
  });

  it("preserves an already-E.164 phone as-is", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          phone_number: "+14164560696"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ phone_number: "+14164560696" })
    );
  });

  it("rejects a phone that cannot be safely coerced to E.164 instead of storing a landmine", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          phone_number: "555-1234"
        })
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("passes email_digest_weekly through to the update", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          email_digest_weekly: false
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ email_digest_weekly: false })
    );
  });

  it("passes digest_customer_facing_only through to the update", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          digest_customer_facing_only: true
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ digest_customer_facing_only: true })
    );
  });

  it("passes whatsapp_replaces_sms through to the update", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          whatsapp_replaces_sms: true
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ whatsapp_replaces_sms: true })
    );
  });

  it("normalizes digest recipient overrides: trims values, blanks become null", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          digest_email_daily: "daily@biz.com",
          digest_email_weekly: ""
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({
        digest_email_daily: "daily@biz.com",
        digest_email_weekly: null
      })
    );
  });

  it("rejects malformed digest recipient emails", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          digest_email_daily: "not-an-email"
        })
      })
    );
    expect(response.status).toBe(400);
  });

  it("translates unsubscribed_at:'now' into an ISO timestamp", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          sms_urgent: false,
          email_digest: false,
          email_urgent: false,
          dashboard_alerts: false,
          unsubscribed_at: "now"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({
        sms_urgent: false,
        email_digest: false,
        email_urgent: false,
        dashboard_alerts: false,
        unsubscribed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      })
    );
  });

  it("translates unsubscribed_at:'clear' into null", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          unsubscribed_at: "clear"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      PREFS.business_id,
      expect.objectContaining({ unsubscribed_at: null })
    );
  });

  it("rejects unsupported unsubscribed_at values", async () => {
    const response = await POST(
      new Request("http://localhost/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: PREFS.business_id,
          unsubscribed_at: "yesterday"
        })
      })
    );
    expect(response.status).toBe(400);
  });
});
