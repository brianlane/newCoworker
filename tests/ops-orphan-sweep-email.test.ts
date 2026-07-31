import { describe, expect, it } from "vitest";
import { buildOpsOrphanSweepEmail } from "@/lib/email/templates/ops-orphan-sweep";
import type { OrphanSweepFinding } from "@/lib/vps/orphan-sweep";

function finding(overrides: Partial<OrphanSweepFinding> = {}): OrphanSweepFinding {
  return {
    kind: "pooled",
    vmId: 1806114,
    plan: "KVM 1",
    state: "initial",
    createdAt: "2026-07-05T04:41:31Z",
    hostingerBillingSubscriptionId: "169rR3VOTEcjx7ysQ",
    expiresAt: "2026-08-05T04:41:30Z",
    detail: "pooled as available (kvm1), auto-renew already-off, paid through 2026-08-05T04:41:30Z",
    ...overrides
  };
}

describe("buildOpsOrphanSweepEmail", () => {
  it("leads with the pooled count when everything was handled", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [finding()],
      checkedVms: 10,
      dryRun: false,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toBe(
      "[ops] Orphan sweep: 1 untracked paid box(es) pooled for reuse"
    );
    expect(email.text).toContain("compared 10 Hostinger VMs against vps_inventory");
    expect(email.text).toContain("VM 1806114 (KVM 1, state initial");
    expect(email.text).toContain("created 2026-07-05T04:41:31Z");
    expect(email.text).toContain("paid through 2026-08-05T04:41:30Z");
    expect(email.text).toContain("[POOLED]");
    expect(email.html).toContain("Untracked Hostinger VMs");
  });

  // A box the sweep refused to touch is the one a human has to look at, so it
  // has to win the subject line over any number of quiet successes.
  it("escalates to ACTION REQUIRED when a box was left alone", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [
        finding(),
        finding({
          kind: "reported",
          vmId: 1863856,
          state: "running",
          detail: "a business still points at this VM"
        })
      ],
      checkedVms: 10,
      dryRun: false,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toBe(
      "[ops] ACTION REQUIRED: 1 untracked Hostinger VM(s) the sweep would not touch"
    );
    expect(email.text).toContain("[ACTION REQUIRED]");
  });

  it("marks a dry run so a report is never mistaken for a change", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [
        finding({ kind: "would_pool", detail: "dry run: would pool as available (kvm1)" })
      ],
      checkedVms: 10,
      dryRun: true,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("[ops][dry run]");
    expect(email.subject).toContain("would be pooled for reuse");
  });

  // Bugbot on #1061: a dry run whose boxes are all poolable is a CLEAN result.
  // Folding those into the action count made it shout ACTION REQUIRED about
  // boxes the live sweep would have handled by itself, which would have
  // discredited the dry run the first time anyone ran it.
  it("does not escalate a dry run whose boxes are all poolable", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [
        finding({ kind: "would_pool", detail: "dry run: would pool as available (kvm1)" }),
        finding({ kind: "would_pool", vmId: 1800985, detail: "dry run: would pool" })
      ],
      checkedVms: 10,
      dryRun: true,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).not.toContain("ACTION REQUIRED");
    expect(email.subject).toContain("2 untracked paid box(es) would be pooled");
    expect(email.text).toContain("[WOULD POOL]");
    expect(email.text).not.toContain("[ACTION REQUIRED]");
    expect(email.text).toContain("Nothing here needs a human");
  });

  it("still escalates a dry run that found a genuinely stuck box", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [
        finding({ kind: "would_pool", detail: "dry run: would pool as available (kvm1)" }),
        finding({ kind: "reported", vmId: 1863856, state: "running", detail: "still in use" })
      ],
      checkedVms: 10,
      dryRun: true,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("[ops][dry run] ACTION REQUIRED: 1 untracked");
  });

  it("renders a box with no plan or dates", () => {
    const email = buildOpsOrphanSweepEmail({
      findings: [
        finding({
          plan: null,
          createdAt: null,
          expiresAt: null,
          detail: "pooled as available (kvm1), auto-renew already-off, paid-through unknown"
        })
      ],
      checkedVms: 1,
      dryRun: false,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).toContain(
      "VM 1806114 (unknown plan, state initial): pooled as available"
    );
  });
});
