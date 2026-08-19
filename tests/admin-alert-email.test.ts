import { describe, expect, it } from "vitest";
import {
  resolveAdminAlertConfig,
  sendAdminAlertEmail,
  shouldSendAdminAlert
} from "../supabase/functions/_shared/admin_alert_email.ts";

/**
 * One way for a background sweep to reach a human.
 *
 * Written because two alert paths believed they paged someone and did not.
 * `voice-bridge-health-alerts` posts only to `ALERT_WEBHOOK_URL`, which has
 * never been set in production, so its every-5-minute check that a tenant's
 * voice bridge is alive has only ever written rows; a dead bridge means that
 * client's calls are failing right now. The call-integrity sweep shipped with
 * the same borrowed mistake.
 *
 * Email is what the platform actually uses (chat-spend-velocity-alerts,
 * voice-capacity-monitor, notifications-digest all resolve the same three env
 * vars and send via Resend), and every one of those vars is already set in
 * production. This is that pattern extracted once instead of copied a fourth
 * and fifth time, which is the drift that caused the bug this whole thread
 * started from.
 */

const env = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    RESEND_API_KEY: "re_test",
    ADMIN_EMAIL: "admin@example.com",
    MAILER_EMAIL: "New Coworker <contact@example.com>"
  };
  return (name: string) => (name in over ? over[name] : base[name]);
};

describe("resolveAdminAlertConfig", () => {
  it("prefers the dedicated alert address over the general ones", () => {
    const cfg = resolveAdminAlertConfig(
      env({ ADMIN_ALERT_EMAIL: "alerts@example.com", CONTACT_EMAIL: "hi@example.com" })
    );
    expect(cfg?.to).toBe("alerts@example.com");
  });

  it("falls back ADMIN_EMAIL then CONTACT_EMAIL, matching the sibling alerts", () => {
    expect(resolveAdminAlertConfig(env())?.to).toBe("admin@example.com");
    expect(
      resolveAdminAlertConfig(env({ ADMIN_EMAIL: undefined, CONTACT_EMAIL: "hi@example.com" }))?.to
    ).toBe("hi@example.com");
  });

  it("returns null when it cannot send, rather than pretending", () => {
    // An alerter that silently no-ops is the failure being fixed here, so
    // "unconfigured" has to be a value the caller must handle.
    expect(resolveAdminAlertConfig(env({ RESEND_API_KEY: undefined }))).toBeNull();
    expect(
      resolveAdminAlertConfig(env({ ADMIN_EMAIL: undefined, CONTACT_EMAIL: undefined }))
    ).toBeNull();
    expect(resolveAdminAlertConfig(env({ RESEND_API_KEY: "   " }))).toBeNull();
  });

  it("defaults the sender when MAILER_EMAIL is unset", () => {
    const cfg = resolveAdminAlertConfig(env({ MAILER_EMAIL: undefined }));
    expect(cfg?.from).toContain("@");
  });

  it("trims stray whitespace so a padded secret still sends", () => {
    const cfg = resolveAdminAlertConfig(env({ ADMIN_EMAIL: "  admin@example.com  " }));
    expect(cfg?.to).toBe("admin@example.com");
  });
});

describe("shouldSendAdminAlert", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");

  it("sends when nothing has been sent before", () => {
    expect(shouldSendAdminAlert(null, now, 60)).toBe(true);
  });

  it("stays quiet inside the window, which is what stops a 5-minute flood", () => {
    // voice-bridge-health-alerts runs every 5 minutes and re-detects the same
    // stale bridge each time. Without this it would email 12 times an hour
    // until someone muted it, and a muted alert is the same as no alert.
    expect(shouldSendAdminAlert("2026-08-19T11:30:00Z", now, 60)).toBe(false);
  });

  it("sends again once the window has passed", () => {
    expect(shouldSendAdminAlert("2026-08-19T10:59:00Z", now, 60)).toBe(true);
  });

  it("sends when the last-sent stamp is unreadable, failing loud not silent", () => {
    expect(shouldSendAdminAlert("not-a-date", now, 60)).toBe(true);
  });
});

describe("sendAdminAlertEmail", () => {
  const cfg = { to: "admin@example.com", from: "nc@example.com", resendKey: "re_test" };

  it("posts to Resend with the subject and text", async () => {
    let seen: { url: string; body: string; auth: string } | null = null;
    const res = await sendAdminAlertEmail(
      async (url, init) => {
        seen = {
          url,
          body: String(init?.body ?? ""),
          auth: String(init?.headers?.Authorization ?? "")
        };
        return { ok: true, status: 200, text: async () => "" };
      },
      cfg,
      { subject: "2 call-integrity failures", text: "body here" }
    );
    expect(res).toBe("sent");
    expect(seen!.url).toBe("https://api.resend.com/emails");
    expect(seen!.auth).toBe("Bearer re_test");
    const body = JSON.parse(seen!.body);
    expect(body.to).toEqual(["admin@example.com"]);
    expect(body.subject).toBe("2 call-integrity failures");
    expect(body.text).toBe("body here");
  });

  it("reports a non-2xx without throwing", async () => {
    const res = await sendAdminAlertEmail(
      async () => ({ ok: false, status: 422, text: async () => "bad" }),
      cfg,
      { subject: "s", text: "t" }
    );
    expect(res).toBe("post_failed");
  });

  it("survives a transport throw, so a mail outage never fails the sweep", async () => {
    const res = await sendAdminAlertEmail(
      async () => {
        throw new Error("dns");
      },
      cfg,
      { subject: "s", text: "t" }
    );
    expect(res).toBe("post_failed");
  });

  it("survives an unreadable error body", async () => {
    const res = await sendAdminAlertEmail(
      async () => ({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("stream closed");
        }
      }),
      cfg,
      { subject: "s", text: "t" }
    );
    expect(res).toBe("post_failed");
  });
});
