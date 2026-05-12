import { describe, expect, it, vi } from "vitest";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildEmailVerificationMessage } from "@/lib/email/templates/email-verification";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";

const mailCtx = {
  recipientEmail: "owner@example.com",
  siteUrl: "https://www.newcoworker.com"
};

describe("cancel-confirmation email", () => {
  it("describes a scheduled period-end cancellation with undo guidance", () => {
    const { subject, text, html } = buildCancelConfirmationEmail({
      reason: "user_period_end",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null,
      ...mailCtx
    });
    expect(subject).toMatch(/scheduled to end/i);
    expect(text).toMatch(/cancellation is scheduled/i);
    expect(text).toMatch(/undo/i);
    expect(text).toMatch(/2026/);
    expect(html).toContain("logo.png");
    expect(html).toContain("/dashboard/billing");
  });

  it("uses a payment-failure framing when the cancel was auto-triggered", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "payment_failed",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z",
      ...mailCtx
    });
    expect(subject).toMatch(/paused/i);
    expect(text).toMatch(/couldn't process your last payment/i);
    expect(text).toMatch(/Reactivate/);
    expect(text).toMatch(/2026/);
  });

  it("uses the default retention message for payment failures without a grace deadline", () => {
    const { text } = buildCancelConfirmationEmail({
      reason: "payment_failed",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null,
      ...mailCtx
    });
    expect(text).toMatch(/30 days from now/);
  });

  it("signals the plan-change in-progress for upgrade_switch", () => {
    const { subject, text, html } = buildCancelConfirmationEmail({
      reason: "upgrade_switch",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null,
      ...mailCtx
    });
    expect(subject).toMatch(/plan change/i);
    expect(text).toMatch(/migrating your workspace/i);
    expect(html).toContain("/dashboard");
  });

  it("mentions admin involvement when the operator force-cancels", () => {
    const { subject, text, html } = buildCancelConfirmationEmail({
      reason: "admin_force",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z",
      ...mailCtx
    });
    expect(subject).toMatch(/account has been closed/i);
    expect(text).toMatch(/administrator canceled your subscription/i);
    expect(text).toMatch(/immediate wipe/i);
    expect(html).not.toContain("Open billing");
  });

  it("falls back to user-refund framing for the default cancel path", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "user_refund",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z",
      ...mailCtx
    });
    expect(subject).toMatch(/has been canceled/i);
    expect(text).toMatch(/at your request/i);
    expect(text).toMatch(/2026/);
  });

  it("gracefully handles a null grace deadline with a default message", () => {
    const { text } = buildCancelConfirmationEmail({
      reason: "user_refund",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null,
      ...mailCtx
    });
    expect(text).toMatch(/30 days from now/);
  });

  it("falls back to the raw date if formatting throws", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(() => {
        throw new Error("date formatting unavailable");
      });
    try {
      const { text } = buildCancelConfirmationEmail({
        reason: "user_refund",
        effectiveAt: "2026-06-01T00:00:00.000Z",
        graceEndsAt: "2026-07-01T00:00:00.000Z",
        ...mailCtx
      });
      expect(text).toContain("2026-07-01T00:00:00.000Z");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("refund-issued email", () => {
  it("formats the amount in USD with proper precision", () => {
    const { subject, text, html } = buildRefundIssuedEmail({ amountCents: 9999, ...mailCtx });
    expect(subject).toMatch(/refund is on its way/i);
    expect(text).toMatch(/\$99\.99/);
    expect(text).toMatch(/5–10 business days/);
    expect(html).toMatch(/\$99\.99/);
  });

  it("clamps negative amounts to 0 so the email never shows a weird value", () => {
    const { text } = buildRefundIssuedEmail({ amountCents: -50, ...mailCtx });
    expect(text).toMatch(/\$0\.00/);
  });
});

describe("email-verification template", () => {
  it("embeds the verification URL verbatim and carries the 7-day TTL copy", () => {
    const url = "https://www.newcoworker.com/verify-email?token=abc.def";
    const { subject, text, html } = buildEmailVerificationMessage({
      verificationUrl: url,
      siteUrl: "https://www.newcoworker.com",
      recipientEmail: "you@example.com"
    });

    expect(subject).toBe("Confirm your NewCoworker email");
    expect(text).toContain(url);
    expect(text).toMatch(/7 days/);
    expect(text).toMatch(/Welcome to NewCoworker/);
    expect(text).toMatch(/safely ignore/i);
    expect(html).toContain("Confirm email");
    expect(html).toContain("token=abc.def");
    expect(html).toContain("logo.png");
  });

  it("does not html-encode the URL or alter casing in the plain-text part", () => {
    const url = "https://www.newcoworker.com/verify-email?token=ABC.DEF&utm_source=onboarding";
    const { text } = buildEmailVerificationMessage({
      verificationUrl: url,
      siteUrl: "https://www.newcoworker.com",
      recipientEmail: "you@example.com"
    });
    expect(text).toContain(url);
    expect(text).not.toContain("&amp;");
  });
});
