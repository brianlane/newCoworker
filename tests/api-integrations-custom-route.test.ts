import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/custom-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/custom-integrations")
  >("@/lib/db/custom-integrations");
  return {
    ...actual,
    listCustomIntegrations: vi.fn(),
    createCustomIntegration: vi.fn(),
    getCustomIntegrationById: vi.fn(),
    updateCustomIntegration: vi.fn(),
    deleteCustomIntegration: vi.fn()
  };
});

import { GET, POST } from "@/app/api/integrations/custom/route";
import {
  DELETE,
  GET as GET_BY_ID,
  PATCH
} from "@/app/api/integrations/custom/[id]/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  CustomIntegrationValidationError,
  createCustomIntegration,
  deleteCustomIntegration,
  getCustomIntegrationById,
  listCustomIntegrations,
  updateCustomIntegration
} from "@/lib/db/custom-integrations";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const OWNER = { userId: "u-1", email: "o@example.com", isAdmin: false };
const ADMIN = { userId: "u-2", email: "admin@example.com", isAdmin: true };

const PUBLIC_ROW = {
  id: ID,
  business_id: BIZ,
  label: "Acme",
  base_url: "https://api.acme.com/v2",
  auth_scheme: "bearer" as const,
  header_name: null,
  description: null,
  is_active: true,
  has_secret: true,
  created_at: "2026-05-08T00:00:00Z",
  updated_at: "2026-05-08T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
  vi.mocked(listCustomIntegrations).mockResolvedValue([PUBLIC_ROW]);
  vi.mocked(createCustomIntegration).mockResolvedValue(PUBLIC_ROW);
  vi.mocked(getCustomIntegrationById).mockResolvedValue(PUBLIC_ROW);
  vi.mocked(updateCustomIntegration).mockResolvedValue(PUBLIC_ROW);
  vi.mocked(deleteCustomIntegration).mockResolvedValue();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("api/integrations/custom GET (list)", () => {
  it("lists for the owner's business", async () => {
    const res = await GET(
      new Request(`http://localhost/api/integrations/custom?businessId=${BIZ}`)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("rejects unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(
      new Request(`http://localhost/api/integrations/custom?businessId=${BIZ}`)
    );
    expect(res.status).toBe(401);
  });

  it("rejects missing businessId", async () => {
    const res = await GET(new Request("http://localhost/api/integrations/custom"));
    expect(res.status).toBe(400);
  });

  it("admins skip owner check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
    await GET(
      new Request(`http://localhost/api/integrations/custom?businessId=${BIZ}`)
    );
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("does not leak secrets in response", async () => {
    const res = await GET(
      new Request(`http://localhost/api/integrations/custom?businessId=${BIZ}`)
    );
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty("secret");
    expect(body.data[0]).not.toHaveProperty("secret_encrypted");
    expect(body.data[0].has_secret).toBe(true);
  });

  it("returns 500 when listCustomIntegrations throws non-validation error", async () => {
    vi.mocked(listCustomIntegrations).mockRejectedValueOnce(
      new Error("listCustomIntegrations: db down")
    );
    const res = await GET(
      new Request(`http://localhost/api/integrations/custom?businessId=${BIZ}`)
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("api/integrations/custom POST (create)", () => {
  it("creates a row and returns 201", async () => {
    const res = await POST(
      new Request("http://localhost/api/integrations/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer",
          secret: "k"
        })
      })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(createCustomIntegration).toHaveBeenCalled();
  });

  it("returns 400 on validation error from db lib", async () => {
    vi.mocked(createCustomIntegration).mockRejectedValueOnce(
      new CustomIntegrationValidationError("base_url_private", "private host")
    );
    const res = await POST(
      new Request("http://localhost/api/integrations/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "X",
          baseUrl: "https://localhost/x",
          authScheme: "bearer",
          secret: "k"
        })
      })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps unique-violation to 409 CONFLICT", async () => {
    vi.mocked(createCustomIntegration).mockRejectedValueOnce(
      new Error("createCustomIntegration: duplicate key value violates unique constraint")
    );
    const res = await POST(
      new Request("http://localhost/api/integrations/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer",
          secret: "k"
        })
      })
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("rejects unauthenticated POST", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/integrations/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer",
          secret: "k"
        })
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid body (zod)", async () => {
    const res = await POST(
      new Request("http://localhost/api/integrations/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "not-a-uuid",
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("api/integrations/custom/[id] GET", () => {
  it("returns the row", async () => {
    const res = await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/${ID}?businessId=${BIZ}`
      ),
      ctx(ID)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.id).toBe(ID);
  });

  it("404s when missing", async () => {
    vi.mocked(getCustomIntegrationById).mockResolvedValueOnce(null);
    const res = await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/${ID}?businessId=${BIZ}`
      ),
      ctx(ID)
    );
    expect(res.status).toBe(404);
  });

  it("400s on invalid id", async () => {
    const res = await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/not-uuid?businessId=${BIZ}`
      ),
      ctx("not-uuid")
    );
    expect(res.status).toBe(400);
  });

  it("400s on missing businessId query", async () => {
    const res = await GET_BY_ID(
      new Request(`http://localhost/api/integrations/custom/${ID}`),
      ctx(ID)
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated GET-by-id", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/${ID}?businessId=${BIZ}`
      ),
      ctx(ID)
    );
    expect(res.status).toBe(401);
  });

  it("admin GET-by-id skips owner check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
    await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/${ID}?businessId=${BIZ}`
      ),
      ctx(ID)
    );
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("returns 500 when getCustomIntegrationById throws", async () => {
    vi.mocked(getCustomIntegrationById).mockRejectedValueOnce(
      new Error("getCustomIntegrationById: db died")
    );
    const res = await GET_BY_ID(
      new Request(
        `http://localhost/api/integrations/custom/${ID}?businessId=${BIZ}`
      ),
      ctx(ID)
    );
    expect(res.status).toBe(500);
  });
});

describe("api/integrations/custom/[id] PATCH", () => {
  it("updates and returns the row", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme v2",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(200);
    expect(updateCustomIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, label: "Acme v2" })
    );
  });

  it("maps validation error to 400", async () => {
    vi.mocked(updateCustomIntegration).mockRejectedValueOnce(
      new CustomIntegrationValidationError("label_too_long", "too long")
    );
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(401);
  });

  it("400s on invalid id", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/not-uuid`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx("not-uuid")
    );
    expect(res.status).toBe(400);
  });

  it("maps unique-violation to 409 CONFLICT", async () => {
    vi.mocked(updateCustomIntegration).mockRejectedValueOnce(
      new Error("updateCustomIntegration: duplicate key value violates unique constraint")
    );
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(409);
  });

  it("falls through to 500 on unexpected error", async () => {
    vi.mocked(updateCustomIntegration).mockRejectedValueOnce(
      new Error("updateCustomIntegration: random db crash")
    );
    const res = await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(500);
  });

  it("admin PATCH skips owner check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
    await PATCH(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer"
        })
      }),
      ctx(ID)
    );
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});

describe("api/integrations/custom/[id] DELETE", () => {
  it("deletes and returns ok", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ })
      }),
      ctx(ID)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.deleted).toBe(true);
    expect(deleteCustomIntegration).toHaveBeenCalledWith(BIZ, ID);
  });

  it("400s on invalid id", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/integrations/custom/not-uuid", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ })
      }),
      ctx("not-uuid")
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 when deleteCustomIntegration throws", async () => {
    vi.mocked(deleteCustomIntegration).mockRejectedValueOnce(
      new Error("deleteCustomIntegration: db error")
    );
    const res = await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ })
      }),
      ctx(ID)
    );
    expect(res.status).toBe(500);
  });

  it("400s on invalid body (missing businessId)", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }),
      ctx(ID)
    );
    expect(res.status).toBe(400);
  });

  it("400s when body is non-JSON (json() throws and falls through to {} → invalid)", async () => {
    // The route uses `request.json().catch(() => ({}))`; an empty object
    // then fails the businessId required check.
    const res = await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "not json at all"
      }),
      ctx(ID)
    );
    expect(res.status).toBe(400);
  });

  it("admin DELETE skips owner check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
    await DELETE(
      new Request(`http://localhost/api/integrations/custom/${ID}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ })
      }),
      ctx(ID)
    );
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});
