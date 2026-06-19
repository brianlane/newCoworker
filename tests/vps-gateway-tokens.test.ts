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
  issueGatewayToken
} from "@/lib/db/vps-gateway-tokens";

type Handlers = {
  maybeSingle?: { data: unknown; error: unknown };
  insert?: { error: unknown };
  update?: { error: unknown };
};

/** Chainable Supabase query-builder mock covering select/eq/is/order/limit/maybeSingle/update/insert. */
function makeClient(handlers: Handlers) {
  const insertSpy = vi.fn(async () => handlers.insert ?? { error: null });
  const updateTerminal = vi.fn(async () => handlers.update ?? { error: null });
  const updateBuilder = {
    eq: vi.fn(() => updateBuilder),
    is: updateTerminal
  };
  const selectBuilder: Record<string, unknown> = {
    select: vi.fn(() => selectBuilder),
    eq: vi.fn(() => selectBuilder),
    is: vi.fn(() => selectBuilder),
    order: vi.fn(() => selectBuilder),
    limit: vi.fn(() => selectBuilder),
    maybeSingle: vi.fn(async () => handlers.maybeSingle ?? { data: null, error: null }),
    update: vi.fn(() => updateBuilder),
    insert: insertSpy
  };
  const from = vi.fn(() => selectBuilder);
  return { client: { from }, from, insertSpy, updateTerminal };
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

describe("issueGatewayToken", () => {
  it("revokes prior tokens and inserts a generated token with default null label", async () => {
    const { client, from, insertSpy, updateTerminal } = makeClient({});
    const token = await issueGatewayToken("biz-1", {}, client as never);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(from).toHaveBeenCalledWith("vps_gateway_tokens");
    expect(updateTerminal).toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: "biz-1", token, label: null })
    );
  });

  it("uses a provided token + label and can skip revocation", async () => {
    const { client, insertSpy, updateTerminal } = makeClient({});
    const token = await issueGatewayToken(
      "biz-1",
      { token: "preset", label: "seed", revokeExisting: false },
      client as never
    );
    expect(token).toBe("preset");
    expect(updateTerminal).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ token: "preset", label: "seed" })
    );
  });

  it("refuses to store the shared ROWBOAT_GATEWAY_TOKEN as a per-tenant token", async () => {
    const prev = process.env.ROWBOAT_GATEWAY_TOKEN;
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-secret";
    const { client, insertSpy } = makeClient({});
    await expect(
      issueGatewayToken("biz", { token: "shared-secret", revokeExisting: false }, client as never)
    ).rejects.toThrow(/refusing to store the shared/);
    expect(insertSpy).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
    else process.env.ROWBOAT_GATEWAY_TOKEN = prev;
  });

  it("allows a unique token even when the shared token env is set", async () => {
    const prev = process.env.ROWBOAT_GATEWAY_TOKEN;
    process.env.ROWBOAT_GATEWAY_TOKEN = "shared-secret";
    const { client, insertSpy } = makeClient({});
    const token = await issueGatewayToken(
      "biz",
      { token: "unique-x", revokeExisting: false },
      client as never
    );
    expect(token).toBe("unique-x");
    expect(insertSpy).toHaveBeenCalled();
    if (prev === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
    else process.env.ROWBOAT_GATEWAY_TOKEN = prev;
  });

  it("throws when revoke fails", async () => {
    const { client } = makeClient({ update: { error: { message: "revoke-fail" } } });
    await expect(issueGatewayToken("biz", {}, client as never)).rejects.toThrow(/revoke-fail/);
  });

  it("throws when insert fails", async () => {
    const { client } = makeClient({ insert: { error: { message: "insert-fail" } } });
    await expect(issueGatewayToken("biz", { revokeExisting: false }, client as never)).rejects.toThrow(
      /insert-fail/
    );
  });

  it("falls back to the service client when none is passed", async () => {
    const { client, insertSpy } = makeClient({});
    serviceClientHolder.current = client;
    await issueGatewayToken("biz", { revokeExisting: false });
    expect(insertSpy).toHaveBeenCalled();
  });
});
