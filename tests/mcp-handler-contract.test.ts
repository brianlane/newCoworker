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
import { authFromContext } from "@/lib/mcp/registry";

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
    expect(seen[0].viaHelper).toEqual(CALLER);
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
