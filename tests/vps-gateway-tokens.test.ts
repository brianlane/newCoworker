import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The default-client branch (`client ?? await createSupabaseServiceClient()`)
// is covered by NOT passing a client; this mock supplies the fake client.
const { serviceClientHolder } = vi.hoisted(() => ({
  serviceClientHolder: { current: null as unknown }
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => serviceClientHolder.current)
}));

import {
  gatewayTokenSha256,
  generateGatewayToken,
  resolveGatewayTokenBinding,
  getActiveGatewayTokenForBusiness,
  getDeployedGatewayTokenForBusiness,
  getActiveGatewayTokensForProject,
  issueGatewayToken,
  markGatewayTokenDeployed
} from "@/lib/db/vps-gateway-tokens";

type Handlers = {
  /** Result for `.maybeSingle()` terminals (single-row reads). */
  maybeSingle?: { data: unknown; error: unknown };
  /** Result when a select chain is awaited directly (multi-row reads). */
  list?: { data: unknown; error: unknown };
  insert?: { error: unknown };
  /** Result of `client.rpc(...)`. */
  rpc?: { error: unknown };
};

/**
 * Chainable Supabase query-builder mock covering select/eq/is/not/order/limit and
 * both terminals: `.maybeSingle()` (single row) and awaiting the builder directly
 * (multi-row list). Also exposes `insert` and a client-level `rpc`.
 */
function makeClient(handlers: Handlers) {
  const insertSpy = vi.fn(async () => handlers.insert ?? { error: null });
  const rpcSpy = vi.fn(async () => handlers.rpc ?? { error: null });
  const selectBuilder: Record<string, unknown> = {
    select: vi.fn(() => selectBuilder),
    eq: vi.fn(() => selectBuilder),
    is: vi.fn(() => selectBuilder),
    not: vi.fn(() => selectBuilder),
    order: vi.fn(() => selectBuilder),
    limit: vi.fn(() => selectBuilder),
    maybeSingle: vi.fn(async () => handlers.maybeSingle ?? { data: null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(handlers.list ?? { data: [], error: null }).then(resolve, reject),
    insert: insertSpy
  };
  const from = vi.fn(() => selectBuilder);
  return { client: { from, rpc: rpcSpy }, from, insertSpy, rpcSpy };
}

beforeEach(() => {
  serviceClientHolder.current = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("gatewayTokenSha256 / generateGatewayToken", () => {
  it("hashes deterministically to lowercase hex", () => {
    expect(gatewayTokenSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(gatewayTokenSha256("abc")).toBe(gatewayTokenSha256("abc"));
  });

  it("generates distinct, url-safe tokens", () => {
    const a = generateGatewayToken();
    const b = generateGatewayToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("resolveGatewayTokenBinding", () => {
  it("returns null for an empty token without touching the DB", async () => {
    expect(await resolveGatewayTokenBinding("   ")).toBeNull();
  });

  it("returns the binding when a row matches (explicit client)", async () => {
    const { client } = makeClient({
      maybeSingle: { data: { business_id: "biz-1", token: "tok-1" }, error: null }
    });
    expect(await resolveGatewayTokenBinding("tok-1", client as never)).toEqual({
      businessId: "biz-1",
      token: "tok-1"
    });
  });

  it("returns null when no row matches", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null } });
    expect(await resolveGatewayTokenBinding("nope", client as never)).toBeNull();
  });

  it("throws on a DB error", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: { message: "boom" } } });
    await expect(resolveGatewayTokenBinding("x", client as never)).rejects.toThrow(/boom/);
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeClient({
      maybeSingle: { data: { business_id: "biz-2", token: "tok-2" }, error: null }
    });
    serviceClientHolder.current = client;
    expect(await resolveGatewayTokenBinding("tok-2")).toEqual({
      businessId: "biz-2",
      token: "tok-2"
    });
  });
});

describe("getActiveGatewayTokenForBusiness", () => {
  it("returns the token when present", async () => {
    const { client } = makeClient({ maybeSingle: { data: { token: "tok-9" }, error: null } });
    expect(await getActiveGatewayTokenForBusiness("biz", client as never)).toBe("tok-9");
  });

  it("returns null when absent", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null } });
    expect(await getActiveGatewayTokenForBusiness("biz", client as never)).toBeNull();
  });

  it("throws on a DB error", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: { message: "db-down" } } });
    await expect(getActiveGatewayTokenForBusiness("biz", client as never)).rejects.toThrow(/db-down/);
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeClient({ maybeSingle: { data: { token: "svc-tok" }, error: null } });
    serviceClientHolder.current = client;
    expect(await getActiveGatewayTokenForBusiness("biz")).toBe("svc-tok");
  });
});

describe("getDeployedGatewayTokenForBusiness", () => {
  it("returns the confirmed token when present", async () => {
    const { client } = makeClient({ maybeSingle: { data: { token: "dep-1" }, error: null } });
    expect(await getDeployedGatewayTokenForBusiness("biz", client as never)).toBe("dep-1");
  });

  it("returns null when no confirmed token exists", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null } });
    expect(await getDeployedGatewayTokenForBusiness("biz", client as never)).toBeNull();
  });

  it("throws on a DB error", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: { message: "boom-dep" } } });
    await expect(getDeployedGatewayTokenForBusiness("biz", client as never)).rejects.toThrow(/boom-dep/);
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeClient({ maybeSingle: { data: { token: "svc-dep" }, error: null } });
    serviceClientHolder.current = client;
    expect(await getDeployedGatewayTokenForBusiness("biz")).toBe("svc-dep");
  });
});

describe("issueGatewayToken", () => {
  it("inserts a generated PENDING token with default null label (no revoke)", async () => {
    const { client, from, insertSpy } = makeClient({});
    const token = await issueGatewayToken("biz-1", {}, client as never);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(from).toHaveBeenCalledWith("vps_gateway_tokens");
    // Insert-only: the inserted row is pending (deployed_at unset) and no
    // revoked_at is written here.
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: "biz-1", token, label: null })
    );
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("uses a provided token + label", async () => {
    const { client, insertSpy } = makeClient({});
    const token = await issueGatewayToken(
      "biz-1",
      { token: "preset", label: "seed" },
      client as never
    );
    expect(token).toBe("preset");
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ token: "preset", label: "seed" })
    );
  });

  it("refuses to store the shared ROWBOAT_GATEWAY_TOKEN as a per-tenant token", async () => {
    const prev = process.env.ROWBOAT_GATEWAY_TOKEN;
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-secret";
    const { client, insertSpy } = makeClient({});
    await expect(
      issueGatewayToken("biz", { token: "shared-secret" }, client as never)
    ).rejects.toThrow(/refusing to store the shared/);
    expect(insertSpy).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
    else process.env.ROWBOAT_GATEWAY_TOKEN = prev;
  });

  it("allows a unique token even when the shared token env is set", async () => {
    const prev = process.env.ROWBOAT_GATEWAY_TOKEN;
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-secret";
    const { client, insertSpy } = makeClient({});
    const token = await issueGatewayToken("biz", { token: "unique-x" }, client as never);
    expect(token).toBe("unique-x");
    expect(insertSpy).toHaveBeenCalled();
    if (prev === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
    else process.env.ROWBOAT_GATEWAY_TOKEN = prev;
  });

  it("throws when insert fails", async () => {
    const { client } = makeClient({ insert: { error: { message: "insert-fail" } } });
    await expect(issueGatewayToken("biz", {}, client as never)).rejects.toThrow(/insert-fail/);
  });

  it("falls back to the service client when none is passed", async () => {
    const { client, insertSpy } = makeClient({});
    serviceClientHolder.current = client;
    await issueGatewayToken("biz");
    expect(insertSpy).toHaveBeenCalled();
  });
});

describe("getActiveGatewayTokensForProject", () => {
  it("resolves the business via business_configs then returns its non-revoked tokens", async () => {
    const { client } = makeClient({
      maybeSingle: { data: { business_id: "biz-cfg" }, error: null },
      list: { data: [{ token: "t1" }, { token: "t2" }], error: null }
    });
    expect(await getActiveGatewayTokensForProject("proj-1", client as never)).toEqual(["t1", "t2"]);
  });

  it("falls back to treating projectId as the business id when no config matches", async () => {
    const { client } = makeClient({
      maybeSingle: { data: null, error: null },
      list: { data: [{ token: "only" }], error: null }
    });
    expect(await getActiveGatewayTokensForProject("biz-as-proj", client as never)).toEqual(["only"]);
  });

  it("returns an empty array when the business has no tokens", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null }, list: { data: [], error: null } });
    expect(await getActiveGatewayTokensForProject("p", client as never)).toEqual([]);
  });

  it("returns an empty array when the tokens query yields null data", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null }, list: { data: null, error: null } });
    expect(await getActiveGatewayTokensForProject("p", client as never)).toEqual([]);
  });

  it("throws when the config lookup errors", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: { message: "cfg-boom" } } });
    await expect(getActiveGatewayTokensForProject("p", client as never)).rejects.toThrow(/cfg-boom/);
  });

  it("throws when the tokens lookup errors", async () => {
    const { client } = makeClient({
      maybeSingle: { data: null, error: null },
      list: { data: null, error: { message: "tok-boom" } }
    });
    await expect(getActiveGatewayTokensForProject("p", client as never)).rejects.toThrow(/tok-boom/);
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeClient({
      maybeSingle: { data: null, error: null },
      list: { data: [{ token: "svc" }], error: null }
    });
    serviceClientHolder.current = client;
    expect(await getActiveGatewayTokensForProject("p")).toEqual(["svc"]);
  });
});

describe("markGatewayTokenDeployed", () => {
  it("calls the confirm_gateway_token RPC with the business id and token", async () => {
    const { client, rpcSpy } = makeClient({ rpc: { error: null } });
    await markGatewayTokenDeployed("biz-1", "tok-new", client as never);
    expect(rpcSpy).toHaveBeenCalledWith("confirm_gateway_token", {
      p_business_id: "biz-1",
      p_token: "tok-new"
    });
  });

  it("throws when the RPC errors", async () => {
    const { client } = makeClient({ rpc: { error: { message: "rpc-boom" } } });
    await expect(markGatewayTokenDeployed("biz-1", "tok-new", client as never)).rejects.toThrow(
      /markGatewayTokenDeployed: rpc-boom/
    );
  });

  it("falls back to the service client when none is passed", async () => {
    const { client, rpcSpy } = makeClient({ rpc: { error: null } });
    serviceClientHolder.current = client;
    await markGatewayTokenDeployed("biz-1", "tok-new");
    expect(rpcSpy).toHaveBeenCalled();
  });
});
