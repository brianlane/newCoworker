import { describe, expect, it } from "vitest";
import {
  isMcpRoutePath,
  MCP_CLIENTS,
  MCP_ROUTES,
  mcpResourceMetadataPath
} from "@/lib/mcp/routes";

describe("MCP route registry", () => {
  it("pins the URL owners paste into each assistant", () => {
    // These are published in the dashboard card and in the OpenAI submission,
    // so a change here breaks connectors that are already installed.
    expect(MCP_ROUTES).toEqual({
      claude: "/api/mcp",
      chatgpt: "/api/mcp/chatgpt"
    });
  });

  it("gives every declared client a route", () => {
    for (const client of MCP_CLIENTS) {
      expect(MCP_ROUTES[client], `${client} has no route`).toMatch(/^\/api\/mcp/);
    }
    expect(new Set(Object.values(MCP_ROUTES)).size).toBe(MCP_CLIENTS.length);
  });

  it("derives the RFC 9728 path-inserted metadata location per client", () => {
    expect(mcpResourceMetadataPath("claude")).toBe(
      "/.well-known/oauth-protected-resource/api/mcp"
    );
    expect(mcpResourceMetadataPath("chatgpt")).toBe(
      "/.well-known/oauth-protected-resource/api/mcp/chatgpt"
    );
  });
});

describe("isMcpRoutePath", () => {
  it("matches the real endpoints", () => {
    expect(isMcpRoutePath("/api/mcp")).toBe(true);
    expect(isMcpRoutePath("/api/mcp/chatgpt")).toBe(true);
  });

  /**
   * The caller is the CSRF exemption in src/proxy.ts. A `startsWith` test
   * would exempt every future /api/mcp/* route the moment it is created,
   * including one that authenticates with a session cookie and genuinely
   * needs the check. Exact matching makes adding a route a deliberate act.
   */
  it("does not exempt a route that merely looks like one", () => {
    expect(isMcpRoutePath("/api/mcp/admin")).toBe(false);
    expect(isMcpRoutePath("/api/mcp-something")).toBe(false);
    expect(isMcpRoutePath("/api/mcp/")).toBe(false);
    expect(isMcpRoutePath("/api/mcpx")).toBe(false);
    expect(isMcpRoutePath("/api/public/v1/me")).toBe(false);
  });
});
