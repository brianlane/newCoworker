import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  findAuthUserIdByEmail: vi.fn()
}));

import { POST } from "@/app/api/onboard/check-email/route";
import { findAuthUserIdByEmail } from "@/lib/auth";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/onboard/check-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/onboard/check-email route (UX preflight)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the email as available when no auth user exists for it", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);

    const response = await POST(makeRequest({ email: "fresh@example.com" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.available).toBe(true);
    expect(findAuthUserIdByEmail).toHaveBeenCalledWith("fresh@example.com");
  });

  it("reports the email as unavailable when an auth user exists", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("existing-user");

    const response = await POST(makeRequest({ email: "owner@example.com" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.available).toBe(false);
  });

  it("fails OPEN — reports `available: true` when the soft lookup throws", async () => {
    // Critical UX choice: a transient lookup error during step 1 of
    // the questionnaire must NOT strand a legitimate signup. The
    // server-side gate at /api/checkout uses the strict
    // `authUserExistsByEmail` variant that throws on the same
    // error, so any false positive we let through here is caught
    // before payment.
    vi.mocked(findAuthUserIdByEmail).mockRejectedValue(new Error("rpc replica timeout"));

    const response = await POST(makeRequest({ email: "owner@example.com" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.available).toBe(true);
  });

  it("rejects malformed emails with VALIDATION_ERROR", async () => {
    const response = await POST(makeRequest({ email: "not-an-email" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
  });

  it("rejects requests with no email", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
  });
});
