import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  updateBusinessOwnerEmailIfPending: vi.fn()
}));

vi.mock("@/lib/db/onboarding-drafts", () => ({
  getOnboardingDraft: vi.fn()
}));

import { POST } from "@/app/api/onboard/finalize-signup/route";
import { updateBusinessOwnerEmailIfPending } from "@/lib/db/businesses";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { getStripe } from "@/lib/stripe/client";

describe("api/onboard/finalize-signup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStripe).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue({
            status: "complete",
            payment_status: "paid",
            metadata: {
              businessId: "11111111-1111-4111-8111-111111111111"
            },
            customer_details: {
              email: "paid@example.com"
            }
          })
        }
      }
    } as never);
    vi.mocked(updateBusinessOwnerEmailIfPending).mockResolvedValue(true);
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
  });

  it("updates the pending owner email after a completed paid session", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/onboard/finalize-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_test_123" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updateBusinessOwnerEmailIfPending).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "paid@example.com"
    );
    expect(body.data.businessId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects finalize-signup when the business is no longer pending", async () => {
    vi.mocked(updateBusinessOwnerEmailIfPending).mockResolvedValue(false);

    const response = await POST(
      new Request("http://localhost:3000/api/onboard/finalize-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_test_456" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Onboarding session is no longer valid");
  });

  it("treats a repeat finalize-signup call as success when the owner email is already finalized", async () => {
    vi.mocked(updateBusinessOwnerEmailIfPending).mockResolvedValue(true);

    const response = await POST(
      new Request("http://localhost:3000/api/onboard/finalize-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_test_repeat" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ownerEmail).toBe("paid@example.com");
  });

  it("still succeeds when onboarding draft recovery fails", async () => {
    vi.mocked(getOnboardingDraft).mockRejectedValue(new Error("getOnboardingDraft: db down"));

    const response = await POST(
      new Request("http://localhost:3000/api/onboard/finalize-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_test_draft_fail" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.businessId).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.data.ownerEmail).toBe("paid@example.com");
    expect(body.data.onboardingData).toBeNull();
  });
});
