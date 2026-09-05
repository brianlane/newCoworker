import { describe, expect, it } from "vitest";
import {
  notificationCategoryEnabled,
  resolveNotificationCategory
} from "@/lib/notifications/categories";

describe("resolveNotificationCategory", () => {
  it("maps lead-capture kinds to leads", () => {
    expect(resolveNotificationCategory("voice_capture")).toBe("leads");
    expect(resolveNotificationCategory("link_click")).toBe("leads");
  });

  it("maps team-notify kinds to team", () => {
    expect(resolveNotificationCategory("voice_team_notify")).toBe("team");
    expect(resolveNotificationCategory("sms_team_notify")).toBe("team");
  });

  it("maps platform events to system", () => {
    expect(resolveNotificationCategory("byon_port")).toBe("system");
    expect(resolveNotificationCategory("calendar_connection_broken")).toBe("system");
    // A bounced email to a contact is a delivery fault, not a lead event: an
    // owner who muted "leads" to cut chatter still needs to hear that the
    // coworker could not reach someone (KYP has leads off, system on).
    expect(resolveNotificationCategory("contact_email_bounce")).toBe("system");
  });

  it("defaults unknown/future kinds to the ungated general category", () => {
    expect(resolveNotificationCategory("urgent_alert")).toBe("general");
    expect(resolveNotificationCategory("digest")).toBe("general");
    expect(resolveNotificationCategory("some_future_kind")).toBe("general");
    // Both booking alerts are deliberately ungated: an appointment nobody is
    // on the hook for is the escalation path, not a lead-marketing event.
    expect(resolveNotificationCategory("unassigned_booking")).toBe("general");
    expect(resolveNotificationCategory("assigned_booking")).toBe("general");
  });
});

describe("notificationCategoryEnabled", () => {
  const allOn = { category_leads: true, category_team: true, category_system: true };
  const allOff = { category_leads: false, category_team: false, category_system: false };

  it("reads the matching flag per category", () => {
    expect(notificationCategoryEnabled("leads", allOn)).toBe(true);
    expect(notificationCategoryEnabled("leads", allOff)).toBe(false);
    expect(notificationCategoryEnabled("team", allOn)).toBe(true);
    expect(notificationCategoryEnabled("team", allOff)).toBe(false);
    expect(notificationCategoryEnabled("system", allOn)).toBe(true);
    expect(notificationCategoryEnabled("system", allOff)).toBe(false);
  });

  it("general is always enabled, the escalation path can't be muted by category", () => {
    expect(notificationCategoryEnabled("general", allOff)).toBe(true);
  });
});
