/**
 * Unit tests for the edge workers' per-tenant Rowboat bearer resolution
 * (supabase/functions/_shared/gateway_token.ts) — the fix for the June 19
 * incident where a re-keyed VPS rejected the stale shared env token and every
 * customer SMS dead-lettered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveRowboatBearerForBusiness } from "../supabase/functions/_shared/gateway_token";

const BIZ = "11111111-1111-1111-1111-111111111111";

type StubResult = { data: unknown; error: { message: string } | null };

/** Chainable stub matching the query the resolver issues. */
function stubClient(result: StubResult | (() => StubResult), calls: Record<string, unknown[]> = {}) {
  const resolve = () => (typeof result === "function" ? result() : result);
  const chain = {
    select: (cols: string) => {
      calls.select = [cols];
      return chain;
    },
    eq: (col: string, val: string) => {
      calls.eq = [col, val];
      return chain;
    },
    is: (col: string, val: null) => {
      calls.is = [col, val];
      return chain;
    },
    not: (col: string, op: string, val: null) => {
      calls.not = [col, op, val];
      return chain;
    },
    order: (col: string, opts: { ascending: boolean }) => {
      calls.order = [col, opts];
      return chain;
    },
    limit: (n: number) => {
      calls.limit = [n];
      return chain;
    },
    maybeSingle: async () => resolve()
  };
  return {
    from: (table: string) => {
      calls.from = [table];
      return chain;
    }
  };
}

afterEach(() => {
  delete process.env.ROWBOAT_VPS_CHAT_BEARER;
  delete process.env.ROWBOAT_GATEWAY_TOKEN;
});

describe("resolveRowboatBearerForBusiness", () => {
  it("prefers the confirmed per-tenant token over the env fallback", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-legacy";
    const calls: Record<string, unknown[]> = {};
    const db = stubClient({ data: { token: "per-tenant-tok" }, error: null }, calls);
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("per-tenant-tok");
    // Must only consider CONFIRMED (deployed_at set), non-revoked tokens.
    expect(calls.from).toEqual(["vps_gateway_tokens"]);
    expect(calls.eq).toEqual(["business_id", BIZ]);
    expect(calls.is).toEqual(["revoked_at", null]);
    expect(calls.not).toEqual(["deployed_at", "is", null]);
  });

  it("falls back to the shared env token when no confirmed token exists", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-legacy";
    const db = stubClient({ data: null, error: null });
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("shared-legacy");
  });

  it("prefers ROWBOAT_VPS_CHAT_BEARER over ROWBOAT_GATEWAY_TOKEN in the fallback", async () => {
    process.env.ROWBOAT_VPS_CHAT_BEARER = "vps-chat-bearer";
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-legacy";
    const db = stubClient({ data: null, error: null });
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("vps-chat-bearer");
  });

  it("fails over to the env token on a query error (never throws)", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-legacy";
    const db = stubClient({ data: null, error: { message: "boom" } });
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("shared-legacy");
  });

  it("fails over to the env token when the query throws", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-legacy";
    const db = stubClient(() => {
      throw new Error("network down");
    });
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("shared-legacy");
  });

  it("returns empty string when there is no token anywhere", async () => {
    const db = stubClient({ data: null, error: null });
    await expect(resolveRowboatBearerForBusiness(db, BIZ)).resolves.toBe("");
  });
});
