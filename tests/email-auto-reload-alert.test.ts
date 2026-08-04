import { describe, expect, it } from "vitest";
import { buildAutoReloadAlertEmail } from "@/lib/email/templates/auto-reload-alert";

/**
 * The three auto-reload states a tenant cannot discover on their own. Every
 * one of these emails is the only signal that unattended charging has
 * stopped, so the copy has to name the family and point at the fix.
 */

const BASE = {
  category: "sms" as const,
  businessName: "Acme Plumbing",
  recipientEmail: "owner@example.com",
  siteUrl: "https://app.example.com"
};

describe("buildAutoReloadAlertEmail", () => {
  it("tells a disabled tenant what happened and that nothing was charged", async () => {
    const email = buildAutoReloadAlertEmail({ ...BASE, kind: "disabled", attempts: 3 });
    expect(email.subject).toContain("Acme Plumbing");
    expect(email.text).toContain("3");
    expect(email.text).toContain("text messages");
    expect(email.text).toContain("https://app.example.com/dashboard/billing");
    expect(email.html).toContain("/dashboard/billing");
  });

  it("defaults the attempt count when the caller omits it", () => {
    const email = buildAutoReloadAlertEmail({ ...BASE, kind: "disabled" });
    expect(email.text).toContain("3");
  });

  it("explains a bank challenge as something only the tenant can clear", () => {
    const email = buildAutoReloadAlertEmail({ ...BASE, kind: "paused_authentication" });
    expect(email.subject).toContain("Acme Plumbing");
    expect(email.text.toLowerCase()).toContain("bank");
  });

  it("says the monthly limit is what stopped top-ups", () => {
    const email = buildAutoReloadAlertEmail({ ...BASE, kind: "monthly_limit" });
    expect(email.text.toLowerCase()).toContain("monthly limit");
  });

  it("names the right family in each case", () => {
    expect(
      buildAutoReloadAlertEmail({ ...BASE, category: "voice", kind: "monthly_limit" }).text
    ).toContain("voice minutes");
    expect(
      buildAutoReloadAlertEmail({ ...BASE, category: "chat", kind: "monthly_limit" }).text
    ).toContain("AI credit");
  });

  it("renders Spanish copy when the owner's locale is es", () => {
    const email = buildAutoReloadAlertEmail({ ...BASE, kind: "disabled", locale: "es" });
    expect(email.subject).toContain("recarga automatica");
    expect(email.text).toContain("mensajes de texto");
  });

  it("normalizes a trailing slash on the site URL", () => {
    const email = buildAutoReloadAlertEmail({
      ...BASE,
      kind: "monthly_limit",
      siteUrl: "https://app.example.com/"
    });
    expect(email.text).toContain("https://app.example.com/dashboard/billing");
    expect(email.text).not.toContain("com//dashboard");
  });
});
