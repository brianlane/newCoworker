import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmailInboundAuth } from "@/lib/email/inbound-auth";

const ORIGINAL = process.env.EMAIL_INBOUND_SECRET;

function req(auth?: string): Request {
  return new Request("https://app.example.com/api/email/inbound", {
    method: "POST",
    headers: auth ? { authorization: auth } : {}
  });
}

beforeEach(() => {
  process.env.EMAIL_INBOUND_SECRET = "s3cret-token";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EMAIL_INBOUND_SECRET;
  else process.env.EMAIL_INBOUND_SECRET = ORIGINAL;
});

describe("assertEmailInboundAuth", () => {
  it("returns false when no secret is configured", () => {
    delete process.env.EMAIL_INBOUND_SECRET;
    expect(assertEmailInboundAuth(req("Bearer s3cret-token"))).toBe(false);
  });
  it("returns false without an authorization header", () => {
    expect(assertEmailInboundAuth(req())).toBe(false);
  });
  it("returns false for a mismatched token", () => {
    expect(assertEmailInboundAuth(req("Bearer wrong"))).toBe(false);
  });
  it("returns true for the matching bearer token", () => {
    expect(assertEmailInboundAuth(req("Bearer s3cret-token"))).toBe(true);
  });
});
