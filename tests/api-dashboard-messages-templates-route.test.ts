import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/plans/sms-tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/plans/sms-tools")>();
  return { ...original, smsToolsAllowedForBusiness: vi.fn() };
});

import { GET, POST } from "@/app/api/dashboard/messages/templates/route";
import {
  DELETE as DELETE_ONE,
  PATCH
} from "@/app/api/dashboard/messages/templates/[id]/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { smsToolsAllowedForBusiness } from "@/lib/plans/sms-tools";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const OWNER = { userId: "u1", email: "o@o.com", isAdmin: false };

type ChainResult = { data: unknown; error: { message: string; code?: string } | null };

/** Terminal-agnostic thenable query chain: every method returns the chain and
 * awaiting it (or .single()/.maybeSingle()) resolves the configured result. */
function makeChain(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (v: ChainResult) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function mockDb(results: Record<string, ChainResult>) {
  const from = vi.fn((table: string) =>
    makeChain(results[table] ?? { data: null, error: null })
  );
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return { from };
}

function postReq(body: unknown) {
  return new Request("http://localhost/api/dashboard/messages/templates", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function idReq(method: string, body: unknown) {
  return new Request(`http://localhost/api/dashboard/messages/templates/${TPL}`, {
    method,
    body: JSON.stringify(body)
  });
}

const idParams = { params: Promise.resolve({ id: TPL }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER);
  vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(true);
});

describe("GET /api/dashboard/messages/templates", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed businessId", async () => {
    const res = await GET(new Request("http://localhost/x?businessId=nope"));
    expect(res.status).toBe(400);
  });

  it("lists templates for the owner", async () => {
    mockDb({
      sms_templates: { data: [{ id: TPL, name: "Hours", body: "We open at 9." }], error: null }
    });
    const res = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.templates).toHaveLength(1);
    expect(requireOwner).toHaveBeenCalledWith(BIZ);
  });

  it("tolerates a null data payload and admin callers skip requireOwner", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true });
    mockDb({ sms_templates: { data: null, error: null } });
    const res = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    expect((await res.json()).data.templates).toEqual([]);
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("maps DB errors to 500", async () => {
    mockDb({ sms_templates: { data: null, error: { message: "db down" } } });
    const res = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/dashboard/messages/templates", () => {
  const body = { businessId: BIZ, name: "Hours", body: "We open at 9." };

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await POST(postReq(body))).status).toBe(401);
  });

  it("rejects invalid payloads (including non-JSON)", async () => {
    expect((await POST(postReq({ businessId: BIZ, name: "", body: "x" }))).status).toBe(400);
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(400);
  });

  it("gates on tier", async () => {
    vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(false);
    const res = await POST(postReq(body));
    expect(res.status).toBe(403);
  });

  it("creates a template", async () => {
    mockDb({ sms_templates: { data: { id: TPL, ...body }, error: null } });
    const res = await POST(postReq(body));
    expect(res.status).toBe(201);
    expect((await res.json()).data.template.id).toBe(TPL);
  });

  it("maps a unique violation to 409 and other DB errors to 500", async () => {
    mockDb({ sms_templates: { data: null, error: { message: "dup", code: "23505" } } });
    expect((await POST(postReq(body))).status).toBe(409);

    mockDb({ sms_templates: { data: null, error: { message: "db down" } } });
    expect((await POST(postReq(body))).status).toBe(500);
  });
});

describe("PATCH /api/dashboard/messages/templates/:id", () => {
  const body = { businessId: BIZ, name: "New name" };

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await PATCH(idReq("PATCH", body), idParams)).status).toBe(401);
  });

  it("rejects a malformed template id", async () => {
    const res = await PATCH(idReq("PATCH", body), {
      params: Promise.resolve({ id: "nope" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects an update with neither name nor body", async () => {
    const res = await PATCH(idReq("PATCH", { businessId: BIZ }), idParams);
    expect(res.status).toBe(400);
  });

  it("gates on tier", async () => {
    vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(false);
    expect((await PATCH(idReq("PATCH", body), idParams)).status).toBe(403);
  });

  it("updates name and/or body", async () => {
    const { from } = mockDb({
      sms_templates: { data: { id: TPL, name: "New name", body: "b" }, error: null }
    });
    const res = await PATCH(
      idReq("PATCH", { businessId: BIZ, name: "New name", body: "b" }),
      idParams
    );
    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledWith("sms_templates");
  });

  it("404s on a missing row, 409s on duplicate names, 500s on DB errors", async () => {
    mockDb({ sms_templates: { data: null, error: null } });
    expect((await PATCH(idReq("PATCH", body), idParams)).status).toBe(404);

    mockDb({ sms_templates: { data: null, error: { message: "dup", code: "23505" } } });
    expect((await PATCH(idReq("PATCH", body), idParams)).status).toBe(409);

    mockDb({ sms_templates: { data: null, error: { message: "db down" } } });
    expect((await PATCH(idReq("PATCH", body), idParams)).status).toBe(500);
  });
});

describe("DELETE /api/dashboard/messages/templates/:id", () => {
  const body = { businessId: BIZ };

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await DELETE_ONE(idReq("DELETE", body), idParams)).status).toBe(401);
  });

  it("rejects a malformed template id", async () => {
    const res = await DELETE_ONE(idReq("DELETE", body), {
      params: Promise.resolve({ id: "nope" })
    });
    expect(res.status).toBe(400);
  });

  it("gates on tier", async () => {
    vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(false);
    mockDb({ sms_templates: { data: { id: TPL }, error: null } });
    expect((await DELETE_ONE(idReq("DELETE", body), idParams)).status).toBe(403);
  });

  it("deletes the template", async () => {
    mockDb({ sms_templates: { data: { id: TPL }, error: null } });
    const res = await DELETE_ONE(idReq("DELETE", body), idParams);
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(true);
  });

  it("404s on a missing row and 500s on DB errors", async () => {
    mockDb({ sms_templates: { data: null, error: null } });
    expect((await DELETE_ONE(idReq("DELETE", body), idParams)).status).toBe(404);

    mockDb({ sms_templates: { data: null, error: { message: "db down" } } });
    expect((await DELETE_ONE(idReq("DELETE", body), idParams)).status).toBe(500);
  });
});
