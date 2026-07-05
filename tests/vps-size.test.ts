import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIER_VPS_SIZE,
  resolveVpsSize,
  resolveDeployedVpsSize,
  vpsSizeFromHostingerPlan,
  vpsSizeHasLocalModel
} from "@/lib/vps/size";

describe("vps/size", () => {
  it("maps the tier defaults (starter→kvm1, standard→kvm8)", () => {
    expect(DEFAULT_TIER_VPS_SIZE.starter).toBe("kvm1");
    expect(DEFAULT_TIER_VPS_SIZE.standard).toBe("kvm8");
    expect(resolveVpsSize("starter")).toBe("kvm1");
    expect(resolveVpsSize("standard")).toBe("kvm8");
  });

  it("honors an explicit pin over the tier default", () => {
    expect(resolveVpsSize("standard", "kvm2")).toBe("kvm2");
    expect(resolveVpsSize("starter", "kvm8")).toBe("kvm8");
    expect(resolveVpsSize("standard", "kvm1")).toBe("kvm1");
  });

  it("falls back to the tier default on null, undefined, and corrupt values", () => {
    expect(resolveVpsSize("standard", null)).toBe("kvm8");
    expect(resolveVpsSize("standard", undefined)).toBe("kvm8");
    expect(resolveVpsSize("starter", "kvm999")).toBe("kvm1");
    expect(resolveVpsSize("starter", "")).toBe("kvm1");
  });

  it("resolveDeployedVpsSize: unpinned starter is legacy KVM2 hardware, pins win", () => {
    // Existing boxes: a null pin predates pin persistence, i.e. the box was
    // provisioned when starter⇒kvm2 — never stamp the new kvm1 profile on it.
    expect(resolveDeployedVpsSize("starter", null)).toBe("kvm2");
    expect(resolveDeployedVpsSize("starter", undefined)).toBe("kvm2");
    expect(resolveDeployedVpsSize("starter", "corrupt")).toBe("kvm2");
    expect(resolveDeployedVpsSize("standard", null)).toBe("kvm8");
    expect(resolveDeployedVpsSize("starter", "kvm1")).toBe("kvm1");
    expect(resolveDeployedVpsSize("standard", "kvm2")).toBe("kvm2");
    expect(resolveDeployedVpsSize("standard", "kvm8")).toBe("kvm8");
  });

  it("parses Hostinger plan labels into sizes, null on anything else", () => {
    expect(vpsSizeFromHostingerPlan("KVM 1")).toBe("kvm1");
    expect(vpsSizeFromHostingerPlan("KVM 2")).toBe("kvm2");
    expect(vpsSizeFromHostingerPlan("KVM 8")).toBe("kvm8");
    expect(vpsSizeFromHostingerPlan("kvm2")).toBe("kvm2");
    expect(vpsSizeFromHostingerPlan("KVM 4")).toBeNull();
    expect(vpsSizeFromHostingerPlan("KVM 12")).toBeNull();
    expect(vpsSizeFromHostingerPlan("Cloud Startup")).toBeNull();
    expect(vpsSizeFromHostingerPlan(null)).toBeNull();
    expect(vpsSizeFromHostingerPlan(undefined)).toBeNull();
  });

  it("only kvm1 lacks a local model (over-cap turns must refuse there)", () => {
    expect(vpsSizeHasLocalModel("kvm1")).toBe(false);
    expect(vpsSizeHasLocalModel("kvm2")).toBe(true);
    expect(vpsSizeHasLocalModel("kvm8")).toBe(true);
  });
});
