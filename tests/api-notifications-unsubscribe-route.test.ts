import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/notification-preferences", () => ({
  updateNotificationPreferences: vi.fn()
}));

import { GET, POST } from "@/app/api/notifications/unsubscribe/route";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { CHANNEL_TOGGLE_KEYS } from "@/lib/notifications/channel-toggles";

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

  it("GET NEVER unsubscribes: it asks first, so a link scanner cannot silence a tenant", async () => {
    // The defect: any corporate mail scanner or link prefetcher that follows
    // links would switch off email, SMS, WhatsApp, dashboard, and
    // warm-transfer alerts for the business, with nobody told it happened.
    const res = await GET(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(updateNotificationPreferences).not.toHaveBeenCalled();

    const body = await res.text();
    // A real form POSTing back to this same endpoint, carrying the bid.
    expect(body).toContain('method="post"');
    expect(body).toContain(`value="${BIZ}"`);
    expect(body).toContain('name="ui"');
    expect(body).not.toContain("You've been unsubscribed");
  });

  it("the confirming POST is what actually writes, and reports back in HTML", async () => {
    const body = new URLSearchParams({ bid: BIZ, ui: "1" }).toString();
    const res = await POST(
      new Request("http://localhost/api/notifications/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      })
    );
    expect(res.status).toBe(200);
    // A person who just clicked a button gets a page, not a bare word.
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("You've been unsubscribed");
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        sms_urgent: false,
        whatsapp_urgent: false,
        email_digest: false,
        email_urgent: false,
        dashboard_alerts: false,
        unsubscribed_at: expect.any(String)
      })
    );
  });

  it("the full unsubscribe clears EVERY channel toggle, not the handful it used to", async () => {
    // Hand-listing the payload here is what left whatsapp_urgent, then
    // push_urgent (#1717), then all five chat channels of #1718-#1724
    // rendering ON underneath the "you unsubscribed" banner. It is not a
    // delivery bug (dispatch suppresses on unsubscribed_at alone), so the
    // dashboard was the only place it showed, and nothing failed until
    // someone read it. Asserting against the shared list rather than a
    // second hand-written one is the point: the next channel is covered the
    // day it is added, not the day someone remembers this test.
    await POST(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`, {
        method: "POST"
      })
    );
    const patch = vi.mocked(updateNotificationPreferences).mock.calls[0]![1];
    for (const key of CHANNEL_TOGGLE_KEYS) {
      expect(patch[key], `${key} is missing from the unsubscribe payload`).toBe(false);
    }
    expect(patch.unsubscribed_at).toEqual(expect.any(String));
  });

  it("a ui=1 POST that fails renders the error as a page, not as plain text", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue(new Error("db down"));
    const body = new URLSearchParams({ bid: BIZ, ui: "1" }).toString();
    const res = await POST(
      new Request("http://localhost/api/notifications/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      })
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
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

  it("POST surfaces a 500 when the DB write throws a non-Error value", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValue("plain string");
    const res = await POST(
      new Request(`http://localhost/api/notifications/unsubscribe?bid=${BIZ}`, {
        method: "POST"
      })
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

  describe("the monthly-recap scope", () => {
    const url = (extra = "") =>
      `http://localhost/api/notifications/unsubscribe?bid=${BIZ}&scope=monthly_recap${extra}`;

    it("asks about the recap only, and says the alerts survive", async () => {
      const res = await GET(new Request(url()));
      const body = await res.text();
      expect(body).toContain("monthly recap email only");
      expect(body).toContain('value="monthly_recap"');
      expect(updateNotificationPreferences).not.toHaveBeenCalled();
    });

    it("clears ONE flag and does not mark the business unsubscribed", async () => {
      // The defect this closes: an owner who merely did not want a monthly
      // summary would otherwise have lost urgent lead alerts on every channel.
      const res = await POST(new Request(url("&ui=1"), { method: "POST" }));
      expect(res.status).toBe(200);
      expect(updateNotificationPreferences).toHaveBeenCalledWith(BIZ, {
        email_monthly_recap: false
      });
      // Exactly one key, and no unsubscribed_at: the scoped path must NOT
      // pick up new channels as the shared list grows.
      const patch = vi.mocked(updateNotificationPreferences).mock.calls[0]![1];
      expect(Object.keys(patch)).toEqual(["email_monthly_recap"]);
      expect(await res.text()).toContain("Monthly recap turned off");
    });

    it("reads the scope out of the form body too", async () => {
      await POST(
        new Request("http://localhost/api/notifications/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ bid: BIZ, ui: "1", scope: "monthly_recap" }).toString()
        })
      );
      expect(updateNotificationPreferences).toHaveBeenCalledWith(BIZ, {
        email_monthly_recap: false
      });
    });

    it("reports a write failure instead of claiming success", async () => {
      vi.mocked(updateNotificationPreferences).mockRejectedValue(new Error("nope"));
      const res = await POST(new Request(url("&ui=1"), { method: "POST" }));
      expect(res.status).toBe(500);
    });

    it("falls back to the FULL unsubscribe for an unrecognized scope", async () => {
      // The mail-client one-click header carries no scope, and for that
      // gesture "everything" is the right reading.
      await POST(
        new Request(
          `http://localhost/api/notifications/unsubscribe?bid=${BIZ}&scope=something-else`,
          { method: "POST" }
        )
      );
      const patch = vi.mocked(updateNotificationPreferences).mock.calls[0]![1];
      expect(patch).toMatchObject({ email_monthly_recap: false, email_urgent: false });
      expect(patch.unsubscribed_at).toEqual(expect.any(String));
    });
  });
});
