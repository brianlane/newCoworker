import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/api-keys")>();
  return {
    MAX_ACTIVE_API_KEYS_PER_BUSINESS: actual.MAX_ACTIVE_API_KEYS_PER_BUSINESS,
    countActiveApiKeys: vi.fn(),
    insertApiKey: vi.fn(),
    listApiKeys: vi.fn(),
    revokeApiKey: vi.fn()
  };
});

import { GET, POST } from "@/app/api/dashboard/api-keys/route";
import { DELETE } from "@/app/api/dashboard/api-keys/[id]/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  MAX_ACTIVE_API_KEYS_PER_BUSINESS,
  countActiveApiKeys,
  insertApiKey,
  listApiKeys,
  revokeApiKey
} from "@/lib/db/api-keys";
import { API_KEY_REGEX } from "@/lib/public-api/keys";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";

const OWNER = { userId: "u1", email: "o@o.com", isAdmin: false };

const KEY_ROW = {
  id: KEY_ID,
  business_id: BIZ,
  name: "Zapier",
  key_prefix: "nck_aaaaaaaa",
  created_at: "2026-07-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null
};

function getReq(businessId: string | null = BIZ): Request {
  const qs = businessId ? `?businessId=${businessId}` : "";
  return new Request(`http://localhost/api/dashboard/api-keys${qs}`);
}

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function deleteReq(id: string, body: unknown) {
  return [
    new Request(`http://localhost/api/dashboard/api-keys/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(listApiKeys).mockResolvedValue([KEY_ROW]);
  vi.mocked(countActiveApiKeys).mockResolvedValue(0);
  vi.mocked(insertApiKey).mockResolvedValue({ ...KEY_ROW, key_hash: "h".repeat(64) });
  vi.mocked(revokeApiKey).mockResolvedValue(true);
});

describe("GET /api/dashboard/api-keys", () => {
  it("401s when unauthenticated, 400s without businessId", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await GET(getReq())).status).toBe(401);

    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    expect((await GET(getReq(null))).status).toBe(400);
  });

  it("enforces ownership for non-admins and lists keys without hashes", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_billing");
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: KEY_ID,
        name: "Zapier",
        key_prefix: "nck_aaaaaaaa",
        created_at: "2026-07-01T00:00:00Z",
        last_used_at: null,
        revoked_at: null
      }
    ]);
  });

  it("skips requireBusinessRole for admins", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    await GET(getReq());
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/api-keys", () => {
  it("mints a key, stores only the hash, and returns the plaintext once", async () => {
    const res = await POST(postReq({ businessId: BIZ, name: "Zapier" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.plaintext).toMatch(API_KEY_REGEX);
    expect(body.data.key_prefix).toBe("nck_aaaaaaaa");

    const insertArgs = vi.mocked(insertApiKey).mock.calls[0][0];
    expect(insertArgs.businessId).toBe(BIZ);
    expect(insertArgs.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The stored hash must never equal the plaintext.
    expect(insertArgs.keyHash).not.toBe(body.data.plaintext);
  });

  it("409s at the active-key cap", async () => {
    vi.mocked(countActiveApiKeys).mockResolvedValue(MAX_ACTIVE_API_KEYS_PER_BUSINESS);
    const res = await POST(postReq({ businessId: BIZ, name: "Zapier" }));
    expect(res.status).toBe(409);
    expect(insertApiKey).not.toHaveBeenCalled();
  });

  it("409s when the DB cap trigger rejects a racing insert", async () => {
    // Pre-check passed (count below cap) but the api_keys_cap trigger fired —
    // a concurrent mint won the race.
    vi.mocked(insertApiKey).mockRejectedValue(
      new Error("insertApiKey: API key limit reached (10) for business biz-1")
    );
    const res = await POST(postReq({ businessId: BIZ, name: "Zapier" }));
    expect(res.status).toBe(409);
  });

  it("rethrows non-cap insert failures as 500", async () => {
    vi.mocked(insertApiKey).mockRejectedValue(new Error("insertApiKey: connection reset"));
    const res = await POST(postReq({ businessId: BIZ, name: "Zapier" }));
    expect(res.status).toBe(500);
  });

  it("401s unauthenticated and 400s on bad bodies", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await POST(postReq({ businessId: BIZ }))).status).toBe(401);

    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    expect((await POST(postReq({ businessId: "nope" }))).status).toBe(400);
    expect((await POST(postReq(null))).status).toBe(400);
  });
});

describe("DELETE /api/dashboard/api-keys/:id", () => {
  it("revokes business-scoped and 404s when nothing matched", async () => {
    const [request, ctx] = deleteReq(KEY_ID, { businessId: BIZ });
    const res = await DELETE(request, ctx);
    expect(res.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith(BIZ, KEY_ID);

    vi.mocked(revokeApiKey).mockResolvedValue(false);
    const [request2, ctx2] = deleteReq(KEY_ID, { businessId: BIZ });
    expect((await DELETE(request2, ctx2)).status).toBe(404);
  });

  it("401s unauthenticated, 400s on bad ids", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const [request, ctx] = deleteReq(KEY_ID, { businessId: BIZ });
    expect((await DELETE(request, ctx)).status).toBe(401);

    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    const [request2, ctx2] = deleteReq("not-a-uuid", { businessId: BIZ });
    expect((await DELETE(request2, ctx2)).status).toBe(400);
  });

  it("enforces ownership for non-admins", async () => {
    const [request, ctx] = deleteReq(KEY_ID, { businessId: BIZ });
    await DELETE(request, ctx);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_billing");
  });
});
