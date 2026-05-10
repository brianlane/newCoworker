import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/notification-preferences", () => ({
  updateNotificationPreferences: vi.fn()
}));

import { GET, POST } from "@/app/api/notifications/unsubscribe/route";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("api/notifications/unsubscribe route", () => {
  const original = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...original,
      NEXT_PUBLIC_APP_URL: "https://app.example.com"
    };
    vi.mocked(updateNotificationPreferences).mockResolvedValue({} as never);
  });
  afterEach(() => {
    process.env = original;
  });

  it("GET with a valid bid flips every channel toggle off and stamps unsubscribed_at", async () => {
    const res = await GET(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("You've been unsubscribed");
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

  it("GET without a bid returns the 'invalid' page and does not write", async () => {
    const res = await GET(new Request("http://localhost/api/notifications/unsubscribe"));
    expect(res.status).toBe(400);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("GET with a non-UUID bid returns 400 (invalid) and does not write", async () => {
    const res = await GET(
      new Request("http://localhost/api/notifications/unsubscribe?bid=not-a-uuid")
    );
    expect(res.status).toBe(400);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("GET surfaces a 500 page when the DB write throws", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue(new Error("db down"));
    const res = await GET(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`)
    );
    expect(res.status).toBe(500);
  });

  it("GET surfaces a 500 page when the DB write throws a non-Error value", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue("plain string");
    const res = await GET(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`)
    );
    expect(res.status).toBe(500);
  });

  it("GET falls back to a default app URL in re-subscribe link when env is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = await GET(
      new Request("http://localhost/api/notifications/unsubscribe?bid=not-uuid")
    );
    const html = await res.text();
    expect(html).toContain("https://www.newcoworker.com/dashboard/notifications");
  });

  it("POST one-click flow with bid in querystring returns 200 plain text", async () => {
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`, {
        method: "POST"
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unsubscribed");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("POST one-click flow with bid in form body returns 200", async () => {
    const body = new URLSearchParams({ bid: BIZ, "List-Unsubscribe": "One-Click" }).toString();
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      })
    );
    expect(res.status).toBe(200);
  });

  it("POST without a bid returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/notifications/unsubscribe", { method: "POST" })
    );
    expect(res.status).toBe(400);
  });

  it("POST is idempotent: second call still succeeds", async () => {
    const url = `http://localhost/api/notifications/unsubscribe?bid=${BIZ}`;
    const r1 = await POST(new Request(url, { method: "POST" }));
    const r2 = await POST(new Request(url, { method: "POST" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  it("POST returns 500 with explanatory body when DB write throws", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue(new Error("boom"));
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`, {
        method: "POST"
      })
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("error");
  });

  it("POST ignores non-form bodies and returns 400 when no bid in URL either", async () => {
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bid: BIZ })
      })
    );
    expect(res.status).toBe(400);
  });
});
