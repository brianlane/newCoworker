import { describe, expect, it } from "vitest";
import { buildOpsBillingPostureEmail } from "@/lib/email/templates/ops-billing-posture";
import type { BillingPostureFinding } from "@/lib/vps/billing-posture";

function finding(overrides: Partial<BillingPostureFinding> = {}): BillingPostureFinding {
  return {
    kind: "tenant_auto_renew_off",
    vmId: 1800985,
    businessId: "biz-1",
    businessName: "Residency Pilot",
    hostingerBillingSubscriptionId: "hsub-1",
    expiresAt: "2026-08-02T00:00:00Z",
    autoHealed: false,
    detail: "subscription hsub-1 is non_renewing with auto-renew off",
    ...overrides
  };
}

describe("buildOpsBillingPostureEmail", () => {
  it("flags ACTION REQUIRED when any finding was not auto-healed", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [finding(), finding({ vmId: 2, autoHealed: true })],
      checkedTenantVms: 4,
      checkedPoolBoxes: 2,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("ACTION REQUIRED: 1 VPS billing posture finding(s)");
    expect(email.text).toContain("4 tenant VMs, 2 pooled boxes");
    expect(email.text).toContain("VM 1800985 / Residency Pilot (biz-1)");
    expect(email.text).toContain("period ends 2026-08-02T00:00:00Z");
    expect(email.text).toContain("[ACTION REQUIRED]");
    expect(email.text).toContain("[AUTO-HEALED]");
    expect(email.html).toContain("hpanel.hostinger.com/billing/subscriptions");
  });

  it("uses the calmer auto-healed subject when everything was fixed in place", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [finding({ autoHealed: true })],
      checkedTenantVms: 1,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("1 finding(s) auto-healed");
    expect(email.subject).not.toContain("ACTION REQUIRED");
  });

  it("labels pool findings without a business and omits the period line when unknown", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [
        finding({
          kind: "pool_box_auto_renew_on",
          vmId: 777,
          businessId: null,
          businessName: null,
          expiresAt: null,
          detail: "pooled (available) box is still auto-renewing (active)"
        })
      ],
      checkedTenantVms: 0,
      checkedPoolBoxes: 1,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).toContain("VM 777 / pool:");
    expect(email.text).not.toContain("period ends");
  });
});

describe("buildOpsBillingPostureEmail, tenant-level findings", () => {
  // online_tenant_no_box is about a tenant, not a box, so rendering the
  // shared "VM <id> / ..." prefix would print "VM null".
  // "pool" is the pool direction's label. An orphan VM is the opposite: not
  // in vps_inventory at all.
  it("does not label an ownerless untracked VM as a pool box", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 0,
      checkedPoolBoxes: 0,
      findings: [
        finding({
          kind: "untracked_vm",
          vmId: 1806114,
          businessId: null,
          businessName: null,
          expiresAt: null,
          detail: "absent from vps_inventory and no business points at it"
        })
      ]
    });
    expect(email.text).toContain("VM 1806114 / untracked:");
    expect(email.text).not.toContain("/ pool");
  });

  it("still labels a real pool finding as pool", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 0,
      checkedPoolBoxes: 1,
      findings: [
        finding({
          kind: "pool_box_auto_renew_on",
          businessId: null,
          businessName: null,
          detail: "pooled box is still auto-renewing"
        })
      ]
    });
    expect(email.text).toContain("/ pool:");
  });

  // A reaped row is something the cron already FIXED. Filing it under ACTION
  // REQUIRED would train the operator to ignore a digest whose whole value is
  // that its action list is short and real.
  it("renders a reaped lapsed pool box as auto-healed, not action required", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 0,
      checkedPoolBoxes: 1,
      findings: [
        finding({
          kind: "pool_box_lapsed_retired",
          vmId: 1800985,
          businessId: null,
          businessName: null,
          expiresAt: "2026-08-02T20:54:22Z",
          autoHealed: true,
          detail: "pooled box lapsed, its vps_inventory row was retired"
        })
      ]
    });
    expect(email.subject).toContain("1 finding(s) auto-healed");
    expect(email.subject).not.toContain("ACTION REQUIRED");
    expect(email.text).toContain("VM 1800985 / pool:");
    expect(email.text).toContain("[AUTO-HEALED]");
    expect(email.text).toContain("a lapsed pool box was retired from inventory");
  });

  // The reaped line already says when the box lapsed. Appending the shared
  // "period ends" suffix printed the same timestamp twice on one line, which
  // is how the first production digest actually rendered.
  it("prints a reaped box's date once, not twice", () => {
    const stamp = "2026-08-05T04:41:32+00:00";
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 4,
      checkedPoolBoxes: 5,
      findings: [
        finding({
          kind: "pool_box_lapsed_retired",
          vmId: 1806114,
          businessId: null,
          businessName: null,
          expiresAt: stamp,
          autoHealed: true,
          detail: `pooled box lapsed on ${stamp} (VM state suspended), so it can never be adopted again`
        })
      ]
    });

    expect(email.text.split(stamp)).toHaveLength(2); // one occurrence
    expect(email.text).not.toContain("period ends");
  });

  // A digest whose findings were all handled must not open by warning that
  // Hostinger DELETES a live tenant's box. Nothing in the body is at risk,
  // and an operator startled by a false alarm skims the real one.
  it("keeps the framing calm when nothing needs a human", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 4,
      checkedPoolBoxes: 5,
      findings: [
        finding({
          kind: "pool_box_lapsed_retired",
          businessId: null,
          businessName: null,
          autoHealed: true,
          detail: "pooled box lapsed, its vps_inventory row was retired"
        })
      ]
    });

    expect(email.text).toContain("4 tenant VMs, 5 pooled boxes");
    expect(email.text).toContain("found nothing that needs a human");
    expect(email.text).not.toContain("DELETED by Hostinger");
    expect(email.text).not.toContain("contradict fleet assignments");
    // The hPanel instruction is for findings a human must fix; there are none.
    expect(email.text).not.toContain("flip the renewal toggle");
  });

  // The counterpart: when something IS at risk, the warning must still be
  // there. This is the case the alarming copy was written for.
  it("keeps the warning when a finding does need a human", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 4,
      checkedPoolBoxes: 5,
      findings: [finding({ autoHealed: false }), finding({ vmId: 2, autoHealed: true })]
    });

    expect(email.text).toContain("found 1 finding(s) that need a human");
    expect(email.text).toContain("DELETED by Hostinger");
    expect(email.text).toContain("flip the renewal toggle");
  });

  it("omits the VM prefix when the finding has no box", () => {
    const email = buildOpsBillingPostureEmail({
      siteUrl: "https://www.newcoworker.com",
      checkedTenantVms: 1,
      checkedPoolBoxes: 0,
      findings: [
        finding({
          kind: "online_tenant_no_box",
          vmId: null,
          businessName: "Acme Plumbing",
          businessId: "biz-nobox",
          expiresAt: null,
          detail: "business is online but has no hostinger_vps_id"
        })
      ]
    });
    expect(email.text).not.toContain("VM null");
    expect(email.text).toContain("Acme Plumbing (biz-nobox):");
  });
});

describe("buildOpsBillingPostureEmail, advisory findings", () => {
  const advisory = (over: Partial<BillingPostureFinding> = {}): BillingPostureFinding =>
    finding({
      kind: "billing_cycle_price_stale",
      vmId: 1806097,
      businessId: "biz-hq",
      businessName: "New Coworker",
      hostingerBillingSubscriptionId: "16BcBrVOTACBI8WdU",
      expiresAt: null,
      autoHealed: false,
      detail: "Hostinger subscription 16BcBrVOTACBI8WdU reports a 1-month cycle at $19.49",
      ...over
    });

  it("never claims a lapse risk when only advisory findings need a human", () => {
    // The whole point: this box is healthy and renewing. Announcing that
    // Hostinger is about to DELETE it would be false.
    const email = buildOpsBillingPostureEmail({
      findings: [advisory()],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toBe("[ops] VPS billing posture: 1 finding(s) to review");
    expect(email.subject).not.toContain("ACTION REQUIRED");
    expect(email.text).not.toContain("DELETED");
    expect(email.text).toContain("Nothing is at risk of lapsing");
  });

  it("never tells the operator to flip the renewal toggle on an advisory-only run", () => {
    // Following that instruction here would disable auto-renew on a healthy
    // tenant box, causing the very outage the digest warns about.
    const email = buildOpsBillingPostureEmail({
      findings: [advisory()],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).not.toContain("flip the renewal toggle");
    expect(email.text).toContain("No renewal toggle to flip");
  });

  it("tags an advisory line REVIEW, not ACTION REQUIRED", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [advisory()],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).toContain("[REVIEW: reconciliation note]");
    expect(email.text).not.toContain("[ACTION REQUIRED]");
  });

  it("does not append a period-ends deadline to an advisory line", () => {
    // The date involved is a RENEWAL, not a period end, and the detail
    // already states it.
    const email = buildOpsBillingPostureEmail({
      findings: [advisory()],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).not.toContain("period ends");
  });

  it("calls an unattributed advisory row unattributed, never pool", () => {
    // Null attribution here means the Hostinger VM listing failed, so we do
    // not know who runs the box. "pool" would assert something false.
    const email = buildOpsBillingPostureEmail({
      findings: [advisory({ vmId: null, businessId: null, businessName: null })],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.text).toContain("unattributed:");
    expect(email.text).not.toContain("pool:");
  });

  it("keeps the lapse framing but warns off the advisory lines when both are present", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [finding(), advisory()],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    // Count in the subject stays the total needing a human, both kinds.
    expect(email.subject).toContain("ACTION REQUIRED: 2 VPS billing posture finding(s)");
    expect(email.text).toContain("flip the renewal toggle");
    expect(email.text).toContain("Lines tagged REVIEW are NOT renewal problems");
    expect(email.text).toContain("[ACTION REQUIRED]");
    expect(email.text).toContain("[REVIEW: reconciliation note]");
  });

  it("still reports an all-healed run as auto-healed even with an advisory kind present", () => {
    const email = buildOpsBillingPostureEmail({
      findings: [advisory({ autoHealed: true })],
      checkedTenantVms: 5,
      checkedPoolBoxes: 0,
      siteUrl: "https://www.example.com"
    });
    expect(email.subject).toContain("1 finding(s) auto-healed");
    expect(email.text).toContain("No action needed");
  });
});
