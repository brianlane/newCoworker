import { afterEach, describe, expect, it } from "vitest";

import {
  buildMcpProtectedResourceMetadata,
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  mcpResourceUrl,
  supabaseAuthIssuer
} from "@/lib/mcp/oauth";
import { GET as bareMetadataGet } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as twinMetadataGet } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as chatgptMetadataGet } from "@/app/.well-known/oauth-protected-resource/api/mcp/chatgpt/route";

const ISSUER = "https://proj.supabase.co";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

/** A request as it arrives behind the proxy, which rewrites the host. */
function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("supabaseAuthIssuer", () => {
  it("appends /auth/v1 to the project URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    expect(supabaseAuthIssuer()).toBe("https://proj.supabase.co/auth/v1");
  });

  it("strips trailing slashes first", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co//";
    expect(supabaseAuthIssuer()).toBe("https://proj.supabase.co/auth/v1");
  });

  it("throws when the env var is missing", () => {
    expect(() => supabaseAuthIssuer()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("mcpResourceUrl", () => {
  it("names the MCP endpoint, not the bare origin", () => {
    expect(mcpResourceUrl(request("https://www.newcoworker.com/.well-known/x"))).toBe(
      "https://www.newcoworker.com/api/mcp"
    );
  });

  it("follows the host the client actually reached", () => {
    // This app answers on newcoworker.com AND www.newcoworker.com, and on a
    // fresh host per preview deployment. An identifier that disagrees with the
    // URL the owner pasted into their assistant is the exact mismatch that
    // audience validation exists to reject.
    expect(mcpResourceUrl(request("https://newcoworker.com/whatever"))).toBe(
      "https://newcoworker.com/api/mcp"
    );
    expect(mcpResourceUrl(request("https://preview-abc.vercel.app/whatever"))).toBe(
      "https://preview-abc.vercel.app/api/mcp"
    );
  });

  it("reads the forwarded host rather than the internal one", () => {
    expect(
      mcpResourceUrl(
        request("http://10.0.0.5:3000/.well-known/x", {
          "x-forwarded-host": "www.newcoworker.com",
          "x-forwarded-proto": "https"
        })
      )
    ).toBe("https://www.newcoworker.com/api/mcp");
  });

  it("pins the paths the 401 challenge and the routes are built from", () => {
    expect(MCP_PATH).toBe("/api/mcp");
    expect(MCP_RESOURCE_METADATA_PATH).toBe("/.well-known/oauth-protected-resource/api/mcp");
  });
});

describe("buildMcpProtectedResourceMetadata", () => {
  it("advertises the resource, the issuer, and what we actually accept", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    expect(
      buildMcpProtectedResourceMetadata(request("https://www.newcoworker.com/.well-known/x"))
    ).toEqual({
      resource: "https://www.newcoworker.com/api/mcp",
      authorization_servers: ["https://proj.supabase.co/auth/v1"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email"]
    });
  });
});

describe("the two metadata routes", () => {
  /**
   * The regression this file exists for. `protectedResourceHandler`'s default
   * derives `resource` by stripping `/.well-known/<segment>` off the request
   * path, so the bare route advertised the whole site as the protected
   * resource while its twin advertised /api/mcp. Two documents disagreeing
   * about what the resource IS is unnoticeable until something validates it,
   * and RFC 8707 is exactly that something.
   */
  it("agree on the resource, whichever one a client finds", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const bare = await bareMetadataGet(
      request("https://www.newcoworker.com/.well-known/oauth-protected-resource")
    ).json();
    const twin = await twinMetadataGet(
      request("https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp")
    ).json();

    expect(bare).toEqual(twin);
    expect(bare.resource).toBe("https://www.newcoworker.com/api/mcp");
    // Specifically NOT the bare origin, which is what shipped before.
    expect(bare.resource).not.toBe("https://www.newcoworker.com");
  });

  it("stay readable cross-origin, since clients fetch them from a browser", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const res = bareMetadataGet(request("https://www.newcoworker.com/.well-known/x"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("the ChatGPT endpoint's metadata", () => {
  it("names its own endpoint, not the Claude one", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const body = await chatgptMetadataGet(
      request("https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp/chatgpt")
    ).json();
    // ChatGPT echoes this back as RFC 8707's `resource`, so a document naming
    // the wrong endpoint is the exact mismatch audience validation rejects.
    expect(body.resource).toBe("https://www.newcoworker.com/api/mcp/chatgpt");
    expect(body.authorization_servers).toEqual(["https://proj.supabase.co/auth/v1"]);
  });

  it("differs from the Claude document in the resource and nothing else", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const req = request("https://www.newcoworker.com/.well-known/x");
    const chatgpt = await chatgptMetadataGet(req).json();
    const claude = await bareMetadataGet(req).json();
    expect({ ...chatgpt, resource: null }).toEqual({ ...claude, resource: null });
    expect(chatgpt.resource).not.toBe(claude.resource);
  });
});

describe("the 401 challenge the live route sends", () => {
  /**
   * Asserted against the REAL route module, because the pointer is the whole
   * discovery chain: a client with no token reads this header and nothing
   * else to find out where to authenticate. Pointing it at the bare metadata
   * document is what advertised the entire site as the protected resource.
   */
  it("points the ChatGPT route at the ChatGPT metadata document", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const { POST } = await import("@/app/api/mcp/chatgpt/route");
    const res = await POST(
      new Request("https://www.newcoworker.com/api/mcp/chatgpt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain(
      'resource_metadata="https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp/chatgpt"'
    );
  });

  it("points an unauthenticated client at the path-inserted metadata", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ISSUER;
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request("https://www.newcoworker.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );

    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      'resource_metadata="https://www.newcoworker.com/.well-known/oauth-protected-resource/api/mcp"'
    );
    // The bare location must not be what the challenge advertises.
    expect(challenge).not.toContain(
      'resource_metadata="https://www.newcoworker.com/.well-known/oauth-protected-resource"'
    );
  });
});
