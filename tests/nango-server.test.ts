import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockNangoCtor = vi.fn();

vi.mock("@nangohq/node", () => ({
  prodHost: "https://api.nango.dev",
  Nango: class {
    constructor(config: unknown) {
      mockNangoCtor(config);
    }
  }
}));

import {
  getNangoClient,
  readConnectionEndUserId
} from "@/lib/nango/server";

describe("lib/nango/server", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    mockNangoCtor.mockClear();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("getNangoClient throws without secret", () => {
    delete process.env.NANGO_SECRET_KEY;
    expect(() => getNangoClient()).toThrow("NANGO_SECRET_KEY");
  });

  it("getNangoClient passes trimmed host and secret", () => {
    process.env.NANGO_SECRET_KEY = "sec";
    process.env.NANGO_HOST = "https://custom.example/";
    getNangoClient();
    expect(mockNangoCtor).toHaveBeenCalledWith({
      host: "https://custom.example",
      secretKey: "sec"
    });
  });

  it("getNangoClient defaults host to prodHost", () => {
    process.env.NANGO_SECRET_KEY = "sec";
    delete process.env.NANGO_HOST;
    getNangoClient();
    expect(mockNangoCtor).toHaveBeenCalledWith({
      host: "https://api.nango.dev",
      secretKey: "sec"
    });
  });

  describe("readConnectionEndUserId", () => {
    it("reads snake_case end_user.id", () => {
      expect(readConnectionEndUserId({ end_user: { id: "biz-1" } })).toBe("biz-1");
    });

    it("reads camelCase endUser.id", () => {
      expect(readConnectionEndUserId({ endUser: { id: "biz-2" } })).toBe("biz-2");
    });

    it("returns undefined for invalid payloads", () => {
      expect(readConnectionEndUserId(null)).toBeUndefined();
      expect(readConnectionEndUserId(undefined)).toBeUndefined();
      expect(readConnectionEndUserId({})).toBeUndefined();
      expect(readConnectionEndUserId({ end_user: {} })).toBeUndefined();
      expect(readConnectionEndUserId({ end_user: { id: 1 } })).toBeUndefined();
    });
  });
});
