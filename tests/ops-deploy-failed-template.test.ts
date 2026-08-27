import { describe, expect, it } from "vitest";
import { buildOpsDeployFailedEmail } from "@/lib/email/templates/ops-deploy-failed";

describe("buildOpsDeployFailedEmail", () => {
  it("names the business, the failure site, and says the owner was not notified", () => {
    const email = buildOpsDeployFailedEmail({
      businessId: "biz-1",
      businessName: "Acme Plumbing",
      virtualMachineId: "42",
      phase: "deploy_exception",
      reason: "deploy poll down",
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("Signup deploy FAILED");
    expect(email.subject).toContain("Acme Plumbing");
    expect(email.subject).toContain("vm 42");
    expect(email.text).toContain("srv42.hstgr.cloud");
    expect(email.text).toContain("deploy_exception");
    expect(email.text).toContain("deploy poll down");
    // The line that makes this alert load-bearing: nothing else says it.
    expect(email.text).toContain("The owner was NOT notified");
    expect(email.text).toContain("Nothing retries this automatically");
    expect(email.html).toContain("/admin/biz-1");
  });

  it("falls back to the business id when the name is blank", () => {
    const email = buildOpsDeployFailedEmail({
      businessId: "biz-2",
      businessName: "   ",
      virtualMachineId: "7",
      phase: "deploy_failed",
      reason: "exit 1",
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("biz-2");
    expect(email.text).toContain("The signup deploy for biz-2 reported failure");
  });
});
