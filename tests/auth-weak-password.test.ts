import { describe, expect, it } from "vitest";
import {
  isWeakPasswordAuthError,
  WEAK_PASSWORD_USER_MESSAGE
} from "@/lib/auth-weak-password";

const BA_FITNESS_MESSAGE =
  "Password is known to be weak and easy to guess, please choose a different one.";

describe("isWeakPasswordAuthError", () => {
  it("matches the SDK AuthWeakPasswordError shape (code + name + pwned reason)", () => {
    expect(
      isWeakPasswordAuthError({
        name: "AuthWeakPasswordError",
        message: BA_FITNESS_MESSAGE,
        status: 422,
        code: "weak_password",
        reasons: ["pwned"]
      })
    ).toBe(true);
  });

  it("matches GoTrue's error_code field when the SDK did not remap it", () => {
    expect(isWeakPasswordAuthError({ error_code: "weak_password" })).toBe(true);
  });

  it("matches the class name even without a code", () => {
    expect(isWeakPasswordAuthError({ name: "AuthWeakPasswordError" })).toBe(true);
  });

  it("matches a reasons array that includes pwned", () => {
    expect(isWeakPasswordAuthError({ reasons: ["pwned"] })).toBe(true);
  });

  it("matches the BA Fitness 422 message with no other fields", () => {
    expect(isWeakPasswordAuthError({ message: BA_FITNESS_MESSAGE })).toBe(true);
  });

  it("matches GoTrue's raw `msg` field", () => {
    expect(isWeakPasswordAuthError({ msg: BA_FITNESS_MESSAGE })).toBe(true);
  });

  it("matches a bare HIBP string (the form Auth logs)", () => {
    expect(isWeakPasswordAuthError(BA_FITNESS_MESSAGE)).toBe(true);
  });

  it("matches neighbouring GoTrue / HIBP wordings", () => {
    expect(isWeakPasswordAuthError("Password is too weak")).toBe(true);
    expect(isWeakPasswordAuthError("Password found in a data breach")).toBe(true);
    expect(isWeakPasswordAuthError("This password was found in a breach")).toBe(true);
    expect(isWeakPasswordAuthError("HaveIBeenPwned rejected this password")).toBe(true);
    expect(isWeakPasswordAuthError("pwned password: choose another")).toBe(true);
    expect(isWeakPasswordAuthError("Compromised password, pick another")).toBe(true);
    expect(isWeakPasswordAuthError("This password is too common")).toBe(true);
    expect(isWeakPasswordAuthError("Password leaked in a dump")).toBe(true);
    expect(isWeakPasswordAuthError("Password breached, try another")).toBe(true);
  });

  it("does not match unrelated createUser failures, including other 422s", () => {
    expect(isWeakPasswordAuthError(null)).toBe(false);
    expect(isWeakPasswordAuthError(undefined)).toBe(false);
    expect(isWeakPasswordAuthError(false)).toBe(false);
    expect(isWeakPasswordAuthError(422)).toBe(false);
    expect(isWeakPasswordAuthError({})).toBe(false);
    expect(isWeakPasswordAuthError({ message: "Database is down" })).toBe(false);
    expect(isWeakPasswordAuthError({ message: "User already registered" })).toBe(false);
    expect(
      isWeakPasswordAuthError({
        message: "Email address is invalid",
        status: 422,
        code: "email_address_invalid"
      })
    ).toBe(false);
    expect(isWeakPasswordAuthError({ reasons: ["length"] })).toBe(false);
    expect(isWeakPasswordAuthError({ message: 12 })).toBe(false);
    expect(isWeakPasswordAuthError("fetch failed")).toBe(false);
  });
});

describe("WEAK_PASSWORD_USER_MESSAGE", () => {
  it("tells the customer the password is too common and to pick another", () => {
    expect(WEAK_PASSWORD_USER_MESSAGE).toMatch(/too common|easy to guess/i);
    expect(WEAK_PASSWORD_USER_MESSAGE).toMatch(/different one/i);
    expect(WEAK_PASSWORD_USER_MESSAGE).not.toMatch(/Could not create/i);
  });
});
