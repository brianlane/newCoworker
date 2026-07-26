import { describe, expect, it } from "vitest";
import { getPasswordValidationError, PASSWORD_RULES, PASSWORD_SYMBOLS } from "@/lib/password";

describe("password", () => {
  it("exports the expected password rules", () => {
    expect(PASSWORD_RULES).toEqual([
      "At least 8 characters",
      "At least 1 lowercase letter",
      "At least 1 uppercase letter",
      "At least 1 number",
      "At least 1 symbol, such as ! ? @ # $ %",
      "Must match the confirmation field"
    ]);
  });

  it("rejects passwords shorter than eight characters", () => {
    expect(getPasswordValidationError("Abc12!")).toBe("Password must be at least 8 characters");
  });

  it("rejects passwords without a lowercase letter", () => {
    expect(getPasswordValidationError("ABCDEFG1!")).toBe(
      "Password must include at least 1 lowercase letter"
    );
  });

  it("rejects passwords without an uppercase letter", () => {
    expect(getPasswordValidationError("abcdefg1!")).toBe(
      "Password must include at least 1 uppercase letter"
    );
  });

  it("rejects passwords without a number", () => {
    expect(getPasswordValidationError("Abcdefgh!")).toBe("Password must include at least 1 number");
  });

  it("rejects passwords without a symbol", () => {
    expect(getPasswordValidationError("Abcdefg1")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
  });

  it("does not count a space or a non-ASCII symbol as a symbol", () => {
    // Supabase's symbol set is ASCII punctuation only, so accepting these
    // client-side would hand the user a server-side rejection instead.
    expect(getPasswordValidationError("Abcdefg 1")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
    expect(getPasswordValidationError("Abcdefg1£")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
  });

  it("accepts every symbol Supabase accepts", () => {
    for (const symbol of PASSWORD_SYMBOLS) {
      expect(getPasswordValidationError(`Abcdefg1${symbol}`)).toBeNull();
    }
  });

  it("accepts passwords that satisfy all validation rules", () => {
    expect(getPasswordValidationError("Abcdefg1!")).toBeNull();
  });
});
