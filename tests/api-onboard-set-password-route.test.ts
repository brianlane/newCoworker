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

// The route dispatches a real verification email on the happy path. Without
// this mock the suite calls the live Resend SDK — and when the test process
// inherits a real RESEND_API_KEY (e.g. a shell that sourced .env), it sends
// actual emails to the Stripe-fixture address paid@example.com.
vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn().mockResolvedValue("email-id")
}));

// Token minting needs an HMAC secret from env (EMAIL_VERIFICATION_TOKEN_SECRET
// or SUPABASE_SERVICE_ROLE_KEY); mock it so the dispatch path is exercised
// deterministically regardless of the host environment.
vi.mock("@/lib/email/verification-token", () => ({
  createEmailVerificationToken: vi.fn(() => "test-verification-token")
}));

import { POST } from "@/app/api/onboard/set-password/route";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { sendOwnerEmail } from "@/lib/email/client";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const VALID_PASSWORD = "Hunter2-strong";
const VALID_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const VALID_EMAIL = "paid@example.com";
const VALID_SESSION_ID = "cs_test_owner";

type FakeAdmin = {
  createUser: ReturnType<typeof vi.fn>;
  // updateUserById is asserted-NOT-called across the suite to lock the
  // create-only contract. We still expose it on the fake so any
  // accidental call would surface as a real invocation rather than a
  // type error.
  updateUserById: ReturnType<typeof vi.fn>;
};

function fakeServiceClient(admin: Partial<FakeAdmin> = {}) {
  const defaults: FakeAdmin = {
    createUser: vi.fn(),
    updateUserById: vi.fn()
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

  it("mints a brand-new auth user without ever calling updateUserById", async () => {
    const { client, admin } = fakeServiceClient({
      createUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-new" } }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    const response = await POST(
      makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        email_confirm: true,
        user_metadata: expect.objectContaining({
          business_id: VALID_BUSINESS_ID
        })
      })
    );
    // Pin the create-only contract: this route NEVER calls
    // updateUserById. Any future change that re-introduces an update
    // path on an existing account is a security regression — see the
    // route's docstring.
    expect(admin.updateUserById).not.toHaveBeenCalled();
    // findAuthUserIdByEmail is only consulted on the duplicate-email
    // failure path, never on the happy path.
    expect(vi.mocked(findAuthUserIdByEmail)).not.toHaveBeenCalled();
    // The post-mint verification email goes to the Stripe session's
    // verified email — through the (mocked) email client, never the
    // live Resend SDK.
    expect(vi.mocked(sendOwnerEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOwnerEmail)).toHaveBeenCalledWith(
      expect.any(String),
      VALID_EMAIL,
      "Confirm your NewCoworker email",
      expect.objectContaining({
        text: expect.stringContaining("test-verification-token"),
        html: expect.any(String)
      })
    );
  });

  it("still returns 200 when the verification email send fails (log-and-continue contract)", async () => {
    const { client } = fakeServiceClient({
      createUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-new" } }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce(new Error("resend down"));

    const response = await POST(
      makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ownerEmail).toBe(VALID_EMAIL);
  });

  it("does NOT tag user_metadata.checkout_session_id (provenance-tag mechanism removed with the create-only refactor)", async () => {
    const { client, admin } = fakeServiceClient({
      createUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-new" } }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);

    await POST(makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD }));

    const callArgs = admin.createUser.mock.calls[0]?.[0] as { user_metadata?: Record<string, unknown> };
    expect(callArgs?.user_metadata).toBeDefined();
    expect(callArgs?.user_metadata).not.toHaveProperty("checkout_session_id");
  });

  it("returns 409 CONFLICT when the email already has an auth user (TOCTOU defence-in-depth past the upstream /api/checkout gate)", async () => {
    // Reachable only when the upstream `authUserExistsByEmail` gate on
    // /api/checkout was bypassed by a TOCTOU window or when the
    // account is created by a parallel same-session call. The route
    // MUST refuse rather than overwriting the password.
    const { client, admin } = fakeServiceClient({
      createUser: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "User already registered" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("existing-user");

    const response = await POST(
      makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it("returns 409 CONFLICT on a same-session retry race (Call 1 succeeded, Call 2 finds the email taken)", async () => {
    // Network drop after a successful admin.createUser → client
    // retries with the same sessionId. The route must NOT silently
    // succeed (there's no provenance tag to verify against anymore)
    // and must NOT update. 409 sends the customer to /login, where
    // the password Call 1 set already works.
    const { client, admin } = fakeServiceClient({
      createUser: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "User already registered" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("user-just-minted-by-call-1");

    const response = await POST(
      makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it("returns 500 when admin.createUser fails for a non-duplicate reason (no existing user found)", async () => {
    const { client } = fakeServiceClient({
      createUser: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Database is down" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);

    const response = await POST(
      makeRequest({ sessionId: VALID_SESSION_ID, password: VALID_PASSWORD })
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
    mockStripeSession({ customer_details: null, customer_email: VALID_EMAIL });
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
