import { describe, expect, it } from "vitest";

import {
  BUSINESS_ACTIONS,
  can,
  isBusinessRole,
  isMemberRole,
  roleAtLeast,
  type BusinessAction
} from "@/lib/authz/policy";

describe("authz policy matrix", () => {
  it("roleAtLeast orders owner > manager > staff", () => {
    expect(roleAtLeast("owner", "staff")).toBe(true);
    expect(roleAtLeast("owner", "manager")).toBe(true);
    expect(roleAtLeast("manager", "staff")).toBe(true);
    expect(roleAtLeast("manager", "owner")).toBe(false);
    expect(roleAtLeast("staff", "manager")).toBe(false);
    expect(roleAtLeast("staff", "staff")).toBe(true);
  });

  it("owner can do everything", () => {
    for (const action of BUSINESS_ACTIONS) {
      expect(can("owner", action)).toBe(true);
    }
  });

  it("manager can run the business but not billing", () => {
    const allowed: BusinessAction[] = [
      "view_dashboard",
      "operate_messages",
      "manage_settings",
      "manage_aiflows",
      "manage_team"
    ];
    for (const action of allowed) {
      expect(can("manager", action)).toBe(true);
    }
    expect(can("manager", "manage_billing")).toBe(false);
  });

  it("staff can view and operate only", () => {
    expect(can("staff", "view_dashboard")).toBe(true);
    expect(can("staff", "operate_messages")).toBe(true);
    expect(can("staff", "manage_settings")).toBe(false);
    expect(can("staff", "manage_aiflows")).toBe(false);
    expect(can("staff", "manage_team")).toBe(false);
    expect(can("staff", "manage_billing")).toBe(false);
  });

  it("narrows raw role values", () => {
    expect(isBusinessRole("owner")).toBe(true);
    expect(isBusinessRole("manager")).toBe(true);
    expect(isBusinessRole("staff")).toBe(true);
    expect(isBusinessRole("admin")).toBe(false);
    expect(isBusinessRole(null)).toBe(false);

    expect(isMemberRole("manager")).toBe(true);
    expect(isMemberRole("staff")).toBe(true);
    expect(isMemberRole("owner")).toBe(false);
    expect(isMemberRole(undefined)).toBe(false);
  });
});
