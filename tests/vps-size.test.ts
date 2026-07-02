import { describe, it, expect } from "vitest";
import { DEFAULT_TIER_VPS_SIZE, resolveVpsSize } from "@/lib/vps/size";

describe("vps/size", () => {
  it("keeps the historical tier defaults (starter→kvm2, standard→kvm8)", () => {
    expect(DEFAULT_TIER_VPS_SIZE.starter).toBe("kvm2");
    expect(DEFAULT_TIER_VPS_SIZE.standard).toBe("kvm8");
    expect(resolveVpsSize("starter")).toBe("kvm2");
    expect(resolveVpsSize("standard")).toBe("kvm8");
  });

  it("honors an explicit pin over the tier default", () => {
    expect(resolveVpsSize("standard", "kvm2")).toBe("kvm2");
    expect(resolveVpsSize("starter", "kvm8")).toBe("kvm8");
  });

  it("falls back to the tier default on null, undefined, and corrupt values", () => {
    expect(resolveVpsSize("standard", null)).toBe("kvm8");
    expect(resolveVpsSize("standard", undefined)).toBe("kvm8");
    expect(resolveVpsSize("starter", "kvm999")).toBe("kvm2");
    expect(resolveVpsSize("starter", "")).toBe("kvm2");
  });
});
