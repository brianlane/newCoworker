import { describe, expect, it } from "vitest";
import {
  buildOpsIntakeCompletedEmail,
  formatIntakeCompletedAtUtc
} from "@/lib/email/templates/ops-intake-completed";

const BASE = {
  intakeId: "0f0f0f0f-0000-4000-8000-000000000001",
  businessName: "Acme Home Services",
  industry: "home_services",
  recipientEmail: "prospect@example.com",
  completedAt: "2026-08-21T19:56:12.345Z",
  siteUrl: "https://www.example.com"
};

describe("formatIntakeCompletedAtUtc", () => {
  it("renders an explicit UTC stamp with the time, minute precision", () => {
    expect(formatIntakeCompletedAtUtc("2026-08-21T19:56:12.345Z")).toBe(
      "2026-08-21 19:56 UTC"
    );
  });

  it("passes an unparseable stamp through instead of rendering Invalid Date", () => {
    expect(formatIntakeCompletedAtUtc("not-a-date")).toBe("not-a-date");
  });
});

describe("buildOpsIntakeCompletedEmail", () => {
  it("names the prospect, resolves the industry label, and links the build document", () => {
    const email = buildOpsIntakeCompletedEmail(BASE);
    expect(email.subject).toBe(
      "[ops] White-glove questionnaire completed, Acme Home Services"
    );
    expect(email.text).toContain("Industry: Home services (HVAC, plumbing, roofing…)");
    expect(email.text).toContain("Prospect email: prospect@example.com");
    // The completion TIME rides along, not just the date.
    expect(email.text).toContain("Completed: 2026-08-21 19:56 UTC");
    expect(email.text).toContain(
      "Build document: https://www.example.com/admin/intake-doc/0f0f0f0f-0000-4000-8000-000000000001"
    );
    expect(email.html).toContain("/admin/intake-doc/0f0f0f0f-0000-4000-8000-000000000001");
  });

  it("falls back business name → recipient email → intake id, and labels hand-shared links", () => {
    const emailOnly = buildOpsIntakeCompletedEmail({ ...BASE, businessName: "  " });
    expect(emailOnly.subject).toContain("prospect@example.com");
    expect(emailOnly.text).toContain("Business: (unnamed)");

    const idOnly = buildOpsIntakeCompletedEmail({
      ...BASE,
      businessName: "",
      recipientEmail: null
    });
    expect(idOnly.subject).toContain(BASE.intakeId);
    expect(idOnly.text).toContain("Prospect email: (link was shared by hand)");
  });

  it("renders an unknown industry value as-is, mirroring the build document", () => {
    const email = buildOpsIntakeCompletedEmail({ ...BASE, industry: "beekeeping" });
    expect(email.text).toContain("Industry: beekeeping");
  });
});
