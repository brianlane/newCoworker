import { describe, expect, it } from "vitest";
import {
  isPendingOwnerEmail,
  resolveOwnerNotifyEmail
} from "@/lib/provisioning/notify-recipient";

describe("provisioning notify recipient", () => {
  it("detects pending onboarding sentinel addresses", () => {
    expect(isPendingOwnerEmail("pending+biz@onboarding.local")).toBe(true);
    expect(isPendingOwnerEmail("  Pending+BIZ@onboarding.local  ")).toBe(true);
    expect(isPendingOwnerEmail("owner@example.com")).toBe(false);
  });

  it("prefers the input override over the stored owner email", () => {
    expect(resolveOwnerNotifyEmail("override@example.com", "stored@example.com")).toBe(
      "override@example.com"
    );
  });

  it("falls back to the stored owner email when the override is absent", () => {
    expect(resolveOwnerNotifyEmail(undefined, "stored@example.com")).toBe("stored@example.com");
  });

  it("returns null for pending sentinel or empty values", () => {
    expect(resolveOwnerNotifyEmail(undefined, "pending+biz@onboarding.local")).toBeNull();
    expect(resolveOwnerNotifyEmail("  ", "owner@example.com")).toBeNull();
    expect(resolveOwnerNotifyEmail(undefined, null)).toBeNull();
  });
});
