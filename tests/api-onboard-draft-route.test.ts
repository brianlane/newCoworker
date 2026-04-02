import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/onboarding-drafts", () => ({
  getOnboardingDraft: vi.fn(),
  upsertOnboardingDraft: vi.fn()
}));

import { GET, POST } from "@/app/api/onboard/draft/route";
import { getOnboardingDraft, upsertOnboardingDraft } from "@/lib/db/onboarding-drafts";

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
});
