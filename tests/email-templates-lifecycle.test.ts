import { describe, expect, it } from "vitest";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";

describe("cancel-confirmation email", () => {
  it("describes a scheduled period-end cancellation with undo guidance", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "user_period_end",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null
    });
    expect(subject).toMatch(/scheduled to end/i);
    expect(text).toMatch(/cancellation is scheduled/i);
    expect(text).toMatch(/undo/i);
    expect(text).toMatch(/2026/);
  });

  it("uses a payment-failure framing when the cancel was auto-triggered", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "payment_failed",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z"
    });
    expect(subject).toMatch(/paused/i);
    expect(text).toMatch(/couldn't process your last payment/i);
    expect(text).toMatch(/Reactivate/);
    expect(text).toMatch(/2026/);
  });

  it("signals the plan-change in-progress for upgrade_switch", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "upgrade_switch",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null
    });
    expect(subject).toMatch(/plan change/i);
    expect(text).toMatch(/migrating your workspace/i);
  });

  it("mentions admin involvement when the operator force-cancels", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "admin_force",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z"
    });
    expect(subject).toMatch(/account has been closed/i);
    expect(text).toMatch(/administrator canceled your subscription/i);
    expect(text).toMatch(/immediate wipe/i);
  });

  it("falls back to user-refund framing for the default cancel path", () => {
    const { subject, text } = buildCancelConfirmationEmail({
      reason: "user_refund",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: "2026-07-01T00:00:00.000Z"
    });
    expect(subject).toMatch(/has been canceled/i);
    expect(text).toMatch(/at your request/i);
    expect(text).toMatch(/2026/);
  });

  it("gracefully handles a null grace deadline with a default message", () => {
    const { text } = buildCancelConfirmationEmail({
      reason: "user_refund",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      graceEndsAt: null
    });
    expect(text).toMatch(/30 days from now/);
  });
});

describe("refund-issued email", () => {
  it("formats the amount in USD with proper precision", () => {
    const { subject, text } = buildRefundIssuedEmail({ amountCents: 9999 });
    expect(subject).toMatch(/refund is on its way/i);
    expect(text).toMatch(/\$99\.99/);
    expect(text).toMatch(/5–10 business days/);
  });

  it("clamps negative amounts to 0 so the email never shows a weird value", () => {
    const { text } = buildRefundIssuedEmail({ amountCents: -50 });
    expect(text).toMatch(/\$0\.00/);
  });
});
