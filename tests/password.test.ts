import { describe, expect, it } from "vitest";
import {
  getPasswordValidationError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  PASSWORD_SYMBOLS
} from "@/lib/password";

// Every fixture below is at or above the minimum so that the check under test
// is the one that actually fires. A 9-character fixture would now trip the
// length rule first and assert nothing about lowercase, uppercase, digits or
// symbols.
const BASE = "Abcdefghij1!";

describe("password", () => {
  it("keeps the minimum at or above the Supabase project setting", () => {
    // Raised to 12 with the project setting on 2026-08-01. If this constant
    // ever drops below the server's "Minimum password length", the form starts
    // accepting passwords Supabase will reject.
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(BASE.length).toBe(PASSWORD_MIN_LENGTH);
  });

  it("exports the expected password rules", () => {
    expect(PASSWORD_RULES).toEqual([
      "At least 12 characters",
      "At least 1 lowercase letter",
      "At least 1 uppercase letter",
      "At least 1 number",
      "At least 1 symbol, such as ! ? @ # $ %",
      "Must match the confirmation field"
    ]);
  });

  it("rejects passwords shorter than the minimum", () => {
    expect(getPasswordValidationError("Abc12!")).toBe("Password must be at least 12 characters");
    // One short of the minimum, the boundary most likely to regress.
    expect(getPasswordValidationError("Abcdefghi1!")).toBe(
      "Password must be at least 12 characters"
    );
  });

  it("rejects passwords without a lowercase letter", () => {
    expect(getPasswordValidationError("ABCDEFGHIJ1!")).toBe(
      "Password must include at least 1 lowercase letter"
    );
  });

  it("rejects passwords without an uppercase letter", () => {
    expect(getPasswordValidationError("abcdefghij1!")).toBe(
      "Password must include at least 1 uppercase letter"
    );
  });

  it("rejects passwords without a number", () => {
    expect(getPasswordValidationError("Abcdefghijk!")).toBe(
      "Password must include at least 1 number"
    );
  });

  it("rejects passwords without a symbol", () => {
    expect(getPasswordValidationError("Abcdefghij12")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
  });

  it("does not count a space or a non-ASCII symbol as a symbol", () => {
    // Supabase's symbol set is ASCII punctuation only, so accepting these
    // client-side would hand the user a server-side rejection instead.
    expect(getPasswordValidationError("Abcdefghij1 ")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
    expect(getPasswordValidationError("Abcdefghij1£")).toBe(
      "Password must include at least 1 symbol, such as ! ? @ # $ %"
    );
  });

  it("accepts every symbol Supabase accepts", () => {
    for (const symbol of PASSWORD_SYMBOLS) {
      expect(getPasswordValidationError(`Abcdefghij1${symbol}`)).toBeNull();
    }
  });

  it("accepts passwords that satisfy all validation rules", () => {
    expect(getPasswordValidationError(BASE)).toBeNull();
  });
});
