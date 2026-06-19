import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const { resolveBindingMock, getActiveMock } = vi.hoisted(() => ({
  resolveBindingMock: vi.fn(),
  getActiveMock: vi.fn()
}));
vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  resolveGatewayTokenBinding: resolveBindingMock,
  getActiveGatewayTokenForBusiness: getActiveMock
}));

import {
  verifyRowboatGatewayToken,
  verifyGatewayTokenForBusiness,
  resolveOutboundRowboatBearer
} from "@/lib/rowboat/gateway-token";

function bearer(token?: string) {
  return new Request("http://localhost/", {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

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
    expect(verifyRowboatGatewayToken(bearer("secret-gateway-token"))).toBe(false);
  });

  it("rejects missing or wrong bearer token", () => {
    expect(verifyRowboatGatewayToken(bearer())).toBe(false);
    expect(verifyRowboatGatewayToken(bearer("wrong"))).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    expect(verifyRowboatGatewayToken(bearer("secret-gateway-token"))).toBe(true);
  });
});

describe("verifyGatewayTokenForBusiness", () => {
  const OLD = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "shared-tok" };
  });
  afterEach(() => {
    process.env = OLD;
  });

  it("returns false when no bearer is present", async () => {
    expect(await verifyGatewayTokenForBusiness(bearer(), "biz-1")).toBe(false);
  });

  it("accepts a per-tenant token bound to the same business", async () => {
    resolveBindingMock.mockResolvedValue({ businessId: "biz-1", token: "t" });
    expect(await verifyGatewayTokenForBusiness(bearer("t"), "biz-1")).toBe(true);
  });

  it("rejects a per-tenant token bound to a different business", async () => {
    resolveBindingMock.mockResolvedValue({ businessId: "biz-OTHER", token: "t" });
    expect(await verifyGatewayTokenForBusiness(bearer("t"), "biz-1")).toBe(false);
  });

  it("falls back to the shared token when the business has no per-tenant token", async () => {
    resolveBindingMock.mockResolvedValue(null);
    getActiveMock.mockResolvedValue(null);
    expect(await verifyGatewayTokenForBusiness(bearer("shared-tok"), "biz-1")).toBe(true);
    expect(await verifyGatewayTokenForBusiness(bearer("bad"), "biz-1")).toBe(false);
  });

  it("rejects the shared token once the business has a per-tenant token (exclusive)", async () => {
    resolveBindingMock.mockResolvedValue(null);
    getActiveMock.mockResolvedValue("biz-1-per-tenant-tok");
    expect(await verifyGatewayTokenForBusiness(bearer("shared-tok"), "biz-1")).toBe(false);
  });

  it("rejects via fallback when the shared token is unset", async () => {
    resolveBindingMock.mockResolvedValue(null);
    getActiveMock.mockResolvedValue(null);
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    expect(await verifyGatewayTokenForBusiness(bearer("anything"), "biz-1")).toBe(false);
  });

  it("fails open to the shared token check when the binding lookup throws", async () => {
    resolveBindingMock.mockRejectedValue(new Error("db blip"));
    getActiveMock.mockResolvedValue(null);
    expect(await verifyGatewayTokenForBusiness(bearer("shared-tok"), "biz-1")).toBe(true);
  });

  it("fails open to the shared token check when the per-tenant lookup throws", async () => {
    resolveBindingMock.mockResolvedValue(null);
    getActiveMock.mockRejectedValue(new Error("db blip"));
    expect(await verifyGatewayTokenForBusiness(bearer("shared-tok"), "biz-1")).toBe(true);
  });
});

describe("resolveOutboundRowboatBearer", () => {
  const OLD = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD };
    delete process.env.ROWBOAT_VPS_CHAT_BEARER;
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
  });
  afterEach(() => {
    process.env = OLD;
  });

  it("returns the per-tenant token when present", async () => {
    getActiveMock.mockResolvedValue("per-tenant-tok");
    expect(await resolveOutboundRowboatBearer("biz-1")).toBe("per-tenant-tok");
  });

  it("falls back to ROWBOAT_VPS_CHAT_BEARER then ROWBOAT_GATEWAY_TOKEN", async () => {
    getActiveMock.mockResolvedValue(null);
    process.env.ROWBOAT_VPS_CHAT_BEARER = "vps-bearer";
    expect(await resolveOutboundRowboatBearer("biz-1")).toBe("vps-bearer");

    delete process.env.ROWBOAT_VPS_CHAT_BEARER;
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-tok";
    expect(await resolveOutboundRowboatBearer("biz-1")).toBe("gw-tok");

    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    expect(await resolveOutboundRowboatBearer("biz-1")).toBe("");
  });

  it("fails over to the env fallback when the lookup throws", async () => {
    getActiveMock.mockRejectedValue(new Error("db down"));
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-fallback";
    expect(await resolveOutboundRowboatBearer("biz-1")).toBe("gw-fallback");
  });
});
