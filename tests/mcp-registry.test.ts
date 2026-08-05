import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/tooling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/tooling")>();
  return { ...actual, runMcpTool: vi.fn() };
});

import { z } from "zod";
import { allMcpTools, authFromContext, registerMcpTools } from "@/lib/mcp/registry";
import { runMcpTool } from "@/lib/mcp/tooling";
import type { McpServer } from "@modelcontextprotocol/server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("allMcpTools", () => {
  it("exposes the full v1 tool set with unique names", () => {
    const names = allMcpTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of [
      "list_businesses",
      "get_business",
      "search_contacts",
      "get_contact",
      "get_sms_thread",
      "list_recent_events",
      "list_call_transcripts",
      "list_tasks",
      "send_sms",
      "calendar_find_slots",
      "calendar_book_appointment",
      "create_contact",
      "update_contact",
      "list_flows",
      "get_flow",
      "get_flow_schema",
      "create_flow",
      "update_flow",
      "set_flow_enabled",
      "trigger_flow",
      "list_agents",
      "create_agent",
      "update_agent",
      "delete_agent"
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("every tool carries a model-facing description", () => {
    for (const tool of allMcpTools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe("authFromContext", () => {
  it("extracts the verified identity from ctx.http.authInfo", () => {
    expect(
      authFromContext({ http: { authInfo: { extra: { userId: "u1", email: "a@b.c" } } } })
    ).toEqual({ userId: "u1", email: "a@b.c" });
  });

  // Regression guard for the mcp-handler 1.x -> 2.x migration. 1.x handed the
  // verified token to tools at the top level (`extra.authInfo`); 2.x nests it
  // under the transport (`ctx.http.authInfo`). Reading the 1.x path against a
  // 2.x server still COMPILES (the context is narrowed from `unknown`) and
  // silently fails every tool call closed, so the old shape must stay
  // explicitly unauthenticated here rather than merely untested.
  it("does not accept the pre-2.x top-level authInfo shape", () => {
    expect(authFromContext({ authInfo: { extra: { userId: "u1", email: "a@b.c" } } })).toBeNull();
  });

  it("returns null for missing or malformed identities", () => {
    expect(authFromContext(null)).toBeNull();
    expect(authFromContext({})).toBeNull();
    expect(authFromContext({ http: {} })).toBeNull();
    expect(authFromContext({ http: { authInfo: {} } })).toBeNull();
    expect(
      authFromContext({ http: { authInfo: { extra: { userId: 5, email: "a@b.c" } } } })
    ).toBeNull();
    expect(
      authFromContext({ http: { authInfo: { extra: { userId: "u1", email: 5 } } } })
    ).toBeNull();
    expect(
      authFromContext({ http: { authInfo: { extra: { userId: "u1", email: "" } } } })
    ).toBeNull();
  });
});

describe("registerMcpTools", () => {
  type Registered = {
    name: string;
    config: { description: string; inputSchema: unknown };
    cb: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  };

  function fakeServer() {
    const registered: Registered[] = [];
    const server = {
      registerTool: vi.fn((name: string, config: Registered["config"], cb: Registered["cb"]) => {
        registered.push({ name, config, cb });
      })
    };
    return { server: server as unknown as McpServer, registered };
  }

  it("registers every tool with its description and schema", () => {
    const { server, registered } = fakeServer();
    registerMcpTools(server);
    expect(registered.map((r) => r.name)).toEqual(allMcpTools.map((t) => t.name));
    expect(registered[0].config.description).toBe(allMcpTools[0].description);
  });

  // 2.x takes a Standard Schema (a `z.object(...)`) and only still accepts the
  // bare `{ field: z.string() }` record through a deprecated overload. Assert
  // the wrapped form so a future revert to the raw shape fails here rather
  // than when that overload is eventually dropped.
  it("wraps each tool's raw zod shape in a z.object for the 2.x API", () => {
    const { server, registered } = fakeServer();
    registerMcpTools(server);
    for (const entry of registered) {
      expect(entry.config.inputSchema).toBeInstanceOf(z.ZodObject);
    }
    const first = z.object(allMcpTools[0].schema);
    expect(Object.keys((registered[0].config.inputSchema as typeof first).shape)).toEqual(
      Object.keys(allMcpTools[0].schema)
    );
  });

  it("runs the tool as the verified caller from authInfo", async () => {
    const { server, registered } = fakeServer();
    registerMcpTools(server);
    vi.mocked(runMcpTool).mockResolvedValue({
      content: [{ type: "text", text: "ok" }]
    });
    const first = registered[0];
    const result = await first.cb(
      { a: 1 },
      { http: { authInfo: { extra: { userId: "u1", email: "a@b.c" } } } }
    );
    expect(runMcpTool).toHaveBeenCalledWith(
      allMcpTools[0],
      { a: 1 },
      { userId: "u1", email: "a@b.c" }
    );
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("fails closed when the request carries no verified identity", async () => {
    const { server, registered } = fakeServer();
    registerMcpTools(server);
    const result = (await registered[0].cb({}, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unauthenticated/);
    expect(runMcpTool).not.toHaveBeenCalled();
  });
});
