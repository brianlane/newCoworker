import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

describe("verifyRowboatGatewayToken", () => {
  const OLD = process.env;

  beforeEach(() => {
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "secret-gateway-token" };
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("rejects when ROWBOAT_GATEWAY_TOKEN is unset", () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer secret-gateway-token" }
    });
    expect(verifyRowboatGatewayToken(req)).toBe(false);
  });

  it("rejects missing or wrong bearer token", () => {
    expect(verifyRowboatGatewayToken(new Request("http://localhost/"))).toBe(false);
    const bad = new Request("http://localhost/", {
      headers: { Authorization: "Bearer wrong" }
    });
    expect(verifyRowboatGatewayToken(bad)).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer secret-gateway-token" }
    });
    expect(verifyRowboatGatewayToken(req)).toBe(true);
  });
});
