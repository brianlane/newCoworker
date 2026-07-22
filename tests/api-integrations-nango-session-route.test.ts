import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

const mockCreateConnectSession = vi.fn();
vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({ createConnectSession: mockCreateConnectSession })
}));

vi.mock("@/lib/nango/connection-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nango/connection-cap")>();
  return {
    ...actual,
    assertWorkspaceConnectionAllowed: vi.fn()
  };
});

import { POST } from "@/app/api/integrations/nango/session/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  WorkspaceConnectionCapError,
  assertWorkspaceConnectionAllowed
} from "@/lib/nango/connection-cap";

const businessId = "11111111-1111-4111-8111-111111111111";

function makeRequest() {
  return new Request("http://localhost/api/integrations/nango/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId })
  });
}

describe("api/integrations/nango/session", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, NANGO_SECRET_KEY: "nango-secret" };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(assertWorkspaceConnectionAllowed).mockResolvedValue(undefined);
    mockCreateConnectSession.mockResolvedValue({ data: { token: "tok-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 503 when NANGO_SECRET_KEY is missing", async () => {
    delete process.env.NANGO_SECRET_KEY;
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
  });

  it("refuses with 403 + the owner-facing cap message when the tier cap is reached", async () => {
    vi.mocked(assertWorkspaceConnectionAllowed).mockRejectedValue(
      new WorkspaceConnectionCapError({ used: 3, max: 3, atCap: true })
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Your plan includes 3 workspace connections");
    // The gate fires BEFORE a connect session is minted.
    expect(mockCreateConnectSession).not.toHaveBeenCalled();
  });

  it("mints a connect session below the cap", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string } };
    expect(body.data.token).toBe("tok-1");
    expect(assertWorkspaceConnectionAllowed).toHaveBeenCalledWith(businessId);
    expect(mockCreateConnectSession).toHaveBeenCalledWith({
      end_user: {
        id: businessId,
        email: "owner@example.com",
        display_name: "owner@example.com"
      }
    });
  });

  it("accepts the flat legacy token shape and 500s on an unexpected one", async () => {
    mockCreateConnectSession.mockResolvedValue({ token: "flat-tok" });
    const flat = await POST(makeRequest());
    expect(flat.status).toBe(200);

    mockCreateConnectSession.mockResolvedValue({ nope: true });
    const bad = await POST(makeRequest());
    expect(bad.status).toBe(500);
  });
});
