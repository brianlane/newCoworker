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
  readConnectionEndUserId,
  workspaceConnectionMetadataFromNangoConnection
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

  describe("workspaceConnectionMetadataFromNangoConnection", () => {
    it("returns only connected_via when payload missing", () => {
      expect(workspaceConnectionMetadataFromNangoConnection(null)).toEqual({
        connected_via: "connect_ui"
      });
    });

    it("reads snake_case end_user email and display name", () => {
      expect(
        workspaceConnectionMetadataFromNangoConnection({
          end_user: { id: "x", email: "  a@b.co  ", display_name: " Pat " }
        })
      ).toEqual({
        connected_via: "connect_ui",
        end_user_email: "a@b.co",
        end_user_display_name: "Pat"
      });
    });

    it("reads camelCase endUser", () => {
      expect(
        workspaceConnectionMetadataFromNangoConnection({
          endUser: { id: "x", email: "x@y.z", displayName: "X" }
        })
      ).toEqual({
        connected_via: "connect_ui",
        end_user_email: "x@y.z",
        end_user_display_name: "X"
      });
    });

    it("returns base when end_user is missing or not an object", () => {
      expect(workspaceConnectionMetadataFromNangoConnection({})).toEqual({
        connected_via: "connect_ui"
      });
      expect(workspaceConnectionMetadataFromNangoConnection({ end_user: null })).toEqual({
        connected_via: "connect_ui"
      });
    });

    it("omits email and display name when blank after trim", () => {
      expect(
        workspaceConnectionMetadataFromNangoConnection({
          end_user: { id: "x", email: "   ", display_name: "" }
        })
      ).toEqual({ connected_via: "connect_ui" });
    });

    it("stores only email when display name absent", () => {
      expect(
        workspaceConnectionMetadataFromNangoConnection({
          end_user: { id: "x", email: "only@email.test" }
        })
      ).toEqual({
        connected_via: "connect_ui",
        end_user_email: "only@email.test"
      });
    });
  });
});
