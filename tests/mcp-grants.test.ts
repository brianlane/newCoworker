/**
 * src/lib/mcp/grants.ts, matching and revoking the caller's OAuth grant
 * behind the Disconnect button on the connector card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantMatchesClient, revokeMcpGrantsForClient } from "@/lib/mcp/grants";

type Grant = { client: { id: string; name?: string | null; uri?: string | null } };

function makeClient(
  grants: Grant[],
  opts: {
    listError?: { message: string } | null;
    revokeErrorFor?: string[];
    throwOnList?: boolean;
  } = {}
) {
  const revokeGrant = vi.fn(async ({ clientId }: { clientId: string }) => ({
    error: (opts.revokeErrorFor ?? []).includes(clientId) ? { message: "revoke failed" } : null
  }));
  const listGrants = vi.fn(async () => {
    if (opts.throwOnList) throw new Error("network down");
    return { data: opts.listError ? null : grants, error: opts.listError ?? null };
  });
  return { supabase: { auth: { oauth: { listGrants, revokeGrant } } }, listGrants, revokeGrant };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("grantMatchesClient", () => {
  it("matches Claude on name or URI", () => {
    expect(grantMatchesClient({ id: "1", name: "Claude" }, "claude")).toBe(true);
    expect(grantMatchesClient({ id: "1", name: "Claude Desktop" }, "claude")).toBe(true);
    expect(grantMatchesClient({ id: "1", uri: "https://claude.ai" }, "claude")).toBe(true);
    expect(grantMatchesClient({ id: "1", uri: "https://www.anthropic.com" }, "claude")).toBe(true);
  });

  it("matches ChatGPT on name or URI, spaced or not", () => {
    expect(grantMatchesClient({ id: "1", name: "ChatGPT" }, "chatgpt")).toBe(true);
    expect(grantMatchesClient({ id: "1", name: "Chat GPT" }, "chatgpt")).toBe(true);
    expect(grantMatchesClient({ id: "1", uri: "https://chatgpt.com" }, "chatgpt")).toBe(true);
    expect(grantMatchesClient({ id: "1", uri: "https://openai.com" }, "chatgpt")).toBe(true);
  });

  /**
   * Revoking the wrong grant would silently break an integration the tenant
   * still wants, so an unrecognised client is left alone rather than guessed
   * at. "Claudette" is the shape of near-miss that a bare substring match
   * would have swallowed.
   */
  it("does not match the other assistant, an unrelated client, or an empty one", () => {
    expect(grantMatchesClient({ id: "1", name: "ChatGPT" }, "claude")).toBe(false);
    expect(grantMatchesClient({ id: "1", name: "Claude" }, "chatgpt")).toBe(false);
    expect(grantMatchesClient({ id: "1", name: "Claudette CRM" }, "claude")).toBe(false);
    expect(grantMatchesClient({ id: "1", name: "Zapier", uri: "https://zapier.com" }, "claude")).toBe(
      false
    );
    expect(grantMatchesClient({ id: "1", name: "", uri: "" }, "claude")).toBe(false);
    expect(grantMatchesClient({ id: "1" }, "chatgpt")).toBe(false);
  });
});

describe("revokeMcpGrantsForClient", () => {
  it("revokes every matching grant and leaves the rest alone", async () => {
    const { supabase, revokeGrant } = makeClient([
      { client: { id: "g-claude", name: "Claude" } },
      { client: { id: "g-chatgpt", name: "ChatGPT" } },
      { client: { id: "g-other", name: "Zapier", uri: "https://zapier.com" } }
    ]);
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 1,
      skippedReason: null
    });
    expect(revokeGrant).toHaveBeenCalledTimes(1);
    expect(revokeGrant).toHaveBeenCalledWith({ clientId: "g-claude" });
  });

  it("revokes several grants for the same assistant", async () => {
    const { supabase } = makeClient([
      { client: { id: "g1", name: "Claude" } },
      { client: { id: "g2", uri: "https://claude.ai" } }
    ]);
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 2,
      skippedReason: null
    });
  });

  /**
   * The common honest case: a teammate connected it, or an admin is using
   * view-as. There is nothing of the caller's to revoke, and the route says
   * so instead of implying the assistant lost access.
   */
  it("reports no_matching_grant when the caller has none", async () => {
    const { supabase, revokeGrant } = makeClient([{ client: { id: "g-other", name: "Zapier" } }]);
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 0,
      skippedReason: "no_matching_grant"
    });
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it("reports no_matching_grant when Auth returns no grants at all", async () => {
    const { supabase } = makeClient([]);
    expect(await revokeMcpGrantsForClient(supabase, "chatgpt")).toEqual({
      revoked: 0,
      skippedReason: "no_matching_grant"
    });
  });

  it("reports revoke_failed when listing fails", async () => {
    const { supabase } = makeClient([], { listError: { message: "auth down" } });
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 0,
      skippedReason: "revoke_failed"
    });
  });

  it("reports revoke_failed when every revoke fails", async () => {
    const { supabase } = makeClient([{ client: { id: "g1", name: "Claude" } }], {
      revokeErrorFor: ["g1"]
    });
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 0,
      skippedReason: "revoke_failed"
    });
  });

  it("counts a partial success as revoked (running Disconnect again retries the rest)", async () => {
    const { supabase } = makeClient(
      [
        { client: { id: "g1", name: "Claude" } },
        { client: { id: "g2", uri: "https://claude.ai" } }
      ],
      { revokeErrorFor: ["g2"] }
    );
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 1,
      skippedReason: null
    });
  });

  it("swallows a thrown Auth call rather than failing the disconnect", async () => {
    const { supabase } = makeClient([], { throwOnList: true });
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 0,
      skippedReason: "revoke_failed"
    });
  });

  it("treats a null grant list as nothing to revoke", async () => {
    const supabase = {
      auth: {
        oauth: {
          listGrants: vi.fn(async () => ({ data: null, error: null })),
          revokeGrant: vi.fn(async () => ({ error: null }))
        }
      }
    };
    expect(await revokeMcpGrantsForClient(supabase, "claude")).toEqual({
      revoked: 0,
      skippedReason: "no_matching_grant"
    });
  });
});
