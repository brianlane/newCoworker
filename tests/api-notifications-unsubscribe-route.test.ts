import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/notification-preferences", () => ({
  updateNotificationPreferences: vi.fn()
}));

import { GET, POST } from "@/app/api/notifications/unsubscribe/route";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { signUnsubscribeToken } from "@/lib/notifications/unsubscribe-token";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("api/notifications/unsubscribe route", () => {
  const original = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...original,
      NOTIFICATIONS_UNSUBSCRIBE_SECRET: "test-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com"
    };
    vi.mocked(updateNotificationPreferences).mockResolvedValue({} as never);
  });
  afterEach(() => {
    process.env = original;
  });

  it("GET with valid token flips toggles off and sets unsubscribed_at", async () => {
    const token = signUnsubscribeToken(BIZ)!;
    const res = await GET(
      new Request(
        `http://localhost/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        sms_urgent: false,
        email_digest: false,
        email_urgent: false,
        dashboard_alerts: false,
        unsubscribed_at: expect.any(String)
      })
    );
  });

  it("GET with no token returns 400 and does not write", async () => {
    const res = await GET(new Request("http://localhost/api/notifications/unsubscribe"));
    expect(res.status).toBe(400);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("GET with tampered token returns 400 (invalid)", async () => {
    const token = signUnsubscribeToken(BIZ)!;
    const tampered = token.slice(0, -2) + "AA";
    const res = await GET(
      new Request(
        `http://localhost/api/notifications/unsubscribe?token=${encodeURIComponent(tampered)}`
      )
    );
    // bad signature → 400
    expect([400, 410]).toContain(res.status);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("GET with secret unset returns 503", async () => {
    delete process.env.NOTIFICATIONS_UNSUBSCRIBE_SECRET;
    const res = await GET(
      new Request(
        `http://localhost/api/notifications/unsubscribe?token=ANY`
      )
    );
    expect(res.status).toBe(503);
  });

  it("GET surfaces 500 page when DB write throws", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue(new Error("db down"));
    const token = signUnsubscribeToken(BIZ)!;
    const res = await GET(
      new Request(
        `http://localhost/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`
      )
    );
    expect(res.status).toBe(500);
  });

  it("POST one-click flow with token in querystring returns 200 plain text", async () => {
    const token = signUnsubscribeToken(BIZ)!;
    const res = await POST(
      new Request(
        `http://localhost/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
        { method: "POST" }
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unsubscribed");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("POST one-click flow with token in form body returns 200", async () => {
    const token = signUnsubscribeToken(BIZ)!;
    const body = new URLSearchParams({ token, "List-Unsubscribe": "One-Click" }).toString();
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      })
    );
    expect(res.status).toBe(200);
  });

  it("POST without a token returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/notifications/unsubscribe", { method: "POST" })
    );
    expect(res.status).toBe(400);
  });

  it("POST is idempotent: second call still succeeds", async () => {
    const token = signUnsubscribeToken(BIZ)!;
    const url = `http://localhost/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
    const r1 = await POST(new Request(url, { method: "POST" }));
    const r2 = await POST(new Request(url, { method: "POST" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledTimes(2);
  });
});
