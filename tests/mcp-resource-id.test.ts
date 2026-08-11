import { describe, expect, it } from "vitest";
import { McpToolError } from "@/lib/mcp/auth";
import {
  formatMcpResourceId,
  MCP_RESOURCE_KINDS,
  parseMcpResourceId
} from "@/lib/mcp/resource-id";
import { mcpDashboardUrl } from "@/lib/mcp/urls";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("resource ids", () => {
  it("round-trips every kind", () => {
    for (const kind of MCP_RESOURCE_KINDS) {
      const id = { kind, businessId: BIZ, ref: "+15551234567" };
      expect(parseMcpResourceId(formatMcpResourceId(id))).toEqual(id);
    }
  });

  it("carries the business, because fetch receives nothing else", () => {
    // OpenAI's fetch contract passes an id and no other context, so the
    // business has to travel inside it.
    expect(parseMcpResourceId(`contact:${BIZ}:+15551234567`).businessId).toBe(BIZ);
  });

  it("refuses anything malformed", () => {
    for (const bad of [
      "",
      "contact",
      `contact:${BIZ}`,
      `contact:${BIZ}:+1555:extra`,
      `nope:${BIZ}:+15551234567`,
      "contact:not-a-uuid:+15551234567",
      `contact:${BIZ}:`,
      "../../etc/passwd",
      `CONTACT:${BIZ}:+15551234567`
    ]) {
      expect(() => parseMcpResourceId(bad), JSON.stringify(bad)).toThrow(McpToolError);
    }
  });

  /**
   * One refusal message for every malformed shape, on purpose. A message that
   * distinguished "no such business" from "not your business" would answer
   * questions about other tenants to anyone willing to iterate, which is the
   * same reason requireMcpBusinessRole has a single refusal.
   */
  it("says the same thing whatever was wrong, and never names the business", () => {
    const messages = [
      `nope:${BIZ}:+15551234567`,
      "contact:not-a-uuid:+15551234567",
      "garbage"
    ].map((bad) => {
      try {
        parseMcpResourceId(bad);
        throw new Error("expected a refusal");
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toContain(BIZ);
  });
});

describe("mcpDashboardUrl", () => {
  it("points at the right page per kind, absolute and encoded", () => {
    expect(mcpDashboardUrl({ kind: "contact", businessId: BIZ, ref: "+15551234567" })).toBe(
      "https://www.newcoworker.com/dashboard/customers/%2B15551234567"
    );
    expect(mcpDashboardUrl({ kind: "thread", businessId: BIZ, ref: "+15551234567" })).toBe(
      "https://www.newcoworker.com/dashboard/messages/%2B15551234567"
    );
    expect(mcpDashboardUrl({ kind: "call", businessId: BIZ, ref: "abc-123" })).toBe(
      "https://www.newcoworker.com/dashboard/calls/abc-123"
    );
  });

  it("is absolute, which is what OpenAI's citation contract needs", () => {
    for (const kind of MCP_RESOURCE_KINDS) {
      expect(mcpDashboardUrl({ kind, businessId: BIZ, ref: "x" })).toMatch(/^https:\/\//);
    }
  });
});
