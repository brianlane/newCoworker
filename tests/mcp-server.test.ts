/**
 * src/lib/mcp/server.ts, the route glue that used to sit in
 * src/app/api/mcp/route.ts, outside the coverage gate.
 *
 * Driven through the real mcp-handler stack over real Request objects,
 * because every interesting behavior here is a wire behavior: what a client
 * gets challenged with, whether a junk bearer costs us a Supabase round trip,
 * and which connector a request stamps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySupabaseAccessToken = vi.hoisted(() => vi.fn());
const recordMcpConnectorSeen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  verifySupabaseAccessToken
}));

vi.mock("@/lib/mcp/connector-status", () => ({
  recordMcpConnectorSeen
}));

import {
  createMcpRouteHandlers,
  MCP_MAX_DURATION_SECONDS,
  withMcpAuthMeta
} from "@/lib/mcp/server";
import { MCP_ROUTES } from "@/lib/mcp/routes";

const CALLER = { userId: "user-123", email: "owner@example.com" };
/** Shaped like a JWT: three non-empty dot-separated parts. */
const JWT_SHAPED = "header.payload.signature";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" }
  }
};

function post(body: unknown, token?: string): Request {
  return new Request("https://www.newcoworker.com/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

/** Streamable HTTP may answer as an SSE frame rather than a bare body. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const framed = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(framed ? framed.slice(6) : text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySupabaseAccessToken.mockResolvedValue(CALLER);
  recordMcpConnectorSeen.mockResolvedValue(undefined);
});

describe("createMcpRouteHandlers", () => {
  it("exports one handler for each method the transport uses", () => {
    const handlers = createMcpRouteHandlers({ client: "claude" });
    expect(typeof handlers.GET).toBe("function");
    expect(typeof handlers.POST).toBe("function");
    expect(typeof handlers.DELETE).toBe("function");
  });

  it("lets a long tool call finish, matching the assistants' own timeout", () => {
    expect(MCP_MAX_DURATION_SECONDS).toBe(300);
  });

  /**
   * Next reads route segment config statically, so `maxDuration` cannot be the
   * imported constant: an import fails `next build` with "Invalid segment
   * configuration export detected", which neither tsc nor vitest sees. The
   * literal is therefore duplicated on purpose, and this reads the route files
   * to make sure the duplicate still agrees with the source of truth.
   */
  it("keeps every route file's maxDuration literal in step with the constant", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const path of Object.values(MCP_ROUTES)) {
      const file = `src/app${path}/route.ts`;
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue; // Route not built yet (the ChatGPT one lands later).
      }
      const declared = source.match(/export const maxDuration = (\d+);/);
      expect(declared, `${file} declares no maxDuration`).not.toBeNull();
      expect(Number(declared?.[1]), `${file} maxDuration`).toBe(MCP_MAX_DURATION_SECONDS);
      expect(source, `${file} must not import the constant into segment config`).not.toMatch(
        /maxDuration = MCP_MAX_DURATION_SECONDS/
      );
    }
  });

  it("challenges an unauthenticated request, pointing at its own metadata", async () => {
    const { POST } = createMcpRouteHandlers({ client: "claude" });
    const res = await POST(post(INITIALIZE));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp"'
    );
  });

  it("points the ChatGPT endpoint at the ChatGPT metadata document", async () => {
    const { POST } = createMcpRouteHandlers({ client: "chatgpt" });
    const res = await POST(post(INITIALIZE));
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp/chatgpt"'
    );
  });

  /**
   * ChatGPT looks for the challenge inside the JSON body as well as in the
   * header. mcp-handler supplies only the header, so without this the client
   * can show a dead "couldn't connect" instead of offering to re-authorize.
   */
  it("repeats the challenge in the body where ChatGPT looks for it", async () => {
    const { POST } = createMcpRouteHandlers({ client: "chatgpt" });
    const res = await POST(post(INITIALIZE));
    const body = await readJson(res);
    const meta = body._meta as Record<string, unknown>;
    expect(meta["mcp/www_authenticate"]).toBe(res.headers.get("www-authenticate"));
  });

  it("rejects a bearer that cannot be a JWT without asking Supabase", async () => {
    // The WAF rule in front of these routes skips bot protection, so junk
    // traffic reaches the origin. Paying a verification round trip per junk
    // request is the cheapest way to hurt us here.
    const { POST } = createMcpRouteHandlers({ client: "claude" });
    const res = await POST(post(INITIALIZE, "obviously-not-a-jwt"));
    expect(res.status).toBe(401);
    expect(verifySupabaseAccessToken).not.toHaveBeenCalled();
  });

  it("still asks Supabase about a JWT-shaped bearer", async () => {
    verifySupabaseAccessToken.mockResolvedValue(null);
    const { POST } = createMcpRouteHandlers({ client: "claude" });
    const res = await POST(post(INITIALIZE, JWT_SHAPED));
    expect(res.status).toBe(401);
    expect(verifySupabaseAccessToken).toHaveBeenCalledWith(JWT_SHAPED);
  });

  /**
   * The bearer check knows the user and the client but NOT the business, and
   * a status row without one is exactly what painted an admin's own connector
   * onto every tenant's dashboard tile. The stamp moved to
   * mcpBusinessRoleOutcome, where the business is resolved and the call is
   * authorized; this asserts it did not stay here as well.
   */
  it("admits a verified caller without stamping any connector status", async () => {
    const { POST } = createMcpRouteHandlers({ client: "chatgpt" });
    const res = await POST(post(INITIALIZE, JWT_SHAPED));
    expect(res.status).toBe(200);
    expect(recordMcpConnectorSeen).not.toHaveBeenCalled();
  });

  it("passes server instructions through to initialize", async () => {
    const { POST } = createMcpRouteHandlers({
      client: "chatgpt",
      instructions: "INSTRUCTIONS MARKER"
    });
    const body = await readJson(await POST(post(INITIALIZE, JWT_SHAPED)));
    const result = body.result as { instructions?: string };
    expect(result.instructions).toBe("INSTRUCTIONS MARKER");
  });

  it("omits instructions entirely when none are given", async () => {
    const { POST } = createMcpRouteHandlers({ client: "claude" });
    const body = await readJson(await POST(post(INITIALIZE, JWT_SHAPED)));
    const result = body.result as { instructions?: string };
    expect(result.instructions).toBeUndefined();
  });

  it("leaves a successful response untouched", async () => {
    const { POST } = createMcpRouteHandlers({ client: "claude" });
    const body = await readJson(await POST(post(INITIALIZE, JWT_SHAPED)));
    expect(body._meta).toBeUndefined();
  });
});

/**
 * Tested directly rather than through the handler: mcp-handler always answers
 * a 401 with a JSON body, so the defensive paths below are unreachable from
 * the outside. They still have to be right, because what they guard against
 * is exactly the case where guessing would corrupt a response.
 */
describe("withMcpAuthMeta", () => {
  const CHALLENGE = 'Bearer error="invalid_token", resource_metadata="https://x/.well-known/y"';

  it("adds the pointer to a JSON 401", async () => {
    const res = await withMcpAuthMeta(
      Response.json({ error: "invalid_token" }, { status: 401, headers: { "www-authenticate": CHALLENGE } })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_token");
    expect((body._meta as Record<string, unknown>)["mcp/www_authenticate"]).toBe(CHALLENGE);
    // The header is the part Claude reads, so it has to survive the rewrite.
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("leaves anything that is not a challenged 401 alone", async () => {
    const ok = Response.json({ fine: true }, { status: 200 });
    expect(await withMcpAuthMeta(ok)).toBe(ok);

    // A 401 with no challenge is not ours to annotate.
    const bare = Response.json({ error: "nope" }, { status: 401 });
    expect(await withMcpAuthMeta(bare)).toBe(bare);
  });

  it("passes a non-JSON body through rather than inventing one", async () => {
    // An HTML error page from something in front of us. Replacing it with a
    // JSON body we made up would misreport what the client actually received.
    const html = new Response("<html>blocked</html>", {
      status: 401,
      headers: { "www-authenticate": CHALLENGE, "content-type": "text/html" }
    });
    const res = await withMcpAuthMeta(html);
    expect(res).toBe(html);
    expect(await res.text()).toBe("<html>blocked</html>");
  });

  it("never overwrites a pointer the library already supplied", async () => {
    // Future-proofing: if the SDK starts setting this itself, ours must not
    // clobber it, and this test tells us the day that happens.
    const res = await withMcpAuthMeta(
      Response.json(
        { error: "invalid_token", _meta: { "mcp/www_authenticate": "theirs", keep: 1 } },
        { status: 401, headers: { "www-authenticate": CHALLENGE } }
      )
    );
    const meta = (await res.json() as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["mcp/www_authenticate"]).toBe("theirs");
    expect(meta.keep).toBe(1);
  });
});
