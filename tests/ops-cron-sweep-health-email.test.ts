import { describe, expect, it } from "vitest";
import { buildOpsCronSweepHealthEmail } from "@/lib/email/templates/ops-cron-sweep-health";
import type { Finding } from "@/lib/cron/sweep-watchdog";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "missing",
    sweep: "subscription-grace-sweep",
    detail: "no run recorded in the last 1500 minutes (schedule 15 0 * * *)",
    action: "Check the live cron row first: tsx debug/read-cron-jobs.ts",
    ...overrides
  };
}

const base = { healthy: ["outreach-sweep"], checked: 23, siteUrl: "https://www.example.com" };

describe("buildOpsCronSweepHealthEmail", () => {
  it("escalates in the subject when a sweep has stopped", () => {
    const email = buildOpsCronSweepHealthEmail({ ...base, findings: [finding()] });
    expect(email.subject).toContain("ACTION REQUIRED");
    expect(email.subject).toContain("stopped");
  });

  it("escalates for a crashed sweep too", () => {
    const email = buildOpsCronSweepHealthEmail({
      ...base,
      findings: [finding({ kind: "failed", detail: "last run threw: connection reset" })]
    });
    expect(email.subject).toContain("ACTION REQUIRED");
    expect(email.subject).toContain("crashed");
  });

  it("does not shout for a partial failure, a slow run, or an HTTP blip", () => {
    for (const kind of ["errors", "slow", "http"] as const) {
      const email = buildOpsCronSweepHealthEmail({ ...base, findings: [finding({ kind })] });
      expect(email.subject).not.toContain("ACTION REQUIRED");
      expect(email.subject).toContain("1 finding(s)");
    }
  });

  it("groups findings under their kind and prints the action once per group", () => {
    const email = buildOpsCronSweepHealthEmail({
      ...base,
      findings: [
        finding({ sweep: "a", action: "DO THE THING" }),
        finding({ sweep: "b", action: "DO THE THING" })
      ]
    });
    expect(email.text).toContain("STOPPED: no run recorded (2)");
    expect(email.text).toContain("  - a:");
    expect(email.text).toContain("  - b:");
    // Printed once for the group, not once per finding.
    expect(email.text.match(/DO THE THING/g)).toHaveLength(1);
  });

  it("orders sections worst first", () => {
    const email = buildOpsCronSweepHealthEmail({
      ...base,
      findings: [
        finding({ kind: "http", sweep: "(fleet)" }),
        finding({ kind: "slow", sweep: "c" }),
        finding({ kind: "missing", sweep: "a" })
      ]
    });
    const positions = ["STOPPED", "SLOW", "HTTP LAYER"].map((h) => email.text.indexOf(h));
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });

  it("omits a section for a kind with no findings", () => {
    const email = buildOpsCronSweepHealthEmail({ ...base, findings: [finding()] });
    expect(email.text).not.toContain("SLOW:");
    expect(email.text).not.toContain("CRASHED:");
  });

  it("names the sweeps that reported in clean, so the email shows its own scope", () => {
    const email = buildOpsCronSweepHealthEmail({
      ...base,
      healthy: ["outreach-sweep", "blog-publish-sweep"],
      findings: [finding()]
    });
    expect(email.text).toContain("Reported in clean (2): outreach-sweep, blog-publish-sweep");
  });

  it("says so plainly when nothing reported in clean", () => {
    const email = buildOpsCronSweepHealthEmail({ ...base, healthy: [], findings: [finding()] });
    expect(email.text).toContain("No sweep reported in clean this run.");
  });

  it("restates why the email exists, since pg_cron shows none of this", () => {
    const email = buildOpsCronSweepHealthEmail({ ...base, findings: [finding()] });
    expect(email.text).toContain("cron.job_run_details");
    expect(email.text).toContain("asynchronous");
  });

  it("renders branded HTML carrying the same content", () => {
    const email = buildOpsCronSweepHealthEmail({ ...base, findings: [finding()] });
    expect(email.html).toContain("Cron sweep watchdog");
    expect(email.html).toContain("subscription-grace-sweep");
  });
});
