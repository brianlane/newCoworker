import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  verifySignupIdentity: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  createBusiness: vi.fn(),
  getBusiness: vi.fn(),
  updateBusinessPreferredAreaCode: vi.fn(),
  updateBusinessTimezone: vi.fn(),
  isValidIanaTimezone: vi.fn().mockReturnValue(false)
}));
vi.mock("@/lib/onboarding/token", () => ({
  createOnboardingToken: vi.fn(),
  createPendingOwnerEmail: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/business/create/route";
import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import {
  createBusiness,
  getBusiness,
  updateBusinessPreferredAreaCode
} from "@/lib/db/businesses";
import { createOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PENDING_EMAIL = `pending+${BIZ}@onboarding.local`;
const ONBOARDING_TOKEN = "onboard.signed.token";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/business/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessId: BIZ,
    name: "Acme Realty",
    tier: "starter",
    ownerEmail: "owner@example.com",
    ...extra
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(null);
  vi.mocked(getBusiness).mockResolvedValue(null);
  vi.mocked(createPendingOwnerEmail).mockReturnValue(PENDING_EMAIL);
  vi.mocked(createOnboardingToken).mockReturnValue(ONBOARDING_TOKEN);
  vi.mocked(createBusiness).mockResolvedValue({
    id: BIZ,
    name: "Acme Realty",
    owner_email: PENDING_EMAIL,
    tier: "starter",
    status: "offline",
    hostinger_vps_id: null,
    created_at: new Date().toISOString()
  } as never);
});

describe("/api/business/create — anonymous Stripe-first flow", () => {
  it("creates a pending business and mints an onboardingToken when no row exists", async () => {
    const res = await POST(jsonRequest(baseBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ businessId: BIZ, onboardingToken: ONBOARDING_TOKEN });
    expect(getBusiness).toHaveBeenCalledWith(BIZ);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: BIZ, ownerEmail: PENDING_EMAIL, tier: "starter" })
    );
  });

  it("is idempotent when the same anonymous caller retries with a businessId already pending", async () => {
    // Simulates the failure-then-retry path: a previous request inserted
    // the row with the pending sentinel email, but the client never got
    // back the success response (or never wrote `persistedToDatabase`
    // before the user retried). The route MUST treat this as success and
    // re-issue a fresh onboardingToken so the orchestration can proceed.
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: PENDING_EMAIL,
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ businessId: BIZ, onboardingToken: ONBOARDING_TOKEN });
    // No second insert — that would 23505 against the existing row.
    expect(createBusiness).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the businessId is already bound to a different owner", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: "someone-else@example.com",
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody()));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(createBusiness).not.toHaveBeenCalled();
  });
});

describe("/api/business/create — authenticated path", () => {
  it("uses the session email and skips onboardingToken minting", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com" } as never);
    vi.mocked(createBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: "owner@example.com",
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ businessId: BIZ, onboardingToken: null });
    expect(createOnboardingToken).not.toHaveBeenCalled();
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: "owner@example.com" })
    );
  });

  it("is idempotent for the authenticated path when the existing row's owner matches the session email", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com" } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: "owner@example.com",
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ businessId: BIZ, onboardingToken: null });
    expect(createBusiness).not.toHaveBeenCalled();
  });
});

describe("/api/business/create — legacy signupUserId path", () => {
  it("rejects when signupUserId is provided without ownerEmail", async () => {
    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        name: "Acme Realty",
        tier: "starter",
        signupUserId: "22222222-2222-4222-8222-222222222222"
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Authentication required");
  });

  it("rejects when verifySignupIdentity fails", async () => {
    vi.mocked(verifySignupIdentity).mockResolvedValue(false);
    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        name: "Acme Realty",
        tier: "starter",
        ownerEmail: "owner@example.com",
        signupUserId: "22222222-2222-4222-8222-222222222222"
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Not authorized to create business");
  });

  it("creates the business when verifySignupIdentity succeeds", async () => {
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(createBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: "owner@example.com",
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        name: "Acme Realty",
        tier: "starter",
        ownerEmail: "owner@example.com",
        signupUserId: "22222222-2222-4222-8222-222222222222"
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.onboardingToken).toBeNull();
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: "owner@example.com" })
    );
  });
});

describe("/api/business/create — validation", () => {
  it("rejects non-uuid businessId with 400", async () => {
    const res = await POST(jsonRequest({ businessId: "not-a-uuid", name: "Acme", tier: "starter" }));
    expect(res.status).toBe(400);
  });

  it("rejects empty business name with 400", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, name: "", tier: "starter" }));
    expect(res.status).toBe(400);
  });
});

describe("/api/business/create — Step 1 dropdown teamSize → integer mapping", () => {
  // Regression suite for the codex-flagged bug where the route called
  // `parseInt(body.teamSize, 10)` directly. After the Step 1 form
  // migration, `teamSize` arrives as bucket strings like "Just me",
  // "2-3", "4-5", etc. — `parseInt("Just me")` was `NaN` (broke
  // create/checkout for solo operators) and `parseInt("4-5")`
  // silently truncated to `4` purely by parseInt's trailing-garbage
  // tolerance. The route now delegates to `teamSizeBucketToInt`,
  // which is exhaustively unit-tested in
  // `onboarding-intake-options.test.ts` — these cases lock the route
  // contract: every dropdown bucket reaches `createBusiness` as a
  // valid positive integer.
  const cases: { input: string; expected: number }[] = [
    { input: "Just me", expected: 1 },
    { input: "2-3", expected: 2 },
    { input: "4-5", expected: 4 },
    { input: "6-10", expected: 6 },
    { input: "11-25", expected: 11 },
    { input: "25+", expected: 25 }
  ];

  for (const { input, expected } of cases) {
    it(`maps "${input}" to ${expected} before insert`, async () => {
      const res = await POST(jsonRequest(baseBody({ teamSize: input })));
      expect(res.status).toBe(200);
      expect(createBusiness).toHaveBeenCalledWith(
        expect.objectContaining({ teamSize: expected })
      );
    });
  }

  it("backfills preferred_area_code on the idempotent retry path when the row lacks one", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: PENDING_EMAIL,
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      preferred_area_code: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "(519)" })));
    expect(res.status).toBe(200);
    expect(createBusiness).not.toHaveBeenCalled();
    expect(updateBusinessPreferredAreaCode).toHaveBeenCalledWith(BIZ, "519");
  });

  it("updates preferred_area_code on retry when the user changed it (latest valid input wins)", async () => {
    // Step-1 back-navigation after the row was written: the create call is
    // re-hit with the new value and the existing-row path applies it.
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: PENDING_EMAIL,
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      preferred_area_code: "602",
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "519" })));
    expect(res.status).toBe(200);
    expect(updateBusinessPreferredAreaCode).toHaveBeenCalledWith(BIZ, "519");
  });

  it("skips the retry write when the stored value already matches", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: PENDING_EMAIL,
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      preferred_area_code: "519",
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "(519)" })));
    expect(res.status).toBe(200);
    expect(updateBusinessPreferredAreaCode).not.toHaveBeenCalled();
  });

  it("skips the retry backfill when the retry body has no valid area code", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme Realty",
      owner_email: PENDING_EMAIL,
      tier: "starter",
      status: "offline",
      hostinger_vps_id: null,
      preferred_area_code: null,
      created_at: new Date().toISOString()
    } as never);

    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "1x" })));
    expect(res.status).toBe(200);
    expect(updateBusinessPreferredAreaCode).not.toHaveBeenCalled();
  });

  it("normalizes a decorated preferredAreaCode before insert", async () => {
    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "(519)" })));
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAreaCode: "519" })
    );
  });

  it("silently drops an invalid preferredAreaCode instead of failing creation", async () => {
    const res = await POST(jsonRequest(baseBody({ preferredAreaCode: "12" })));
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAreaCode: null })
    );
  });

  it("passes null preferredAreaCode when the field is unset", async () => {
    const res = await POST(jsonRequest(baseBody({})));
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAreaCode: null })
    );
  });

  it("omits teamSize entirely when the field is unset", async () => {
    // Defensive: the route still has a falsy guard around the
    // conversion so a missing field stays `undefined` rather than
    // being defaulted to `1` server-side. The form should never
    // submit without it (advance gate blocks), but legacy clients
    // and direct API callers still need this contract.
    const res = await POST(jsonRequest(baseBody({})));
    expect(res.status).toBe(200);
    const lastCall = vi.mocked(createBusiness).mock.calls.at(-1)?.[0];
    expect(lastCall?.teamSize).toBeUndefined();
  });
});
