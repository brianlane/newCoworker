import { describe, expect, it, vi } from "vitest";
import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildEmailVerificationMessage } from "@/lib/email/templates/email-verification";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";
import { buildWhiteGloveConfirmationEmail } from "@/lib/email/templates/white-glove-confirmation";
import {
  buildOpsVpsDeletionEmail,
  opsNotificationEmail,
  vpsHostname
} from "@/lib/email/templates/ops-vps-deletion";
import { buildOpsPlanChangeEmail } from "@/lib/email/templates/ops-plan-change";
import { buildOpsTermAlignmentEmail } from "@/lib/email/templates/ops-term-alignment";
import { buildOpsDidReleaseFailedEmail } from "@/lib/email/templates/ops-did-release-failed";

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

  it("renders dates in the provided business timezone", () => {
    // Midnight UTC June 2 is still June 1 in Phoenix (UTC-7).
    const { text } = buildCancelConfirmationEmail({
      reason: "user_period_end",
      effectiveAt: "2026-06-02T05:00:00.000Z",
      graceEndsAt: null,
      timeZone: "America/Phoenix",
      ...mailCtx
    });
    expect(text).toContain("June 1, 2026");
    expect(text).not.toContain("June 2, 2026");
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

describe("white-glove confirmation email", () => {
  it("includes the booking link and priority window end date when configured", () => {
    const { subject, text, html } = buildWhiteGloveConfirmationEmail({
      packageName: "White-glove buildout",
      prioritySupportUntil: new Date("2026-08-03T12:00:00.000Z"),
      bookingUrl: "https://cal.example.com/newcoworker",
      ...mailCtx
    });
    expect(subject).toBe("Your White-glove buildout is confirmed");
    expect(text).toContain("https://cal.example.com/newcoworker");
    expect(text).toContain("August 3, 2026");
    expect(html).toContain("Book your session");
    expect(html).toContain("https://cal.example.com/newcoworker");
  });

  it("falls back to reply-to-schedule copy without a booking url", () => {
    const { text, html } = buildWhiteGloveConfirmationEmail({
      packageName: "White-glove setup",
      prioritySupportUntil: new Date("2026-08-03T12:00:00.000Z"),
      bookingUrl: null,
      recipientEmail: "owner@example.com",
      siteUrl: "https://www.newcoworker.com/"
    });
    expect(text).toContain("Reply to this email");
    expect(html).toContain("Open dashboard");
    expect(html).toContain("https://www.newcoworker.com/dashboard");
    expect(html).not.toContain("https://www.newcoworker.com//");
  });
});

describe("ops-vps-deletion email", () => {
  const baseInput = {
    businessId: "biz-1",
    virtualMachineId: 1800985,
    hostingerBillingSubscriptionId: "hbs-1",
    ownerName: "Jane Doe",
    ownerEmail: "jane@example.com",
    tier: "standard",
    signupDate: "2026-06-01T12:34:56.000Z",
    refundIssued: false,
    cancelReason: "user_refund",
    vmState: "VM stopped, auto-renew disabled",
    siteUrl: "https://www.newcoworker.com"
  };

  it("renders the srv hostname, panel link, owner, tier, and signup date", () => {
    const { subject, text, html } = buildOpsVpsDeletionEmail(baseInput);
    expect(subject).toBe("[ops] Delete srv1800985.hstgr.cloud in hPanel, Jane Doe (standard)");
    expect(text).toContain(
      "Please delete srv1800985.hstgr.cloud at https://hpanel.hostinger.com/paid-invoices for user Jane Doe, standard tier."
    );
    expect(text).toContain("Owner email: jane@example.com");
    expect(text).toContain("Signup date: 2026-06-01");
    expect(text).toContain("Cancel reason: user_refund");
    expect(text).toContain("Stripe refund issued: no");
    expect(text).toContain("VM state: VM stopped, auto-renew disabled");
    expect(text).toContain("Hostinger billing subscription: hbs-1");
    expect(html).toContain("Manual Hostinger deletion needed");
    expect(html).toContain("Open Hostinger invoices");
  });

  it("reports refunds and unknown billing subscriptions", () => {
    const { text } = buildOpsVpsDeletionEmail({
      ...baseInput,
      refundIssued: true,
      hostingerBillingSubscriptionId: null
    });
    expect(text).toContain("Stripe refund issued: yes");
    expect(text).toContain("Hostinger billing subscription: unknown");
  });

  it("falls back to the owner email when the name is missing or blank", () => {
    const noName = buildOpsVpsDeletionEmail({ ...baseInput, ownerName: null });
    expect(noName.subject).toContain("jane@example.com");
    const blankName = buildOpsVpsDeletionEmail({ ...baseInput, ownerName: "   " });
    expect(blankName.text).toContain("for user jane@example.com");
  });

  it("handles a missing VM id by pointing ops at the billing subscription", () => {
    const { subject, text } = buildOpsVpsDeletionEmail({ ...baseInput, virtualMachineId: null });
    expect(subject).toContain("[ops] Delete VPS in hPanel");
    expect(text).toContain("(no VM id recorded, check the billing subscription below)");
  });

  it("vpsHostname maps ids to srv hostnames and null to null", () => {
    expect(vpsHostname(42)).toBe("srv42.hstgr.cloud");
    expect(vpsHostname(null)).toBeNull();
  });

  it("opsNotificationEmail defaults to team@ and honors the env override", () => {
    const prev = process.env.OPS_NOTIFICATION_EMAIL;
    delete process.env.OPS_NOTIFICATION_EMAIL;
    expect(opsNotificationEmail()).toBe("team@newcoworker.com");
    process.env.OPS_NOTIFICATION_EMAIL = "ops@example.com";
    expect(opsNotificationEmail()).toBe("ops@example.com");
    if (prev === undefined) delete process.env.OPS_NOTIFICATION_EMAIL;
    else process.env.OPS_NOTIFICATION_EMAIL = prev;
  });
});

describe("ops-plan-change (hardware escalation started) email", () => {
  const baseInput = {
    businessId: "biz-1",
    ownerName: "Jane Doe",
    ownerEmail: "jane@example.com",
    fromTier: "starter",
    toTier: "standard",
    billingPeriod: "monthly",
    oldVirtualMachineId: 1800985,
    fromHardware: "kvm2",
    toHardware: "kvm8",
    siteUrl: "https://www.newcoworker.com"
  };

  it("renders the tier + hardware transition, old box, and admin link", () => {
    const { subject, text, html } = buildOpsPlanChangeEmail(baseInput);
    expect(subject).toBe(
      "[ops] Hardware escalation started, Jane Doe: starter/kvm2 → standard/kvm8"
    );
    expect(text).toContain("Tier: starter → standard (monthly)");
    expect(text).toContain("Hardware: kvm2 → kvm8");
    expect(text).toContain("Old box: srv1800985.hstgr.cloud");
    expect(text).toContain("Owner email: jane@example.com");
    expect(text).toContain("Business id: biz-1");
    expect(text).toContain("deletion-request email arrives when the old box");
    expect(html).toContain("Hardware escalation started");
    expect(html).toContain("https://www.newcoworker.com/admin/biz-1");
  });

  it("falls back to the owner email when the name is missing or blank", () => {
    const noName = buildOpsPlanChangeEmail({ ...baseInput, ownerName: null });
    expect(noName.subject).toContain("jane@example.com");
    const blankName = buildOpsPlanChangeEmail({ ...baseInput, ownerName: "   " });
    expect(blankName.subject).toContain("jane@example.com");
  });

  it("handles a missing old VM id", () => {
    const { text } = buildOpsPlanChangeEmail({ ...baseInput, oldVirtualMachineId: null });
    expect(text).toContain("Old box: no VM recorded");
  });
});

describe("ops-term-alignment (contract switch summary) email", () => {
  const baseInput = {
    businessId: "biz-1",
    ownerName: "Jane Doe",
    ownerEmail: "jane@example.com",
    tier: "starter",
    oldBillingPeriod: "monthly",
    newBillingPeriod: "biennial",
    outcome: "aligned" as const,
    currentCycleMonths: 1,
    targetTermMonths: 24,
    oldVirtualMachineId: 1800985,
    newVirtualMachineId: "1900001",
    detail: "Migrated onto a term-bought box.",
    siteUrl: "https://www.newcoworker.com"
  };

  it("renders the aligned outcome with the box swap and cycle transition", () => {
    const { subject, text, html } = buildOpsTermAlignmentEmail(baseInput);
    expect(subject).toBe(
      "[ops] Contract switch, Jane Doe: monthly → biennial (Hostinger term aligned)"
    );
    expect(text).toContain("Contract: monthly → biennial");
    expect(text).toContain("Hostinger cycle: 1mo → target 24mo");
    expect(text).toContain("Box: srv1800985 → srv1900001 (old box pooled, auto-renew off)");
    expect(text).toContain("Owner email: jane@example.com");
    expect(text).not.toContain("Action needed");
    expect(html).toContain("Hostinger term aligned");
    expect(html).toContain("https://www.newcoworker.com/admin/biz-1");
  });

  it("renders the not_needed outcome with an unchanged box", () => {
    const { subject, text } = buildOpsTermAlignmentEmail({
      ...baseInput,
      outcome: "not_needed",
      currentCycleMonths: 24,
      newVirtualMachineId: null,
      detail: "Cycle already covers the target."
    });
    expect(subject).toContain("(no Hostinger change needed)");
    expect(text).toContain("Hostinger cycle: 24mo → target 24mo");
    expect(text).toContain("Box: srv1800985 (unchanged)");
    expect(text).not.toContain("Action needed");
  });

  it("renders the skipped outcome with the manual-check callout and unknown cycle/box", () => {
    const { subject, text } = buildOpsTermAlignmentEmail({
      ...baseInput,
      outcome: "skipped",
      currentCycleMonths: null,
      oldVirtualMachineId: null,
      newVirtualMachineId: null,
      detail: "Cycle could not be verified."
    });
    expect(subject).toContain("(MANUAL CHECK NEEDED)");
    expect(text).toContain("Hostinger cycle: unknown → target 24mo");
    expect(text).toContain("Box: srv? (unchanged)");
    expect(text).toContain("Action needed: verify the box's billing cycle in hPanel");
  });

  it("falls back to the owner email when the name is missing and to placeholders for missing ids", () => {
    const noName = buildOpsTermAlignmentEmail({
      ...baseInput,
      ownerName: null,
      oldBillingPeriod: null,
      oldVirtualMachineId: null,
      newVirtualMachineId: null
    });
    expect(noName.subject).toContain("jane@example.com");
    expect(noName.subject).toContain("unknown → biennial");
    expect(noName.text).toContain("Box: srv? → srv?");
    const blankName = buildOpsTermAlignmentEmail({ ...baseInput, ownerName: "   " });
    expect(blankName.subject).toContain("jane@example.com");
  });
});

describe("ops-did-release-failed email", () => {
  it("renders the number, failure reason, and the Telnyx portal fix path", () => {
    const { subject, text, html } = buildOpsDidReleaseFailedEmail({
      businessId: "biz-1",
      e164: "+16023131823",
      reason: "Telnyx 500: server error",
      siteUrl: "https://www.newcoworker.com"
    });
    expect(subject).toBe(
      "[ops] ACTION REQUIRED: release DID +16023131823 manually, automated release failed"
    );
    expect(text).toContain("Number: +16023131823");
    expect(text).toContain("Business id: biz-1");
    expect(text).toContain("Failure: Telnyx 500: server error");
    expect(text).toContain("NOTHING will retry this automatically");
    expect(text).toContain("Telnyx portal → Numbers → My Numbers");
    expect(html).toContain("DID release failed, manual action required");
    expect(html).toContain("https://portal.telnyx.com/#/numbers/my-numbers");
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
