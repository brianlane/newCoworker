import { describe, expect, it } from "vitest";
import {
  ADMIN_MFA_PATH,
  adminMfaRedirectPath,
  hasAdminMfa,
  isAal2,
  isAdminEmail,
  safeAdminNextPath
} from "@/lib/auth/admin-aal";

describe("admin-aal", () => {
  it("matches admin email case-insensitively", () => {
    expect(isAdminEmail("Admin@Example.com", "admin@example.com")).toBe(true);
    expect(isAdminEmail("other@example.com", "admin@example.com")).toBe(false);
    expect(isAdminEmail("admin@example.com", undefined)).toBe(false);
  });

  it("recognizes aal2 only", () => {
    expect(isAal2("aal2")).toBe(true);
    expect(isAal2("aal1")).toBe(false);
    expect(isAal2(null)).toBe(false);
  });

  it("requires both admin email and aal2 for admin MFA", () => {
    expect(hasAdminMfa("admin@example.com", "aal2", "admin@example.com")).toBe(true);
    expect(hasAdminMfa("admin@example.com", "aal1", "admin@example.com")).toBe(false);
    expect(hasAdminMfa("user@example.com", "aal2", "admin@example.com")).toBe(false);
  });

  it("sanitizes post-MFA next paths", () => {
    expect(safeAdminNextPath("/admin/clients")).toBe("/admin/clients");
    expect(safeAdminNextPath("https://evil.example")).toBe("/admin/dashboard");
    expect(safeAdminNextPath("//evil.example")).toBe("/admin/dashboard");
    expect(safeAdminNextPath(ADMIN_MFA_PATH)).toBe("/admin/dashboard");
  });

  it("builds a safe MFA redirect with next", () => {
    expect(adminMfaRedirectPath("/admin/clients")).toBe(
      `${ADMIN_MFA_PATH}?next=${encodeURIComponent("/admin/clients")}`
    );
    expect(adminMfaRedirectPath("https://evil.example")).toBe(
      `${ADMIN_MFA_PATH}?next=${encodeURIComponent("/admin/dashboard")}`
    );
    expect(adminMfaRedirectPath("//evil.example")).toBe(
      `${ADMIN_MFA_PATH}?next=${encodeURIComponent("/admin/dashboard")}`
    );
    expect(adminMfaRedirectPath(ADMIN_MFA_PATH)).toBe(
      `${ADMIN_MFA_PATH}?next=${encodeURIComponent("/admin/dashboard")}`
    );
  });
});
