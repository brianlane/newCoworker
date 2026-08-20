import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/notification-preferences", () => ({
  getOrCreateNotificationPreferences: vi.fn()
}));

vi.mock("@/lib/db/notifications", () => ({
  insertNotification: vi.fn(async () => ({ id: "x" })),
  countRecentNotificationsAbout: vi.fn(async () => 0)
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn()
}));

vi.mock("@/lib/whatsapp/deliver", () => ({
  deliverWhatsApp: vi.fn()
}));

vi.mock("@/lib/db/whatsapp-connections", () => ({
  getPublicWhatsAppConnection: vi.fn()
}));

// The Slack delivery core has its own suite (slack-deliver); mocking it keeps
// this one about what the DISPATCHER does with the outcome. Defaults to a
// never-connected tenant so every pre-Slack expectation is unchanged.
vi.mock("@/lib/slack/deliver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack/deliver")>();
  return {
    buildSlackAlertBlocks: actual.buildSlackAlertBlocks,
    deliverSlackAlert: vi.fn(),
    slackAlertTargetState: vi.fn(async () => ({
      connected: false,
      deliverable: false,
      alertChannelName: null
    }))
  };
});

vi.mock("@/lib/telnyx/messaging", () => ({
  sendTelnyxSms: vi.fn(),
  getTelnyxMessagingForBusiness: vi.fn(async () => ({
    apiKey: "k",
    messagingProfileId: "mp"
  }))
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

// The locale resolver has its own suite; mocking it lets this one assert what
// the dispatcher DOES with a non-English owner. Defaults to "en" so every
// existing expectation is unchanged.
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));

// The contact-owner resolver has its own suite (notification-contact-owner);
// mocking it keeps this one about what the DISPATCHER does with the verdict.
const resolveContactOwnerTarget = vi.fn();
vi.mock("../supabase/functions/_shared/contact_owner_target.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../supabase/functions/_shared/contact_owner_target")
  >();
  return {
    ...actual,
    resolveContactOwnerTarget: (...args: unknown[]) => resolveContactOwnerTarget(...args)
  };
});

import {
  dispatchUrgentNotification,
  resolveNotificationTargets
} from "@/lib/notifications/dispatch";
import { getBusiness } from "@/lib/db/businesses";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { buildBookingOwnerAlert } from "@/lib/email/templates/booking-owner-alert";
import { getOrCreateNotificationPreferences } from "@/lib/db/notification-preferences";
import { countRecentNotificationsAbout, insertNotification } from "@/lib/db/notifications";
import { sendOwnerEmail } from "@/lib/email/client";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { deliverSlackAlert, slackAlertTargetState } from "@/lib/slack/deliver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

const PREFS_ON = {
  business_id: BIZ,
  sms_urgent: true,
  email_urgent: true,
  email_digest: true,
  dashboard_alerts: true,
  alert_email: null,
  phone_number: null,
  unsubscribed_at: null,
  updated_at: "2026-01-01T00:00:00Z"
};

const BUSINESS = { id: BIZ, owner_email: "owner@example.com" };

/** Dave Lane, the roster member who claimed the lead. */
const DAVE_PHONE = "+16025245719";
const LEAD_PHONE = "+16026160662";
const TO_BUSINESS_OWNER = {
  target: "business_owner",
  emailTarget: "business_owner",
  memberId: null,
  memberName: null,
  phone: null,
  email: null,
  matchedBy: null,
  reason: "contact_unowned"
};
const GABBY_PHONE = "+14807202013";
/** Nobody owns this lead, so the seller-tagged pair is alerted instead. */
const TO_TEAM = {
  target: "team_broadcast",
  emailTarget: "business_owner",
  memberId: null,
  memberName: null,
  phone: null,
  email: null,
  matchedBy: null,
  reason: "contact_unowned",
  team: [
    { id: "m1", name: "Dave Lane", phone: DAVE_PHONE },
    { id: "m2", name: "Gabrielle Mota", phone: GABBY_PHONE }
  ]
};
const TO_DAVE = {
  target: "contact_owner",
  emailTarget: "business_owner",
  memberId: "m1",
  memberName: "Dave Lane",
  phone: DAVE_PHONE,
  email: null,
  matchedBy: "phone",
  reason: "employee_no_email"
};

describe("notifications/dispatch", () => {
  const original = process.env;
  let outboundLogInsert: ReturnType<typeof vi.fn>;
  let alertInsert: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...original,
      ADMIN_EMAIL: "admin@example.com",
      TELNYX_OWNER_PHONE: "+15555550100",
      RESEND_API_KEY: "re_test",
      NEXT_PUBLIC_APP_URL: "https://app.example.com"
    };
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
    vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
    // Re-pin the cooldown counter default: clearAllMocks keeps implementations,
    // so a suite that raised it (the cooldown tests) must not leak into the
    // next one now that suites run in more than one order-sensitive spot.
    vi.mocked(countRecentNotificationsAbout).mockResolvedValue(0 as never);
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: true,
      via: "text",
      messageId: "wamid-1"
    } as never);
    // Default: WhatsApp IS connected, so the channel is applicable and the
    // existing per-branch expectations below still hold. The never-connected
    // case is asserted on its own further down.
    vi.mocked(getPublicWhatsAppConnection).mockResolvedValue({
      business_id: BIZ,
      phone_number_id: "pn-1",
      is_active: true
    } as never);
    // Service client used ONLY for the best-effort owner_alert outbound-log
    // row after a successful SMS send.
    outboundLogInsert = vi.fn(async () => ({ error: null }));
    // Two tables come through this client now: the best-effort owner_alert
    // outbound-log row, and the claimable-alert record written after a team
    // broadcast. The latter chains .select().maybeSingle(), so it needs a
    // builder rather than a bare insert.
    alertInsert = vi.fn(() => ({
      select: () => ({ maybeSingle: async () => ({ data: { id: "alert1" }, error: null }) })
    }));
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn((table: string) =>
        table === "unowned_lead_alerts"
          ? { insert: alertInsert }
          : { insert: outboundLogInsert }
      )
    } as never);
    // Default success shape ({ id, channel }), the dispatcher destructures
    // the result to stamp telnyx_message_id on the outbound-log row.
    vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "sms_id", channel: "sms" } as never);
    // Default: Slack NOT connected, so the pre-Slack expectations (four
    // channel fan-outs) hold; the slack-channel suite opts in per test.
    vi.mocked(slackAlertTargetState).mockResolvedValue({
      connected: false,
      deliverable: false,
      alertChannelName: null
    });
    vi.mocked(deliverSlackAlert).mockResolvedValue({ ok: false, reason: "not_connected" });
    // Default: no contact supplied, so nothing redirects.
    resolveContactOwnerTarget.mockResolvedValue(TO_BUSINESS_OWNER);
    // English unless a test says otherwise: clearAllMocks clears calls, not
    // implementations, so a locale set by one test would leak into the next.
    vi.mocked(resolveOwnerUiLocaleForEmail).mockResolvedValue("en" as never);
  });
  afterEach(() => {
    process.env = original;
  });

  it("resolveNotificationTargets prefers per-business prefs over owner_email and env", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: "biz-alert@example.com",
      phone_number: "+15555550199"
    } as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("biz-alert@example.com");
    expect(t.phone).toBe("+15555550199");
  });

  it("resolveNotificationTargets coerces a stored bare 10-digit phone to E.164 at read time (pre-validation rows must still deliver, Amy's '6026951142', July 2026)", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      phone_number: "6026951142"
    } as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.phone).toBe("+16026951142");
  });

  it("resolveNotificationTargets treats an uncoercible stored phone as no phone (falls back to the operator env number instead of failing at Telnyx)", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      phone_number: "555-1234"
    } as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.phone).toBe("+15555550100");
  });

  it("resolveNotificationTargets falls back to owner_email when prefs.alert_email is null", async () => {
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("owner@example.com");
    expect(t.phone).toBe("+15555550100"); // env fallback for phone
  });

  it("resolveNotificationTargets falls back to ADMIN_EMAIL when no prefs/business email", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: null
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("admin@example.com");
  });

  it("routes an international alert phone through the alpha profile when configured", async () => {
    process.env.TELNYX_INTL_ALPHA_PROFILE_ID = "alpha-prof";
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      phone_number: "+85261234567"
    } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT call",
      kind: "urgent_alert"
    });
    expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
    const [config, to, text] = vi.mocked(sendTelnyxSms).mock.calls[0] as unknown as [
      { messagingProfileId: string; fromE164?: string; rcsAgentId?: string | null },
      string,
      string
    ];
    expect(to).toBe("+85261234567");
    expect(config.messagingProfileId).toBe("alpha-prof");
    // The profile's alpha identity is the sender: no from-number, and the
    // branded RCS agent must never ride an alpha-routed alert.
    expect(config.fromE164).toBeUndefined();
    expect(config.rcsAgentId).toBeNull();
    // One-way sender: the alert must say replies are not received.
    expect(text).toMatch(/Replies to this text are not received/);
  });

  it("keeps the tenant profile for a domestic alert phone even with the alpha profile configured", async () => {
    process.env.TELNYX_INTL_ALPHA_PROFILE_ID = "alpha-prof";
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT call",
      kind: "urgent_alert"
    });
    const [config, , text] = vi.mocked(sendTelnyxSms).mock.calls[0] as unknown as [
      { messagingProfileId: string },
      string,
      string
    ];
    expect(config.messagingProfileId).not.toBe("alpha-prof");
    expect(text).not.toMatch(/Replies to this text are not received/);
  });

  it("stays dormant for an international phone while the alpha env is unset", async () => {
    delete process.env.TELNYX_INTL_ALPHA_PROFILE_ID;
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      phone_number: "+85261234567"
    } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT call",
      kind: "urgent_alert"
    });
    const [config, , text] = vi.mocked(sendTelnyxSms).mock.calls[0] as unknown as [
      { messagingProfileId: string },
      string,
      string
    ];
    expect(config.messagingProfileId).not.toBe("alpha-prof");
    expect(text).not.toMatch(/Replies to this text are not received/);
  });

  it("dispatchUrgentNotification writes 3 sent rows and calls senders when toggles on", async () => {
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    const result = await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT call",
      kind: "urgent_alert"
    });

    expect(sendOwnerEmail).toHaveBeenCalledTimes(1);
    expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
    const inserts = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    const channelStatus = inserts.map((r) => `${r.delivery_channel}:${r.status}`);
    expect(channelStatus).toEqual(
      expect.arrayContaining(["dashboard:sent", "email:sent", "sms:sent"])
    );
    expect(result.results.find((r) => r.channel === "email")?.status).toBe("sent");
  });

  it("stores one identical summary on every channel row of a dispatch", async () => {
    // The four rows of one logical event must never drift apart: the UI list
    // title, the Detail fallback, and the deep-link grouping all assume it.
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    const summary = "Texter follow-up needed: call Kolton back about the East Valley search…";
    await dispatchUrgentNotification({ businessId: BIZ, summary, kind: "sms_team_notify" });
    const inserts = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(inserts.length).toBeGreaterThanOrEqual(4);
    for (const row of inserts) {
      expect(row.summary).toBe(summary);
      expect((row.payload as Record<string, unknown>).summary).toBe(summary);
    }
  });

  it("trims trailing periods from the summary in the fallback SMS template", async () => {
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "A contact texted back. Reply from Messages on your dashboard.",
      kind: "urgent_alert"
    });
    const text = vi.mocked(sendTelnyxSms).mock.calls[0]?.[2] as string;
    expect(text).toBe(
      "New Coworker Alert: A contact texted back. Reply from Messages on your dashboard. Details: https://app.example.com/dashboard"
    );
    expect(text).not.toContain("..");
  });

  it("skips email when email_urgent toggle is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      email_urgent: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("skipped");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("email_urgent_disabled");
  });

  it("skips SMS when sms_urgent toggle is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      sms_urgent: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("skipped");
  });

  it("skips dashboard channel when dashboard_alerts is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      dashboard_alerts: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const dashRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "dashboard");
    expect(dashRow?.status).toBe("skipped");
    expect((dashRow?.payload as Record<string, unknown>).reason).toBe("dashboard_alerts_disabled");
  });

  it("hard-skips ALL channels when unsubscribed_at is set, even if toggles are on", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      unsubscribed_at: "2026-05-01T00:00:00Z"
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    const rows = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    expect(rows.every((r) => (r.payload as Record<string, unknown>).reason === "unsubscribed")).toBe(
      true
    );
  });

  it("records failed status when email send throws", async () => {
    vi.mocked(sendOwnerEmail).mockRejectedValue(new Error("resend down"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("failed");
    expect((emailRow?.payload as Record<string, unknown>).reason).toContain("resend down");
  });

  it("records failed status when SMS send throws", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("telnyx down"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("failed");
  });

  it("records skipped:no_email when no email recipient resolvable", async () => {
    delete process.env.ADMIN_EMAIL;
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: null
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("skipped");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("no_email");
  });

  it("records skipped:no_phone when phone unresolvable", async () => {
    delete process.env.TELNYX_OWNER_PHONE;
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("skipped");
    expect((smsRow?.payload as Record<string, unknown>).reason).toBe("no_phone");
  });

  it("passes unsubscribe URL anchored at the app origin with bid=<uuid>", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    const opts = call[3] as { unsubscribeUrl?: string | null; text?: string; html?: string };
    expect(opts.unsubscribeUrl).toBe(
      `https://app.example.com/api/notifications/unsubscribe?bid=${encodeURIComponent(BIZ)}`
    );
    // Must NOT live under /dashboard (regression for the original bot finding).
    expect(opts.unsubscribeUrl).not.toContain("/dashboard/api/");
    expect(opts.html).toContain("https://app.example.com/dashboard");
    expect(opts.html).not.toContain("//dashboard");
  });

  describe("per-alert heading, CTA, and locale-aware copy", () => {
    it("emailHeading replaces the H1 so the subject is not repeated as a heading", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        emailSubject: "A very long subject line that should not become the heading",
        emailHeading: "Short heading"
      });
      const opts = vi.mocked(sendOwnerEmail).mock.calls[0][3] as { html?: string };
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(opts.html ?? "")?.[1] ?? "";
      expect(h1).toContain("Short heading");
      // The subject still belongs in <title>; what must not repeat is the H1.
      expect(h1).not.toContain("A very long subject line");
    });

    it("without emailHeading the subject stays the heading, as before", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        emailSubject: "Still the heading"
      });
      const opts = vi.mocked(sendOwnerEmail).mock.calls[0][3] as { html?: string };
      expect(opts.html).toContain("Still the heading");
    });

    it("ctaPath moves the button, the fallback link, and the SMS link together", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        ctaPath: "/dashboard/customers/%2B12187702372",
        ctaLabel: "Assign this contact"
      });
      const opts = vi.mocked(sendOwnerEmail).mock.calls[0][3] as { html?: string };
      expect(opts.html).toContain("https://app.example.com/dashboard/customers/%2B12187702372");
      expect(opts.html).toContain("Assign this contact");
      // A button pointing one place and a text link pointing another is the
      // bug this guards: all three must agree.
      const smsBody = vi.mocked(sendTelnyxSms).mock.calls[0][2] as string;
      expect(smsBody).toContain("https://app.example.com/dashboard/customers/%2B12187702372");
    });

    it("defaults stay the bare dashboard and the localized Open dashboard label", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      const opts = vi.mocked(sendOwnerEmail).mock.calls[0][3] as { html?: string };
      expect(opts.html).toContain("https://app.example.com/dashboard");
      expect(opts.html).toContain("Open dashboard");
    });

    it("emailTemplate is handed the resolved locale and supplies every piece of copy", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      const seenLocales: string[] = [];
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        emailTemplate: (locale) => {
          seenLocales.push(locale);
          return {
            subject: "Templated subject",
            heading: "Templated heading",
            body: "First block.\n\nSecond block.",
            ctaLabel: "Templated CTA",
            ctaPath: "/dashboard/bookings"
          };
        }
      });
      // English is the hard default; the resolver is keyed on the recipient.
      expect(seenLocales).toEqual(["en"]);
      const call = vi.mocked(sendOwnerEmail).mock.calls[0];
      expect(call[2]).toBe("Templated subject");
      const opts = call[3] as { html?: string; text?: string };
      expect(opts.html).toContain("Templated heading");
      expect(opts.html).toContain("Templated CTA");
      expect(opts.html).toContain("https://app.example.com/dashboard/bookings");
      expect(opts.text).toContain("First block.");
      expect(opts.text).toContain("Second block.");
    });

    it("a Spanish owner actually RECEIVES the Spanish copy, not just a Spanish-capable callback", async () => {
      // The bug this pins: supplying both an explicit emailSubject/emailBody
      // and a template meant the explicit English always won, so locale
      // resolution ran and its result was thrown away. Asserting the callback
      // returns Spanish is not enough; assert the SENT message.
      vi.mocked(resolveOwnerUiLocaleForEmail).mockResolvedValue("es" as never);
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);

      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "assigned_booking",
        emailTemplate: (locale) => {
          const copy = buildBookingOwnerAlert({
            state: "unowned",
            attendeeName: "Brett Douglas",
            attendeePhone: "+12187702372",
            startLocal: "viernes, 14 de agosto de 2026",
            summary: "Discovery Call",
            surface: "booking_page",
            locale
          });
          return {
            subject: copy.subject,
            heading: copy.heading,
            body: copy.body,
            ctaLabel: copy.ctaLabel,
            ctaPath: copy.ctaPath
          };
        }
      });

      const call = vi.mocked(sendOwnerEmail).mock.calls[0];
      expect(call[2]).toContain("necesita responsable");
      const opts = call[3] as { html?: string; text?: string };
      expect(opts.text).toContain("agendó");
      expect(opts.html).toContain("Asignar este contacto");
      expect(opts.text).not.toContain("needs an owner");
    });

    it("an explicit emailSubject still wins over the template, so callers can override", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        emailSubject: "Explicit wins",
        emailTemplate: () => ({
          subject: "Templated subject",
          heading: "Templated heading",
          body: "Body.",
          ctaLabel: "CTA",
          ctaPath: "/dashboard"
        })
      });
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][2]).toBe("Explicit wins");
    });
  });

  it("does not crash when prefs lookup throws, falls through to env defaults", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockRejectedValue(new Error("db blip"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    // env has phone + admin/owner email; defaults are toggles-on
    expect(sendOwnerEmail).toHaveBeenCalled();
    expect(sendTelnyxSms).toHaveBeenCalled();
  });

  it("does not crash when business lookup throws", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz blip"));
    const t = await resolveNotificationTargets(BIZ);
    // owner_email lookup failed → falls back to ADMIN_EMAIL
    expect(t.email).toBe("admin@example.com");
  });

  it("swallows insertNotification failures (best-effort history)", async () => {
    vi.mocked(insertNotification).mockRejectedValue(new Error("db gone"));
    // Should not throw even though every history-row write fails.
    await expect(
      dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      })
    ).resolves.toBeDefined();
  });

  it("swallows non-Error insert failures (e.g. plain string thrown)", async () => {
    // Throw a non-Error value to exercise the `String(err)` branch in the logger.
    vi.mocked(insertNotification).mockRejectedValue("plain string error");
    await expect(
      dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      })
    ).resolves.toBeDefined();
  });

  it("records fallback reason when email sender throws non-Error", async () => {
    vi.mocked(sendOwnerEmail).mockRejectedValue("string-error");
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("failed");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("send_failed");
  });

  it("records fallback reason when SMS sender throws non-Error", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue("string-error");
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("failed");
    expect((smsRow?.payload as Record<string, unknown>).reason).toBe("send_failed");
  });

  describe("owner_alert outbound log (dashboard Messages thread visibility)", () => {
    it("writes an sms_outbound_log row with source owner_alert after a successful send", async () => {
      vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({
        apiKey: "k",
        messagingProfileId: "mp",
        fromE164: "+15555550111"
      } as never);
      vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "tx-123", channel: "sms" } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Take over with +15555550123",
        kind: "urgent_alert"
      });
      expect(outboundLogInsert).toHaveBeenCalledTimes(1);
      expect(outboundLogInsert).toHaveBeenCalledWith({
        business_id: BIZ,
        to_e164: "+15555550100",
        from_e164: "+15555550111",
        body: expect.stringContaining("Take over with +15555550123"),
        source: "owner_alert",
        run_id: null,
        flow_id: null,
        telnyx_message_id: "tx-123",
        channel: "sms"
      });
      // The sent history row is unaffected by the log write.
      const smsRow = vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[0] as Record<string, unknown>)
        .find((r) => r.delivery_channel === "sms");
      expect(smsRow?.status).toBe("sent");
    });

    it("logs from_e164 null when the resolved config has no from number", async () => {
      vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({
        apiKey: "k",
        messagingProfileId: "mp"
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(outboundLogInsert).toHaveBeenCalledWith(
        expect.objectContaining({ from_e164: null, source: "owner_alert" })
      );
    });

    it("does not log when the SMS send failed", async () => {
      vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("telnyx down"));
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(outboundLogInsert).not.toHaveBeenCalled();
    });

    it("keeps the sent status when the outbound-log insert returns an error", async () => {
      outboundLogInsert.mockResolvedValue({ error: { message: "constraint violated" } } as never);
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "sms")?.status).toBe("sent");
    });

    it("keeps the sent status when the service client throws an Error", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("db gone"));
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "sms")?.status).toBe("sent");
    });

    it("keeps the sent status when the service client throws a non-Error (String(err) branch)", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue("plain failure");
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "sms")?.status).toBe("sent");
    });
  });

  it("logs business-lookup failure with non-Error rejection (String(err) branch)", async () => {
    vi.mocked(getBusiness).mockRejectedValue("plain rejection");
    await resolveNotificationTargets(BIZ);
  });

  it("logs prefs-lookup failure with non-Error rejection", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockRejectedValue("blip");
    await resolveNotificationTargets(BIZ);
  });

  it("strips a trailing slash from NEXT_PUBLIC_APP_URL so no double-slash leaks into emails", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    const opts = call[3] as { unsubscribeUrl?: string | null; text?: string; html?: string };
    expect(opts.unsubscribeUrl).toBe(
      `https://app.example.com/api/notifications/unsubscribe?bid=${encodeURIComponent(BIZ)}`
    );
    expect(opts.unsubscribeUrl).not.toContain("//api/");
    expect(opts.text).toContain("https://app.example.com/dashboard");
    expect(opts.text).not.toContain("//dashboard");
    expect(opts.html).toContain("https://app.example.com/dashboard");
    expect(opts.html).not.toContain("//dashboard");
  });

  it("resolveNotificationTargets defaults categories ON for rows read before the categories migration", async () => {
    // PREFS_ON has no category_* fields (legacy row shape).
    const t = await resolveNotificationTargets(BIZ);
    expect(t.categories).toEqual({
      category_leads: true,
      category_team: true,
      category_system: true
    });
  });

  it("resolveNotificationTargets surfaces stored category flags", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      category_leads: false,
      category_team: true,
      category_system: false
    } as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.categories).toEqual({
      category_leads: false,
      category_team: true,
      category_system: false
    });
  });

  it("suppresses every channel (with skipped rows) when the event's category is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      category_leads: false
    } as never);
    const result = await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "New lead captured",
      kind: "voice_capture"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    const rows = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    expect(
      rows.every(
        (r) => (r.payload as Record<string, unknown>).reason === "category_leads_disabled"
      )
    ).toBe(true);
    expect(result.results.map((r) => r.channel).sort()).toEqual([
      "dashboard",
      "email",
      "sms",
      "whatsapp"
    ]);
  });

  it("delivers category-gated kinds normally when the category is on", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      category_team: true
    } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "Routed to Dana",
      kind: "sms_team_notify"
    });
    expect(sendOwnerEmail).toHaveBeenCalled();
    expect(sendTelnyxSms).toHaveBeenCalled();
  });

  it("never category-gates generic urgent alerts, even with every category off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      category_leads: false,
      category_team: false,
      category_system: false
    } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendOwnerEmail).toHaveBeenCalled();
    expect(sendTelnyxSms).toHaveBeenCalled();
  });

  it("gates system-category kinds on category_system", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      category_system: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "Port update",
      kind: "byon_port"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    const rows = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(
      rows.every(
        (r) => (r.payload as Record<string, unknown>).reason === "category_system_disabled"
      )
    ).toBe(true);
  });

  // A business that never connected WhatsApp has no WhatsApp channel to
  // report on, so NO whatsapp row is written on ANY branch. The check used
  // to sit on the delivery path only, so the branches below still wrote
  // rows: live, 4 businesses had 87 whatsapp rows between them and not one
  // of them had a connection.
  describe("never-connected WhatsApp writes no rows", () => {
    beforeEach(() => {
      vi.mocked(getPublicWhatsAppConnection).mockResolvedValue(null as never);
    });

    const whatsappRows = () =>
      vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[0] as Record<string, unknown>)
        .filter((r) => r.delivery_channel === "whatsapp");

    it("writes none on the delivery path, and never calls the sender", async () => {
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(whatsappRows()).toHaveLength(0);
      expect(deliverWhatsApp).not.toHaveBeenCalled();
      expect(result.results.some((r) => r.channel === "whatsapp")).toBe(false);
    });

    it("writes none when the event's category is off", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        category_leads: false
      } as never);
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "New lead captured",
        kind: "voice_capture"
      });
      expect(whatsappRows()).toHaveLength(0);
      expect(result.results.map((r) => r.channel).sort()).toEqual(["dashboard", "email", "sms"]);
    });

    it("writes none when there is no owner phone", async () => {
      delete process.env.TELNYX_OWNER_PHONE;
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
      expect(whatsappRows()).toHaveLength(0);
    });

    it("writes none when the WhatsApp toggle is off", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_urgent: false
      } as never);
      vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
      await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
      expect(whatsappRows()).toHaveLength(0);
    });

    it("writes none when the owner unsubscribed from everything", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        unsubscribed_at: "2026-08-01T00:00:00Z"
      } as never);
      await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
      expect(whatsappRows()).toHaveLength(0);
    });
  });

  it("still records a skip for a connection that exists but is inactive", async () => {
    // Owner-actionable: they connected WhatsApp and it lapsed, so the honest
    // skip row stays. Only never-connected goes silent.
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: false,
      reason: "connection_inactive"
    } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
    const wa = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .filter((r) => r.delivery_channel === "whatsapp");
    expect(wa).toHaveLength(1);
    expect((wa[0].payload as Record<string, unknown>).reason).toBe("connection_inactive");
  });

  it("treats a failing connection read as connected, so an alert is never silenced", async () => {
    vi.mocked(getPublicWhatsAppConnection).mockRejectedValue(new Error("boom"));
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
    expect(deliverWhatsApp).toHaveBeenCalled();
  });

  it("survives a connection read that rejects with a non-Error", async () => {
    vi.mocked(getPublicWhatsAppConnection).mockRejectedValue("nope" as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({ businessId: BIZ, summary: "URGENT", kind: "urgent_alert" });
    expect(deliverWhatsApp).toHaveBeenCalled();
  });

  it("uses fallback dashboardUrl + empty RESEND_API_KEY when env vars unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert",
      payload: { extra: "ctx" }
    });
    // sendOwnerEmail invoked with empty apiKey (??"" branch)
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    expect(call[0]).toBe("");
    const body = (call[3] as { text: string; html: string }).text;
    const html = (call[3] as { text: string; html: string }).html;
    expect(body).toContain("http://localhost:3000/dashboard");
    expect(html).toContain("http://localhost:3000/dashboard");
  });

  describe("whatsapp channel", () => {
    it("delivers through the central helper and records the via", async () => {
      vi.mocked(deliverWhatsApp).mockResolvedValue({
        ok: true,
        via: "template",
        messageId: "wamid-t"
      } as never);
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Lead needs a callback",
        kind: "urgent_alert"
      });
      const wa = result.results.find((r) => r.channel === "whatsapp");
      expect(wa?.status).toBe("sent");
      expect(deliverWhatsApp).toHaveBeenCalledWith({
        businessId: BIZ,
        to: "+15555550100",
        text: expect.stringContaining("Lead needs a callback"),
        audience: "owner",
        language: "en"
      });
    });

    it("honors the smsBody override for the whatsapp copy", async () => {
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Alert",
        kind: "urgent_alert",
        smsBody: "Custom short copy"
      });
      expect(vi.mocked(deliverWhatsApp).mock.calls[0][0].text).toBe("Custom short copy");
    });

    it("skips when the toggle is off, unsubscribed, or no phone resolves", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_urgent: false
      } as never);
      let result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "skipped",
        reason: "whatsapp_urgent_disabled"
      });
      expect(deliverWhatsApp).not.toHaveBeenCalled();

      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        unsubscribed_at: "2026-07-01T00:00:00Z"
      } as never);
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "skipped",
        reason: "unsubscribed"
      });

      process.env.TELNYX_OWNER_PHONE = "";
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "skipped",
        reason: "no_phone"
      });
    });

    it("records NOTHING for a never-connected business, a skip row for an inactive connection", async () => {
      // Never-connected tenants used to accrue a skipped:not_connected row
      // on EVERY alert forever (Amy's Jul 31 2026 list); the channel is not
      // applicable, so no row at all.
      vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
      vi.mocked(deliverWhatsApp).mockResolvedValue({
        ok: false,
        reason: "not_connected"
      } as never);
      let result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toBeUndefined();
      const channels = vi
        .mocked(insertNotification)
        .mock.calls.map((c) => (c[0] as { delivery_channel: string }).delivery_channel);
      expect(channels).not.toContain("whatsapp");

      // An inactive/expired connection is signal the owner should see.
      vi.mocked(deliverWhatsApp).mockResolvedValue({
        ok: false,
        reason: "connection_inactive"
      } as never);
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "skipped",
        reason: "connection_inactive"
      });
    });

    it("records policy skips as skipped and hard failures as failed", async () => {
      vi.mocked(deliverWhatsApp).mockResolvedValue({
        ok: false,
        reason: "template_not_approved"
      } as never);
      let result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "skipped",
        reason: "template_not_approved"
      });

      vi.mocked(deliverWhatsApp).mockResolvedValue({
        ok: false,
        reason: "send_failed"
      } as never);
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "failed",
        reason: "send_failed"
      });

      vi.mocked(deliverWhatsApp).mockRejectedValue(new Error("helper exploded"));
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "failed",
        reason: "helper exploded"
      });

      vi.mocked(deliverWhatsApp).mockRejectedValue("plain string failure");
      result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "s",
        kind: "urgent_alert"
      });
      expect(result.results.find((r) => r.channel === "whatsapp")).toMatchObject({
        status: "failed",
        reason: "send_failed"
      });
    });
  });

  describe("slack channel", () => {
    const slackRows = () =>
      vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[0] as Record<string, unknown>)
        .filter((r) => r.delivery_channel === "slack");

    const connected = () =>
      vi.mocked(slackAlertTargetState).mockResolvedValue({
        connected: true,
        deliverable: true,
        alertChannelName: "leads"
      });

    it("never-connected writes no rows and never delivers", async () => {
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(slackRows()).toHaveLength(0);
      expect(deliverSlackAlert).not.toHaveBeenCalled();
      expect(result.results.some((r) => r.channel === "slack")).toBe(false);
    });

    it("posts the alert card and records sent with the channel name", async () => {
      connected();
      vi.mocked(deliverSlackAlert).mockResolvedValue({
        ok: true,
        channelId: "C-1",
        channelName: "leads",
        ts: "1.2"
      });
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert",
        ctaPath: "/dashboard/calls/abc"
      });
      const rows = slackRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("sent");
      expect((rows[0].payload as Record<string, unknown>).recipient).toBe("#leads");
      expect(deliverSlackAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BIZ,
          text: expect.stringContaining("https://app.example.com/dashboard/calls/abc"),
          blocks: expect.any(Array)
        })
      );
    });

    it("records honest skips for toggle-off and unsubscribe without delivering", async () => {
      connected();
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        slack_urgent: false
      } as never);
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect(slackRows()[0]).toMatchObject({ status: "skipped" });
      expect(
        (slackRows()[0].payload as Record<string, unknown>).reason
      ).toBe("slack_urgent_disabled");
      expect(deliverSlackAlert).not.toHaveBeenCalled();

      vi.clearAllMocks();
      vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
      connected();
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        unsubscribed_at: "2026-08-01T00:00:00Z"
      } as never);
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe("unsubscribed");
    });

    it("maps structured refusals to skips and transport failures to failed", async () => {
      connected();
      vi.mocked(deliverSlackAlert).mockResolvedValue({
        ok: false,
        reason: "no_alert_channel"
      });
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect(slackRows()[0]).toMatchObject({ status: "skipped" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe(
        "no_alert_channel"
      );

      vi.clearAllMocks();
      vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
      connected();
      vi.mocked(deliverSlackAlert).mockResolvedValue({
        ok: false,
        reason: "send_failed",
        detail: "not_in_channel"
      });
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect(slackRows()[0]).toMatchObject({ status: "failed" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe(
        "send_failed:not_in_channel"
      );

      vi.clearAllMocks();
      vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
      connected();
      vi.mocked(deliverSlackAlert).mockRejectedValue(new Error("socket hang up"));
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect(slackRows()[0]).toMatchObject({ status: "failed" });
    });

    it("falls back to the channel id when Slack returns no name, and stringifies non-Error throws", async () => {
      connected();
      vi.mocked(deliverSlackAlert).mockResolvedValue({
        ok: true,
        channelId: "C-1",
        channelName: null,
        ts: "1.2"
      });
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect((slackRows()[0].payload as Record<string, unknown>).recipient).toBe("C-1");

      vi.clearAllMocks();
      vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
      connected();
      vi.mocked(deliverSlackAlert).mockRejectedValue("plain string error");
      await dispatchUrgentNotification({ businessId: BIZ, summary: "A", kind: "urgent_alert" });
      expect(slackRows()[0]).toMatchObject({ status: "failed" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe("send_failed");
    });

    it("stays silent when delivery races a disconnect", async () => {
      connected();
      vi.mocked(deliverSlackAlert).mockResolvedValue({ ok: false, reason: "not_connected" });
      const result = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "A",
        kind: "urgent_alert"
      });
      expect(slackRows()).toHaveLength(0);
      expect(result.results.some((r) => r.channel === "slack")).toBe(false);
    });

    it("joins the category-off and cooldown skip fan-outs when connected", async () => {
      connected();
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        category_leads: false
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "New lead captured",
        kind: "voice_capture"
      });
      expect(slackRows()[0]).toMatchObject({ status: "skipped" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe(
        "category_leads_disabled"
      );

      vi.clearAllMocks();
      vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
      connected();
      vi.mocked(countRecentNotificationsAbout).mockResolvedValue(5 as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "A",
        kind: "urgent_alert",
        contactE164: LEAD_PHONE
      });
      expect(slackRows()[0]).toMatchObject({ status: "skipped" });
      expect((slackRows()[0].payload as Record<string, unknown>).reason).toBe(
        "contact_alert_cooldown"
      );
    });
  });

  describe("contact-owner routing", () => {
    /**
     * The bug: a Clever lead that Dave Lane had claimed texted asking for a
     * callback, and all four notification rows went to the business owner.
     */
    const rowsFor = (channel: string) =>
      vi.mocked(insertNotification).mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((r) => r.delivery_channel === channel);

    it("sends the page to the owning employee, not the business owner", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][1]).toBe(DAVE_PHONE);
      expect(vi.mocked(deliverWhatsApp).mock.calls[0][0]).toMatchObject({
        to: DAVE_PHONE
      });
    });

    it("stamps why each row went where it went", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      for (const row of vi.mocked(insertNotification).mock.calls.map((c) => c[0])) {
        expect((row as { payload: Record<string, unknown> }).payload).toMatchObject({
          routed_to: "contact_owner",
          routed_member_id: "m1",
          routed_member_name: "Dave Lane",
          matched_by: "phone",
          routing_reason: "employee_no_email"
        });
      }
    });

    it("keeps the email with the business owner when the roster row has none", async () => {
      // Every one of Amy's employees has a null email. Skipping the email
      // instead would leave the redirected alert with one delivery path.
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][1]).toBe("owner@example.com");
      expect(rowsFor("email")[0]).toMatchObject({ status: "sent" });
    });

    it("redirects the email too when the roster row has an address", async () => {
      resolveContactOwnerTarget.mockResolvedValue({
        ...TO_DAVE,
        emailTarget: "contact_owner",
        email: "dave@example.com",
        reason: null
      });
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][1]).toBe("dave@example.com");
    });

    it("logs the redirected send against the employee's number", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      // Still source "owner_alert": a new source value would need a
      // CHECK-constraint migration for no behavioural gain.
      expect(outboundLogInsert).toHaveBeenCalledWith(
        expect.objectContaining({ to_e164: DAVE_PHONE, source: "owner_alert" })
      );
    });

    /**
     * Solo-owner verdict (the rung after #1500): a one-person owner-only
     * roster resolves as contact_owner with reason solo_owner. This suite
     * pins that the dispatcher then treats it as a plain redirect: one
     * recipient, no claim framing, no claimable-alert row.
     */
    describe("solo-owner verdict", () => {
      const TO_SOLO_OWNER = {
        target: "contact_owner",
        emailTarget: "business_owner",
        memberId: "m-brian",
        memberName: "Brian",
        phone: "+16026866672",
        email: null,
        matchedBy: "phone",
        reason: "solo_owner",
        team: []
      };

      it("pages exactly the owner, with no Reply-1 claim invite", async () => {
        resolveContactOwnerTarget.mockResolvedValue(TO_SOLO_OWNER);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: "Follow up with Donna Robinson",
          kind: "sms_team_notify",
          contactE164: LEAD_PHONE,
          leadTag: "seller"
        });
        const smsCalls = vi.mocked(sendTelnyxSms).mock.calls;
        expect(smsCalls.map((c) => c[1])).toEqual(["+16026866672"]);
        expect(smsCalls[0][2]).not.toContain("Reply 1 to claim");
      });

      it("records NO claimable unowned-lead alert row", async () => {
        resolveContactOwnerTarget.mockResolvedValue(TO_SOLO_OWNER);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: "Follow up with Donna Robinson",
          kind: "sms_team_notify",
          contactE164: LEAD_PHONE
        });
        expect(alertInsert).not.toHaveBeenCalled();
      });

      it("stamps routing_reason solo_owner on every row", async () => {
        resolveContactOwnerTarget.mockResolvedValue(TO_SOLO_OWNER);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: "Follow up with Donna Robinson",
          kind: "sms_team_notify",
          contactE164: LEAD_PHONE
        });
        for (const row of vi.mocked(insertNotification).mock.calls.map((c) => c[0])) {
          expect((row as { payload: Record<string, unknown> }).payload).toMatchObject({
            routed_to: "contact_owner",
            routed_member_id: "m-brian",
            routed_member_name: "Brian",
            routing_reason: "solo_owner"
          });
        }
      });
    });

    /**
     * Amy's rule, 2026-08-15: an unowned lead asking for a human goes to
     * every teammate covering that lead type BEFORE the business owner. The
     * lead that forced it waited two days while both alerts went to Amy.
     */
    it("texts every teammate on an unowned-lead broadcast", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE,
        leadTag: "seller"
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls.map((c) => c[1])).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);
      // One sent row per teammate, each naming its own recipient.
      expect(rowsFor("sms").map((r) => (r.payload as { recipient: string }).recipient)).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);
    });

    it("passes the lead type through to the resolver", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE,
        leadTag: "seller"
      });
      expect(resolveContactOwnerTarget.mock.calls[0][3]).toBe("seller");
    });

    it("keeps the broadcast email with the business owner", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][1]).toBe("owner@example.com");
    });

    it("one teammate's failed send does not suppress the rest of the team", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      vi.mocked(sendTelnyxSms).mockRejectedValueOnce(new Error("carrier down"));
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls.map((c) => c[1])).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);
      expect(rowsFor("sms").map((r) => r.status)).toEqual(["failed", "sent"]);
    });

    it("never lets WhatsApp stand in for a whole-team broadcast", async () => {
      // The reroute preference belongs to the OWNER's number, and this leg is
      // single recipient: delivering it would reach an arbitrary one of the
      // teammates instead of all of them.
      vi.mocked(getPublicWhatsAppConnection).mockResolvedValue({ is_active: true } as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_urgent: true,
        whatsapp_replaces_sms: true
      } as never);
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls.map((c) => c[1])).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);
      expect(vi.mocked(deliverWhatsApp)).not.toHaveBeenCalled();
      // No whatsapp row either: a broadcast is not a WhatsApp-shaped event.
      expect(rowsFor("whatsapp")).toEqual([]);
    });

    it("records the broadcast so a teammate can claim it by texting 1", async () => {
      // Teammates reply "1" to team texts out of habit. Without this record
      // that digit resolves against some unrelated older offer, which is
      // exactly how the lead that prompted all of this stayed unowned.
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE,
        leadLabel: "Richard"
      });
      expect(alertInsert).toHaveBeenCalledTimes(1);
      const row = alertInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row.lead_e164).toBe(LEAD_PHONE);
      expect(row.lead_label).toBe("Richard");
      expect(row.recipients).toEqual([DAVE_PHONE, GABBY_PHONE]);
    });

    it("invites a reply ONLY when a row exists for the digit to attach to", async () => {
      // Bugbot, PR #1404: the affordance used to be appended by the caller,
      // which cannot know how routing resolves. On an owner-addressed alert
      // that invitation sends the "1" to an unrelated live offer, which is
      // the exact failure claimable alerts exist to remove.
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE,
        smsBody: "[Coworker] Follow up with Richard"
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][2]).toContain("Reply 1 to claim");

      vi.mocked(sendTelnyxSms).mockClear();
      resolveContactOwnerTarget.mockResolvedValue(TO_BUSINESS_OWNER);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE,
        smsBody: "[Coworker] Follow up with Richard"
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][2]).not.toContain("Reply 1 to claim");
    });

    it("records NOTHING for an owner-addressed alert", async () => {
      // An alert that reached one person has nobody to race for it.
      resolveContactOwnerTarget.mockResolvedValue(TO_BUSINESS_OWNER);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(alertInsert).not.toHaveBeenCalled();
    });

    it("still delivers the broadcast when the claim record cannot be written", async () => {
      // The texts already went out; losing claim-by-reply is strictly better
      // than failing the alert.
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      alertInsert.mockImplementation(() => {
        throw new Error("table gone");
      });
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls.map((c) => c[1])).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);

    });

    it.each([
      ["an Error", new Error("db gone")],
      ["a non-Error throw", "string failure"]
    ])("still delivers when the service client dies mid-dispatch (%s)", async (_label, thrown) => {
      // recordUnownedLeadAlert swallows its own failures, so the only way to
      // reach the dispatcher's guard is the client itself dying. It is built
      // three times before the recording (routing, then one outbound-log row
      // per recipient), so this fails the fourth build and leaves the two
      // texts that already went out untouched.
      resolveContactOwnerTarget.mockResolvedValue(TO_TEAM);
      const healthy = {
        from: vi.fn((table: string) =>
          table === "unowned_lead_alerts"
            ? { insert: alertInsert }
            : { insert: outboundLogInsert }
        )
      } as never;
      let builds = 0;
      vi.mocked(createSupabaseServiceClient).mockImplementation(async () => {
        builds += 1;
        if (builds > 3) throw thrown;
        return healthy;
      });
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Richard",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls.map((c) => c[1])).toEqual([
        DAVE_PHONE,
        GABBY_PHONE
      ]);
    });

    it("falls back to the business owner for an unowned contact", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_BUSINESS_OWNER);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with a stranger",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][1]).toBe("+15555550100");
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][1]).toBe("owner@example.com");
    });

    it("still delivers to the business owner when the lookup blows up", async () => {
      // The service client can fail to construct; an alert must never be lost
      // because we could not work out who to redirect it to.
      vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce(new Error("no env"));
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][1]).toBe("+15555550100");
      expect(vi.mocked(sendOwnerEmail).mock.calls[0][1]).toBe("owner@example.com");

      // ...and again when the failure is not an Error instance.
      vi.mocked(sendTelnyxSms).mockClear();
      vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce("string failure");
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Donna Robinson",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][1]).toBe("+15555550100");
    });

    it("never consults the resolver when no contact is supplied", async () => {
      // The regression pin for every business-level caller: billing, plan and
      // system-health alerts must stay owner-addressed and unstamped.
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "SMS cap reached",
        kind: "sms_cap_reached"
      });
      expect(resolveContactOwnerTarget).not.toHaveBeenCalled();
      expect(vi.mocked(sendTelnyxSms).mock.calls[0][1]).toBe("+15555550100");
      const payload = (vi.mocked(insertNotification).mock.calls[0][0] as {
        payload: Record<string, unknown>;
      }).payload;
      expect(payload).not.toHaveProperty("routed_to");
    });
  });

  describe("per-contact flood cooldown", () => {
    /**
     * The incident (Amy Laidlaw, 2026-08-07): a bot-vs-bot SMS loop fired
     * notify_team once per lap, seventeen alerts about the same contact in
     * ten minutes, each by SMS and email. The cooldown caps alert EVENTS
     * about one contact per window.
     */
    it("skips every channel once the cap is reached, with the reason stamped", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      vi.mocked(countRecentNotificationsAbout).mockResolvedValueOnce(2);
      const { results } = await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Aaron",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms)).not.toHaveBeenCalled();
      expect(vi.mocked(sendOwnerEmail)).not.toHaveBeenCalled();
      expect(results.every((r) => r.status === "skipped")).toBe(true);
      for (const row of vi.mocked(insertNotification).mock.calls.map((c) => c[0])) {
        expect((row as { payload: Record<string, unknown> }).payload).toMatchObject({
          reason: "contact_alert_cooldown",
          about_e164: LEAD_PHONE
        });
      }
    });

    it("still delivers below the cap and stamps about_e164 plus a dispatch id", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      vi.mocked(countRecentNotificationsAbout).mockResolvedValueOnce(1);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Aaron",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalled();
      const payload = (vi.mocked(insertNotification).mock.calls[0][0] as {
        payload: Record<string, unknown>;
      }).payload;
      expect(payload.about_e164).toBe(LEAD_PHONE);
      expect(typeof payload.dispatch_id).toBe("string");
      expect((payload.dispatch_id as string).length).toBeGreaterThan(0);
    });

    it("fails OPEN when the count read throws: the alert still goes out", async () => {
      // This gate must never be the reason an owner missed a real emergency.
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      vi.mocked(countRecentNotificationsAbout).mockRejectedValueOnce(new Error("db down"));
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Aaron",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalled();
    });

    it("fails OPEN on a non-Error rejection too (String(err) branch)", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      vi.mocked(countRecentNotificationsAbout).mockRejectedValueOnce("plain string failure");
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Aaron",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalled();
    });

    it("never counts for a business-level alert with no contact", async () => {
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "SMS cap reached",
        kind: "sms_cap_reached"
      });
      expect(vi.mocked(countRecentNotificationsAbout)).not.toHaveBeenCalled();
      expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalled();
    });
  });

  describe("WhatsApp instead of SMS (whatsapp_replaces_sms)", () => {
    const smsRowOf = () =>
      vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[0] as Record<string, unknown>)
        .find((r) => r.delivery_channel === "sms");

    it("skips SMS as whatsapp_preferred and still delivers WhatsApp when the pref is on and WhatsApp can deliver", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(sendTelnyxSms).not.toHaveBeenCalled();
      expect(deliverWhatsApp).toHaveBeenCalledTimes(1);
      const smsRow = smsRowOf();
      expect(smsRow?.status).toBe("skipped");
      expect((smsRow?.payload as Record<string, unknown>).reason).toBe("whatsapp_preferred");
      const waRow = vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[0] as Record<string, unknown>)
        .find((r) => r.delivery_channel === "whatsapp");
      expect(waRow?.status).toBe("sent");
    });

    it("keeps sending SMS when the connection row exists but is INACTIVE (it would refuse, leaving no phone channel)", async () => {
      // Bugbot f574b3a4: gating the skip on "a row exists" suppressed SMS
      // while deliverWhatsApp refused with connection_inactive.
      vi.mocked(getPublicWhatsAppConnection).mockResolvedValue({
        business_id: BIZ,
        phone_number_id: "pn-1",
        is_active: false
      } as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
      expect(smsRowOf()?.status).toBe("sent");
    });

    it("keeps sending SMS when the connection lookup THROWS (uncertainty must never cost a working channel)", async () => {
      vi.mocked(getPublicWhatsAppConnection).mockRejectedValue(new Error("db down"));
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      const targets = await resolveNotificationTargets(BIZ);
      // The two verdicts fail in OPPOSITE directions on the same error.
      expect(targets.whatsappConnected).toBe(true);
      expect(targets.whatsappDeliverable).toBe(false);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
      expect(smsRowOf()?.status).toBe("sent");
    });

    it("keeps sending SMS when the pref is on but WhatsApp was never connected", async () => {
      vi.mocked(getPublicWhatsAppConnection).mockResolvedValue(null as never);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
      expect(smsRowOf()?.status).toBe("sent");
    });

    it("keeps sending SMS when the pref is on but the WhatsApp urgent toggle is off", async () => {
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_urgent: false,
        whatsapp_replaces_sms: true
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      });
      expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
      expect(deliverWhatsApp).not.toHaveBeenCalled();
      expect(smsRowOf()?.status).toBe("sent");
    });

    it("a redirected teammate page keeps its SMS even with the pref on (the teammate's number may have no WhatsApp)", async () => {
      resolveContactOwnerTarget.mockResolvedValue(TO_DAVE);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      await dispatchUrgentNotification({
        businessId: BIZ,
        summary: "Follow up with Aaron",
        kind: "sms_team_notify",
        contactE164: LEAD_PHONE
      });
      expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendTelnyxSms).mock.calls[0]?.[1]).toBe(DAVE_PHONE);
      expect(smsRowOf()?.status).toBe("sent");
    });

    describe("HIPAA lane: PHI-free notifications", () => {
      /** Everything a HIPAA alert must never put in front of a vendor. */
      const PHI = "Jane Doe says her lower back pain is worse after the epidural";

      async function dispatchAsHipaaTenant(extra: Record<string, unknown> = {}) {
        vi.mocked(getBusiness).mockResolvedValue({ ...BUSINESS, hipaa_mode: true } as never);
        vi.mocked(slackAlertTargetState).mockResolvedValue({
          connected: true,
          deliverable: true,
          alertChannelName: "alerts"
        });
        vi.mocked(deliverSlackAlert).mockResolvedValue({
          ok: true,
          channelId: "C1",
          channelName: "alerts"
        } as never);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: PHI,
          kind: "urgent_alert",
          emailBody: PHI,
          emailSubject: PHI,
          emailHeading: PHI,
          smsBody: PHI,
          ctaPath: `/dashboard/customers/${encodeURIComponent(LEAD_PHONE)}`,
          ...extra
        });
      }

      /** Every string this dispatch handed to a third party. */
      function outboundStrings(): string[] {
        const out: string[] = [];
        for (const call of vi.mocked(sendOwnerEmail).mock.calls) {
          out.push(String(call[2] ?? ""));
          const body = call[3] as { text?: string; html?: string } | string | undefined;
          out.push(typeof body === "string" ? body : `${body?.text ?? ""} ${body?.html ?? ""}`);
        }
        for (const call of vi.mocked(sendTelnyxSms).mock.calls) out.push(String(call[2] ?? ""));
        for (const call of vi.mocked(deliverWhatsApp).mock.calls) {
          out.push(String((call[0] as { text?: string })?.text ?? ""));
        }
        for (const call of vi.mocked(deliverSlackAlert).mock.calls) {
          const arg = call[0] as { text?: string; blocks?: unknown };
          out.push(String(arg?.text ?? ""));
          out.push(JSON.stringify(arg?.blocks ?? []));
        }
        return out.filter(Boolean);
      }

      it("keeps caller content off email, SMS, WhatsApp and Slack", async () => {
        await dispatchAsHipaaTenant();
        const sent = outboundStrings();
        // Guard the guard: a vacuous pass if nothing was actually delivered.
        expect(sent.length).toBeGreaterThan(0);
        for (const text of sent) expect(text).not.toContain(PHI);
      });

      it("strips the contact deep link, which is itself an identifier", async () => {
        await dispatchAsHipaaTenant();
        for (const text of outboundStrings()) {
          expect(text).not.toContain(encodeURIComponent(LEAD_PHONE));
          expect(text).not.toContain(LEAD_PHONE);
        }
      });

      it("beats an emailTemplate override too", async () => {
        await dispatchAsHipaaTenant({
          emailSubject: undefined,
          emailBody: undefined,
          emailHeading: undefined,
          emailTemplate: () => ({
            subject: PHI,
            heading: PHI,
            body: PHI,
            ctaLabel: "Open",
            ctaPath: "/dashboard"
          })
        });
        for (const text of outboundStrings()) expect(text).not.toContain(PHI);
      });

      it("still tells the owner to go look", async () => {
        await dispatchAsHipaaTenant();
        const sent = outboundStrings().join(" ");
        expect(sent).toContain("https://app.example.com/dashboard");
        expect(sent).toMatch(/needs your attention/i);
      });

      it("keeps the REAL content in the dashboard history row", async () => {
        // The notifications row is our own store, covered by the BAA. Redacting
        // it would blind the owner to their own data without removing a single
        // third-party disclosure.
        await dispatchAsHipaaTenant();
        const rows = vi.mocked(insertNotification).mock.calls.map((c) => c[0]);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => (r as { summary: string }).summary === PHI)).toBe(true);
      });

      it("a non-HIPAA tenant is completely unaffected, on every channel", async () => {
        // This is the guard-the-guard for the negative tests above. If an
        // argument index in outboundStrings() were wrong, that channel's text
        // would never be inspected and its "does not contain PHI" assertion
        // would pass for the wrong reason. Proving the SAME extraction finds
        // the content when redaction is OFF is what makes the negatives mean
        // something.
        vi.mocked(getBusiness).mockResolvedValue({ ...BUSINESS, hipaa_mode: false } as never);
        vi.mocked(slackAlertTargetState).mockResolvedValue({
          connected: true,
          deliverable: true,
          alertChannelName: "alerts"
        });
        vi.mocked(deliverSlackAlert).mockResolvedValue({
          ok: true,
          channelId: "C1",
          channelName: "alerts"
        } as never);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: PHI,
          kind: "urgent_alert",
          emailSubject: PHI,
          emailBody: PHI,
          smsBody: PHI
        });
        expect(vi.mocked(sendOwnerEmail)).toHaveBeenCalled();
        expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalled();
        expect(vi.mocked(deliverSlackAlert)).toHaveBeenCalled();
        expect(vi.mocked(deliverWhatsApp)).toHaveBeenCalled();
        const sent = outboundStrings();
        expect(sent.some((t) => t.includes(PHI))).toBe(true);
        // Each channel individually, so one chatty channel cannot mask three
        // silent ones.
        expect(String(vi.mocked(sendOwnerEmail).mock.calls[0]?.[2])).toContain(PHI);
        expect(String(vi.mocked(sendTelnyxSms).mock.calls[0]?.[2])).toContain(PHI);
        const slackArg = vi.mocked(deliverSlackAlert).mock.calls[0]?.[0] as {
          text?: string;
          blocks?: unknown;
        };
        expect(`${slackArg?.text ?? ""}${JSON.stringify(slackArg?.blocks ?? [])}`).toContain(PHI);
        expect(
          String((vi.mocked(deliverWhatsApp).mock.calls[0]?.[0] as { text?: string })?.text)
        ).toContain(PHI);
      });

      it("FAILS CLOSED when the business row cannot be read", async () => {
        // getBusiness swallows its errors and returns null, so this is the
        // realistic shape of a database blip, not an exotic one.
        vi.mocked(getBusiness).mockResolvedValue(null as never);
        await dispatchUrgentNotification({
          businessId: BIZ,
          summary: PHI,
          kind: "urgent_alert",
          smsBody: PHI
        });
        for (const text of outboundStrings()) expect(text).not.toContain(PHI);
      });
    });

    it("resolveNotificationTargets defaults whatsappReplacesSms to false and reads a stored true", async () => {
      const t1 = await resolveNotificationTargets(BIZ);
      expect(t1.whatsappReplacesSms).toBe(false);
      vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
        ...PREFS_ON,
        whatsapp_replaces_sms: true
      } as never);
      const t2 = await resolveNotificationTargets(BIZ);
      expect(t2.whatsappReplacesSms).toBe(true);
    });
  });
});
