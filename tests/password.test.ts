import { describe, expect, it } from "vitest";
import { getPasswordValidationError, PASSWORD_RULES } from "@/lib/password";

describe("password", () => {
  it("exports the expected password rules", () => {
    expect(PASSWORD_RULES).toEqual([
      "At least 8 characters",
      "At least 1 uppercase letter",
      "At least 1 number",
      "Must match the confirmation field"
    ]);
  });

  it("rejects passwords shorter than eight characters", () => {
    expect(getPasswordValidationError("Abc123")).toBe("Password must be at least 8 characters");
  });

  it("rejects passwords without an uppercase letter", () => {
    expect(getPasswordValidationError("abcdefg1")).toBe("Password must include at least 1 uppercase letter");
  });

  it("rejects passwords without a number", () => {
    expect(getPasswordValidationError("Abcdefgh")).toBe("Password must include at least 1 number");
  });

  it("accepts passwords that satisfy all validation rules", () => {
    expect(getPasswordValidationError("Abcdefg1")).toBeNull();
  });
});
