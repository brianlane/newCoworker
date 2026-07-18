import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/onboarding-drafts", () => ({
  getOnboardingDraft: vi.fn(),
  upsertOnboardingDraft: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  businessExists: vi.fn()
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    ...actual,
    rateLimitDurable: vi.fn()
  };
});

// Real HMAC verification: mint tokens with the production helper so the
// route's first-claim gate is exercised against genuine signatures.
process.env.ONBOARDING_TOKEN_SECRET = "test-onboarding-secret";

import { GET, POST } from "@/app/api/onboard/draft/route";
import { businessExists } from "@/lib/db/businesses";
import { getOnboardingDraft, upsertOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { createOnboardingToken } from "@/lib/onboarding/token";
import { rateLimitDurable } from "@/lib/rate-limit";

const MOCK_DRAFT = {
  business_id: "11111111-1111-4111-8111-111111111111",
  draft_token: "22222222-2222-4222-8222-222222222222",
  payload: {
    businessId: "11111111-1111-4111-8111-111111111111",
    draftToken: "22222222-2222-4222-8222-222222222222",
    tier: "standard",
    billingPeriod: "biennial",
    businessName: "Test Biz",
    businessType: "real_estate",
    ownerName: "Brian Lane",
    ownerEmail: "owner@example.com",
    phone: "16026866672",
    serviceArea: "Phoenix",
    typicalInquiry: "Test inquiry",
    teamSize: "1",
    crmUsed: "",
    persistedToDatabase: false
  },
  created_at: "2026-04-02T00:00:00Z",
  updated_at: "2026-04-02T00:00:00Z"
};

describe("api/onboard/draft route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertOnboardingDraft).mockResolvedValue(MOCK_DRAFT as never);
    vi.mocked(getOnboardingDraft).mockResolvedValue(MOCK_DRAFT as never);
    vi.mocked(businessExists).mockResolvedValue(false);
    vi.mocked(rateLimitDurable).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60000
    });
  });

  it("saves a draft", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/onboard/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: MOCK_DRAFT.business_id,
          draftToken: MOCK_DRAFT.draft_token,
          onboardingData: MOCK_DRAFT.payload
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(upsertOnboardingDraft).toHaveBeenCalled();
  });

  it("rejects saving a draft when the token does not match the existing record", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(MOCK_DRAFT as never);

    const response = await POST(
      new Request("http://localhost:3000/api/onboard/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: MOCK_DRAFT.business_id,
          draftToken: "33333333-3333-4333-8333-333333333333",
          onboardingData: MOCK_DRAFT.payload
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Onboarding draft token mismatch");
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  it("loads a draft", async () => {
    const response = await GET(
      new Request(
        `http://localhost:3000/api/onboard/draft?businessId=${MOCK_DRAFT.business_id}&draftToken=${MOCK_DRAFT.draft_token}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.onboardingData.businessName).toBe("Test Biz");
  });

  it("returns 500 when the existing draft lookup errors during save", async () => {
    vi.mocked(getOnboardingDraft).mockRejectedValue(new Error("getOnboardingDraft: db down"));

    const response = await POST(
      new Request("http://localhost:3000/api/onboard/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: MOCK_DRAFT.business_id,
          draftToken: MOCK_DRAFT.draft_token,
          onboardingData: MOCK_DRAFT.payload
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  it("returns 404 when draft does not exist", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);

    const response = await GET(
      new Request(
        `http://localhost:3000/api/onboard/draft?businessId=${MOCK_DRAFT.business_id}&draftToken=${MOCK_DRAFT.draft_token}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
  });

  // ── First-claim gate (audit 2026-07, finding L3) ─────────────────────────

  function firstClaimRequest(onboardingToken?: string): Request {
    return new Request("http://localhost:3000/api/onboard/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: MOCK_DRAFT.business_id,
        draftToken: MOCK_DRAFT.draft_token,
        ...(onboardingToken ? { onboardingToken } : {}),
        onboardingData: MOCK_DRAFT.payload
      })
    });
  }

  it("allows a first claim when the business row does not exist yet (pre-create save)", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
    vi.mocked(businessExists).mockResolvedValue(false);

    const response = await POST(firstClaimRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(upsertOnboardingDraft).toHaveBeenCalled();
  });

  it("rejects a first claim for a persisted business without an onboarding token", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
    vi.mocked(businessExists).mockResolvedValue(true);

    const response = await POST(firstClaimRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe("Onboarding token required to claim this draft");
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  it("rejects a first claim for a persisted business with a token for another business", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
    vi.mocked(businessExists).mockResolvedValue(true);

    const response = await POST(
      firstClaimRequest(createOnboardingToken({ businessId: "99999999-9999-4999-8999-999999999999" }))
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  it("allows a first claim for a persisted business with a valid onboarding token", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
    vi.mocked(businessExists).mockResolvedValue(true);

    const response = await POST(
      firstClaimRequest(createOnboardingToken({ businessId: MOCK_DRAFT.business_id }))
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(upsertOnboardingDraft).toHaveBeenCalled();
  });

  it("does not consult the business row when a draft row already exists", async () => {
    const response = await POST(firstClaimRequest());

    expect(response.status).toBe(200);
    expect(businessExists).not.toHaveBeenCalled();
  });

  it("fails CLOSED (500, no upsert) when the business existence lookup errors", async () => {
    // A transient DB failure must not be read as "business does not exist" —
    // that would skip the token requirement and reopen the pre-claim window.
    vi.mocked(getOnboardingDraft).mockResolvedValue(null);
    vi.mocked(businessExists).mockRejectedValue(new Error("businessExists: db down"));

    const response = await POST(firstClaimRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  // ── Durable rate limit (audit 2026-07, finding M3) ───────────────────────

  it("returns 429 on POST when the durable rate limit is exhausted", async () => {
    vi.mocked(rateLimitDurable).mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60000
    });

    const response = await POST(firstClaimRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(getOnboardingDraft).not.toHaveBeenCalled();
    expect(upsertOnboardingDraft).not.toHaveBeenCalled();
  });

  it("returns 429 on GET when the durable rate limit is exhausted", async () => {
    vi.mocked(rateLimitDurable).mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60000
    });

    const response = await GET(
      new Request(
        `http://localhost:3000/api/onboard/draft?businessId=${MOCK_DRAFT.business_id}&draftToken=${MOCK_DRAFT.draft_token}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(getOnboardingDraft).not.toHaveBeenCalled();
  });

  it("keys the durable limiter off the forwarded client IP", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/onboard/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.9, 10.0.0.1"
        },
        body: JSON.stringify({
          businessId: MOCK_DRAFT.business_id,
          draftToken: MOCK_DRAFT.draft_token,
          onboardingData: MOCK_DRAFT.payload
        })
      })
    );

    expect(response.status).toBe(200);
    expect(rateLimitDurable).toHaveBeenCalledWith(
      "onboard-draft:203.0.113.9",
      expect.objectContaining({ maxRequests: 30 })
    );
  });
});
