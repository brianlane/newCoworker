import { describe, expect, it } from "vitest";

import { buildTeamInviteEmail } from "@/lib/email/templates/team-invite";

describe("team invite email template", () => {
  it("renders the manager variant with login CTA", () => {
    const email = buildTeamInviteEmail({
      businessName: "Acme Corp",
      role: "manager",
      invitedBy: "owner@example.com",
      recipientEmail: "m@example.com",
      siteUrl: "https://www.newcoworker.com/"
    });
    expect(email.subject).toBe("You've been added to Acme Corp on NewCoworker");
    expect(email.text).toContain("owner@example.com added you");
    expect(email.text).toContain("as manager");
    expect(email.text).toContain("manager you can run settings");
    expect(email.text).toContain("https://www.newcoworker.com/login");
    expect(email.html).toContain("Open the dashboard");
    // Trailing slash on siteUrl must not double up in the login URL.
    expect(email.html).not.toContain("com//login");
  });

  it("renders the staff variant", () => {
    const email = buildTeamInviteEmail({
      businessName: "Acme Corp",
      role: "staff",
      invitedBy: "manager@example.com",
      recipientEmail: "s@example.com",
      siteUrl: "https://www.newcoworker.com"
    });
    expect(email.text).toContain("as staff");
    expect(email.text).toContain("staff you can work the dashboard");
  });
});
