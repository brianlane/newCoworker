/**
 * Contract test: drives the REAL mcp-handler + @modelcontextprotocol/server
 * stack over real Request objects, rather than the hand-rolled fake server
 * used in mcp-registry.test.ts.
 *
 * Why this exists on top of the unit tests: the unit tests verify
 * `authFromContext` against OUR belief about where the verified token sits in
 * the per-request context. They cannot catch that belief being wrong. The
 * mcp-handler 1.x -> 2.x upgrade moved it from `extra.authInfo` to
 * `ctx.http.authInfo`, a change that still type-checks (the context is
 * narrowed from `unknown`) and silently fails every tool call closed. Only
 * asking the actual library catches that class of break, so this file asserts
 * the library's shape directly and pins the OAuth 401 challenge with it.
 */

import { describe, expect, it } from "vitest";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { allMcpTools, authFromContext, registerMcpTools } from "@/lib/mcp/registry";
import { MCP_WIDGET_URI } from "@/lib/mcp/widgets";

const VALID_BEARER = "valid-test-bearer";
const CALLER = { userId: "user-123", email: "owner@example.com" };

type SeenContext = { viaHelper: unknown; legacyTopLevel: unknown; args: unknown };

function buildHandler() {
  const seen: SeenContext[] = [];

  const handler = createMcpHandler(
    (server) => {
      server.registerTool(
        "whoami",
        { description: "Echo the verified caller.", inputSchema: z.object({ ping: z.string() }) },
        async (args: Record<string, unknown>, ctx: unknown) => {
          seen.push({
            // The production read, exercised against the real context object.
            viaHelper: authFromContext(ctx),
            // What the pre-2.x read would have found in the same context.
            legacyTopLevel: (ctx as { authInfo?: unknown } | null)?.authInfo,
            args
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(authFromContext(ctx)) }] };
        }
      );
    },
    { serverInfo: { name: "new-coworker", version: "1.0.0" } }
  );

  const authHandler = withMcpAuth(
    handler,
    async (_req: Request, bearerToken?: string) =>
      bearerToken === VALID_BEARER
        ? { token: bearerToken, clientId: CALLER.userId, scopes: [], extra: { ...CALLER } }
        : undefined,
    { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" }
  );

  const rpc = async (body: unknown, token?: string) => {
    const res = await authHandler(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
      })
    );
    return { status: res.status, text: await res.text() };
  };

  return { rpc, seen };
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" }
  }
};

const callBody = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "whoami", arguments: { ping: "hello" } }
};

describe("mcp-handler 2.x contract", () => {
  it("challenges an unauthenticated request", async () => {
    const { rpc } = buildHandler();
    expect((await rpc(initBody)).status).toBe(401);
  });

  it("rejects an invalid bearer", async () => {
    const { rpc } = buildHandler();
    expect((await rpc(initBody, "not-the-token")).status).toBe(401);
  });

  it("initializes for a verified bearer", async () => {
    const { rpc } = buildHandler();
    expect((await rpc(initBody, VALID_BEARER)).status).toBe(200);
  });

  it("advertises the registered tool and its input schema", async () => {
    const { rpc } = buildHandler();
    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, VALID_BEARER);
    expect(list.text).toContain("whoami");
    expect(list.text).toContain("ping");
  });

  it("delivers the verified caller to the tool via ctx.http.authInfo", async () => {
    const { rpc, seen } = buildHandler();
    const res = await rpc(callBody, VALID_BEARER);

    expect(seen).toHaveLength(1);
    expect(seen[0].args).toMatchObject({ ping: "hello" });
    // authFromContext defaults the client to claude when the context carries none.
    expect(seen[0].viaHelper).toEqual({ ...CALLER, client: "claude" });
    expect(res.text).toContain(CALLER.email);
  });

  it("exposes nothing at the pre-2.x top-level authInfo path", async () => {
    const { rpc, seen } = buildHandler();
    await rpc(callBody, VALID_BEARER);

    // If this ever becomes defined again, the nesting moved back and
    // authFromContext needs revisiting.
    expect(seen[0].legacyTopLevel).toBeUndefined();
  });
});

/**
 * The block above proves the LIBRARY's shape using a hand-registered tool.
 * This one proves OUR registry reaches the wire correctly, which is a
 * different failure: every metadata field is optional in the SDK's config
 * type, so a renamed or dropped key still type-checks and the annotations
 * simply vanish from tools/list. That silent vanishing is precisely what gets
 * a ChatGPT plugin rejected, and nothing else in the suite can see it,
 * because the unit tests assert our own objects rather than the JSON a client
 * receives.
 *
 * tools/list only. Calling a real tool would need a database.
 */
describe("the real registry on the wire", () => {
  const realHandler = createMcpHandler((server) => registerMcpTools(server), {
    serverInfo: { name: "new-coworker", version: "1.0.0" }
  });

  async function toolsList(): Promise<Array<Record<string, unknown>>> {
    const res = await realHandler(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      })
    );
    const text = await res.text();
    // Streamable HTTP may answer as an SSE frame rather than a bare body.
    const framed = text.split("\n").find((line) => line.startsWith("data: "));
    const parsed = JSON.parse(framed ? framed.slice(6) : text) as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    return parsed.result?.tools ?? [];
  }

  it("puts title and all three annotations on every advertised tool", async () => {
    const tools = await toolsList();
    expect(tools.length).toBe(allMcpTools.length);

    for (const tool of tools) {
      const name = tool.name as string;
      // `title` is TOP LEVEL on the wire. The spec also allows
      // `annotations.title`, so a wrong choice would still serialize.
      expect(typeof tool.title, `${name} title`).toBe("string");
      expect((tool.title as string).length, `${name} title`).toBeGreaterThan(0);

      const annotations = tool.annotations as Record<string, unknown> | undefined;
      expect(annotations, `${name} annotations`).toBeDefined();
      expect(typeof annotations?.readOnlyHint, `${name} readOnlyHint`).toBe("boolean");
      expect(typeof annotations?.destructiveHint, `${name} destructiveHint`).toBe("boolean");
      expect(typeof annotations?.openWorldHint, `${name} openWorldHint`).toBe("boolean");
    }
  });

  it("advertises an object-rooted output schema for every tool", async () => {
    // Two failures this catches, neither of which type-checks its way out:
    // a tool shipped without a schema (the SDK makes it optional), and a
    // schema whose JSON Schema conversion silently produced a non-object
    // root, which changes how results are wrapped on the wire.
    const tools = await toolsList();
    for (const tool of tools) {
      const schema = tool.outputSchema as Record<string, unknown> | undefined;
      expect(schema, `${tool.name as string} has no outputSchema`).toBeDefined();
      expect(schema?.type, `${tool.name as string} outputSchema root`).toBe("object");
    }
  });

  it("advertises the widgets as resources and links the tools that use them", async () => {
    // Nothing else can see this. Both the resource registration and the tool
    // _meta are optional in the SDK's types, so a dropped or renamed key still
    // type-checks and the widget silently never renders.
    const res = await realHandler(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} })
      })
    );
    const text = await res.text();
    const framed = text.split("\n").find((l) => l.startsWith("data: "));
    const parsed = JSON.parse(framed ? framed.slice(6) : text) as {
      result?: { resources?: Array<Record<string, unknown>> };
    };
    const uris = (parsed.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(Object.values(MCP_WIDGET_URI)));

    const tools = await toolsList();
    const contact = tools.find((t) => t.name === "get_contact");
    const meta = contact?._meta as Record<string, unknown> | undefined;
    expect(meta?.["openai/outputTemplate"]).toBe(MCP_WIDGET_URI.contact);
    // And a text-only tool carries none, rather than an empty object.
    expect(tools.find((t) => t.name === "send_sms")?._meta).toBeUndefined();
  });

  it("serves the widget document itself, with the Apps SDK mime type", async () => {
    // resources/list proves the widget is advertised; only a read proves the
    // document comes back, which is what the host actually renders.
    const res = await realHandler(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: MCP_WIDGET_URI.contact }
        })
      })
    );
    const text = await res.text();
    const framed = text.split("\n").find((l) => l.startsWith("data: "));
    const parsed = JSON.parse(framed ? framed.slice(6) : text) as {
      result?: { contents?: Array<Record<string, unknown>> };
    };
    const doc = parsed.result?.contents?.[0];
    expect(doc?.mimeType).toBe("text/html;profile=mcp-app");
    expect(String(doc?.text)).toContain("<!doctype html>");
  });

  it("carries the exact values we declared, not defaults", async () => {
    const tools = await toolsList();
    const sendSms = tools.find((t) => t.name === "send_sms");
    expect(sendSms?.title).toBe("Send a text message");
    expect(sendSms?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    });

    const listBusinesses = tools.find((t) => t.name === "list_businesses");
    expect(listBusinesses?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });
  });
});
