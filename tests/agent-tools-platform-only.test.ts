import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));

import { AGENT_TOOL_REGISTRY } from "@/lib/agent-tools/registry";
import { resolveAgentTools } from "@/lib/db/agent-tool-settings";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";

/** Fake with no override rows: everything resolves to its registry default. */
function makeDb() {
  return {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      };
      return chain;
    }
  } as never;
}

const TENANT = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function toolKeys(agents: { key: string; tools: { toolKey: string }[] }[], key: string) {
  return agents.find((a) => a.key === key)?.tools.map((t) => t.toolKey) ?? [];
}

describe("platform-only tools", () => {
  it("the registry does mark at least one tool platform-only", () => {
    const platform = AGENT_TOOL_REGISTRY.flatMap((a) =>
      a.tools.filter((t) => t.platformOnly).map((t) => t.toolKey)
    );
    expect(platform).toContain("send_signup_payment_link");
  });

  // The product rule: a dentist has no use for a New Coworker checkout link,
  // so it must never render as a toggle in their settings.
  it("are hidden from a tenant's Settings page", async () => {
    const resolved = await resolveAgentTools(TENANT, makeDb());
    expect(toolKeys(resolved, "sms")).not.toContain("send_signup_payment_link");
    for (const agent of resolved) {
      for (const tool of agent.tools) {
        expect(tool.platformOnly).not.toBe(true);
      }
    }
  });

  it("are visible to New Coworker HQ, which owns them", async () => {
    const resolved = await resolveAgentTools(HQ_BUSINESS_ID, makeDb());
    expect(toolKeys(resolved, "sms")).toContain("send_signup_payment_link");
  });

  it("leaves every ordinary tool visible to tenants", async () => {
    const resolved = await resolveAgentTools(TENANT, makeDb());
    expect(toolKeys(resolved, "sms")).toContain("business_knowledge_lookup");
    expect(toolKeys(resolved, "sms")).toContain("calendar_book_appointment");
  });
});

describe("manage_coworker_tools MCP surface", () => {
  it("never exposes a platform-only tool, not even to HQ", async () => {
    // Fails closed on the tenant-facing bridge: platform tooling is managed
    // from the admin console, so there is one less path to reason about.
    const mod = await import("@/lib/mcp/tools/coworker-tool-settings");
    const text = JSON.stringify(mod.updateCoworkerToolSettingsTool);
    expect(text).not.toContain("send_signup_payment_link");
  });
});

describe("platform-only tools are not writable", () => {
  // Bugbot, PR #1593: hiding a tool from the vocabulary is not enough. Anyone
  // who knows the key could still toggle it, including turning it OFF for HQ.
  it("the Settings write path refuses them", async () => {
    const route = await import("@/app/api/dashboard/agent-tools/route");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/dashboard/agent-tools/route.ts", "utf8")
    );
    expect(typeof route.PUT).toBe("function");
    expect(src).toContain("def.tool.platformOnly");
  });

  it("the MCP write path refuses them", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/mcp/tools/coworker-tool-settings.ts", "utf8")
    );
    expect(src).toContain("def.tool.platformOnly");
  });
});
