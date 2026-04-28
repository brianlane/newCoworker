import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  findAuthUserIdByEmail: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { POST } from "@/app/api/onboard/set-password/route";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const VALID_PASSWORD = "Hunter2-strong";
const VALID_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const VALID_EMAIL = "paid@example.com";

type FakeAdmin = {
  createUser: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
};

function fakeServiceClient(admin: Partial<FakeAdmin> = {}) {
  const defaults: FakeAdmin = {
    createUser: vi.fn(),
    updateUserById: vi.fn().mockResolvedValue({ error: null })
  };
  const merged: FakeAdmin = { ...defaults, ...admin };
  return {
    client: { auth: { admin: merged } } as never,
    admin: merged
  };
}

function mockStripeSession(overrides: Record<string, unknown> = {}) {
  vi.mocked(getStripe).mockReturnValue({
    checkout: {
      sessions: {
        retrieve: vi.fn().mockResolvedValue({
          status: "complete",
          payment_status: "paid",
          metadata: { businessId: VALID_BUSINESS_ID },
          customer_details: { email: VALID_EMAIL },
          ...overrides
        })
      }
    }
  } as never);
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/onboard/set-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/onboard/set-password route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeSession();
  });

  it("creates a new auth user with email_confirm=true when one does not exist", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    const { client, admin } = fakeServiceClient({
      createUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-new" } }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_new", password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ ownerEmail: VALID_EMAIL, businessId: VALID_BUSINESS_ID });
    expect(admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        email_confirm: true
      })
    );
    expect(admin.updateUserById).toHaveBeenCalledWith(
      "user-new",
      expect.objectContaining({ password: VALID_PASSWORD, email_confirm: true })
    );
  });

  it("updates the password on an existing auth user without re-creating", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("user-existing");
    const { client, admin } = fakeServiceClient();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_existing", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(200);
    expect(admin.createUser).not.toHaveBeenCalled();
    expect(admin.updateUserById).toHaveBeenCalledWith(
      "user-existing",
      expect.objectContaining({ password: VALID_PASSWORD, email_confirm: true })
    );
  });

  it("recovers from a race when admin.createUser fails because a parallel caller already minted the user", async () => {
    // First lookup misses (we proceed to create), createUser fails (e.g.
    // duplicate-email), second lookup hits (the parallel caller won the
    // race). The route MUST fall through to update rather than 500ing.
    vi.mocked(findAuthUserIdByEmail)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("user-raced-in");
    const { client, admin } = fakeServiceClient({
      createUser: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "User already registered" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_race", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(200);
    expect(admin.updateUserById).toHaveBeenCalledWith(
      "user-raced-in",
      expect.objectContaining({ password: VALID_PASSWORD })
    );
  });

  it("returns 500 when admin.createUser fails and no parallel mint is detected", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    const { client } = fakeServiceClient({
      createUser: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Database is down" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_fail", password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
  });

  it("returns 500 when admin.updateUserById fails", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("user-existing");
    const { client } = fakeServiceClient({
      updateUserById: vi
        .fn()
        .mockResolvedValue({ error: { message: "DB error" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_update_fail", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(500);
  });

  it("rejects when the Stripe session is not complete", async () => {
    mockStripeSession({ status: "open" });

    const response = await POST(
      makeRequest({ sessionId: "cs_test_open", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(403);
    expect(vi.mocked(createSupabaseServiceClient)).not.toHaveBeenCalled();
  });

  it("rejects when the Stripe session has not been paid", async () => {
    mockStripeSession({ payment_status: "unpaid" });

    const response = await POST(
      makeRequest({ sessionId: "cs_test_unpaid", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(403);
  });

  it("rejects when the Stripe session is missing businessId or email", async () => {
    mockStripeSession({ metadata: {}, customer_details: null, customer_email: null });

    const response = await POST(
      makeRequest({ sessionId: "cs_test_orphan", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(403);
  });

  it("rejects weak passwords without ever touching auth", async () => {
    const response = await POST(
      makeRequest({ sessionId: "cs_test_weak", password: "short" })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toMatch(/password/i);
    expect(vi.mocked(getStripe)).not.toHaveBeenCalled();
    expect(vi.mocked(createSupabaseServiceClient)).not.toHaveBeenCalled();
  });

  it("returns 403 when the Stripe session retrieve throws (bad/expired session id)", async () => {
    vi.mocked(getStripe).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockRejectedValue(new Error("No such session"))
        }
      }
    } as never);

    const response = await POST(
      makeRequest({ sessionId: "cs_does_not_exist", password: VALID_PASSWORD })
    );

    expect(response.status).toBe(403);
  });

  it("validates request shape and rejects missing sessionId", async () => {
    const response = await POST(
      makeRequest({ password: VALID_PASSWORD })
    );

    expect(response.status).toBe(400);
  });

  it("falls back to session.customer_email when customer_details is absent", async () => {
    // Stripe sometimes omits customer_details on test fixtures or when the
    // session predates the customer object. The route should still accept
    // a session that carries `customer_email` directly.
    mockStripeSession({ customer_details: null, customer_email: VALID_EMAIL });
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    const { client } = fakeServiceClient({
      createUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-fallback" } }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: "cs_test_fallback_email", password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ownerEmail).toBe(VALID_EMAIL);
  });
});
