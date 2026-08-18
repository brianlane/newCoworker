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
