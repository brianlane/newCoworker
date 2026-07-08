import { describe, expect, it } from "vitest";
import {
  OVH_DATACENTER_CANADA,
  OVH_DEFAULT_DURATION,
  OVH_DEFAULT_PRICING_MODE,
  OVH_UBUNTU_IMAGE_MATCH,
  ovhPlanCodeForSize
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

  it("env overrides win over defaults (trimmed), blanks fall through", () => {
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: " vps-2026-xl " })).toBe(
      "vps-2026-xl"
    );
    const dflt = ovhPlanCodeForSize("kvm8", {});
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: "   " })).toBe(dflt);
    expect(ovhPlanCodeForSize("kvm8", { OVH_PLAN_CODE_KVM8: undefined })).toBe(dflt);
  });

  it("pins the Canada constants the provisioner depends on", () => {
    expect(OVH_DATACENTER_CANADA).toBe("bhs");
    expect(OVH_DEFAULT_DURATION).toBe("P1M");
    expect(OVH_DEFAULT_PRICING_MODE).toBe("default");
    expect(OVH_UBUNTU_IMAGE_MATCH.toLowerCase()).toContain("ubuntu");
  });
});
