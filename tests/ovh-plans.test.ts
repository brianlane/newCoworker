import { describe, expect, it } from "vitest";
import {
  OVH_DATACENTER_CANADA,
  OVH_DEFAULT_DURATION,
  OVH_DEFAULT_PRICING_MODE,
  OVH_UBUNTU_IMAGE_MATCH,
  ovhPlanCodeForSize,
  ovhSubsidiary
} from "@/lib/ovh/plans";
import { VPS_SIZES } from "@/lib/vps/size";

describe("ovh/plans", () => {
  it("maps every hardware size to a plan code by default", () => {
    for (const size of VPS_SIZES) {
      const code = ovhPlanCodeForSize(size, {});
      expect(code.length).toBeGreaterThan(0);
    }
    // Distinct sizes must not share a SKU.
    const codes = VPS_SIZES.map((s) => ovhPlanCodeForSize(s, {}));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("defaults are the live BHS-capable -ca codes from the OVHcloud US catalog", () => {
    expect(ovhPlanCodeForSize("kvm1", {})).toBe("vps-2027-model1-ca");
    expect(ovhPlanCodeForSize("kvm2", {})).toBe("vps-2027-model2-ca");
    expect(ovhPlanCodeForSize("kvm4", {})).toBe("vps-2027-model4-ca");
    expect(ovhPlanCodeForSize("kvm8", {})).toBe("vps-2025-model5-ca");
  });

  it("ovhSubsidiary defaults to US with a trimmed env override (blanks fall through)", () => {
    expect(ovhSubsidiary({})).toBe("US");
    expect(ovhSubsidiary({ OVH_SUBSIDIARY: " CA " })).toBe("CA");
    expect(ovhSubsidiary({ OVH_SUBSIDIARY: "   " })).toBe("US");
  });

  it("env overrides win over defaults (trimmed), blanks fall through", () => {
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: " vps-2026-xl " })).toBe(
      "vps-2026-xl"
    );
    const dflt = ovhPlanCodeForSize("kvm8", {});
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: "   " })).toBe(dflt);
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: undefined })).toBe(dflt);
  });

  it("pins the Canada constants the provisioner depends on", () => {
    // Uppercase matches the US endpoint's vps_datacenter catalog values.
    expect(OVH_DATACENTER_CANADA).toBe("BHS");
    expect(OVH_DEFAULT_DURATION).toBe("P1M");
    expect(OVH_DEFAULT_PRICING_MODE).toBe("default");
    expect(OVH_UBUNTU_IMAGE_MATCH.toLowerCase()).toContain("ubuntu");
  });
});
