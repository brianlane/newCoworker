import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/onboarding-drafts", () => ({ getOnboardingDraft: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessWebsiteUrl: vi.fn()
}));
vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(),
  updateBusinessWebsiteMd: vi.fn(),
  upsertBusinessConfig: vi.fn()
}));
vi.mock("@/lib/website-ingest", () => ({
  ingestWebsite: vi.fn(),
  normalizeWebsiteUrl: (raw: string) => {
    try {
      return new URL(raw).toString();
    } catch {
      return null;
    }
  }
}));
vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/onboard/website-ingest/route";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { getBusiness, updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { getBusinessConfig, updateBusinessWebsiteMd, upsertBusinessConfig } from "@/lib/db/configs";
import { ingestWebsite } from "@/lib/website-ingest";
import { getAuthUser } from "@/lib/auth";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/onboard/website-ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const INGEST_OK = {
  ok: true as const,
  websiteMd: "# Website\nbody",
  pagesCrawled: 2,
  bytesDownloaded: 1024,
  finalUrl: "https://example.com/"
};

describe("api/onboard/website-ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ingestWebsite).mockResolvedValue(INGEST_OK);
    vi.mocked(updateBusinessWebsiteUrl).mockResolvedValue(undefined as never);
    vi.mocked(updateBusinessWebsiteMd).mockResolvedValue(undefined as never);
    vi.mocked(upsertBusinessConfig).mockResolvedValue(undefined as never);
    vi.mocked(getBusinessConfig).mockResolvedValue(null);
    vi.mocked(getAuthUser).mockResolvedValue(null);
  });

  it("authorizes pre-auth callers via matching draftToken and returns preview only", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: BIZ,
      draft_token: TOKEN,
      payload: {},
      created_at: "",
      updated_at: ""
    } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", draftToken: TOKEN }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(json.data.websiteMdPreview).toContain("Website");
    // Pre-auth (draft) callers must not receive the full websiteMd payload.
    expect(json.data.websiteMd).toBeUndefined();
    // New business_configs row is created via upsertBusinessConfig on first-time
    // onboarding (getBusinessConfig returned null above).
    expect(upsertBusinessConfig).toHaveBeenCalledWith(expect.objectContaining({ business_id: BIZ }));
  });

  it("rejects when draftToken does not match the persisted draft and no user session exists", async () => {
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: BIZ,
      draft_token: "different-token",
      payload: {},
      created_at: "",
      updated_at: ""
    } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", draftToken: TOKEN }));
    expect(res.status).toBe(403);
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("authorizes owners by email and returns the full websiteMd so dashboard re-crawl can refresh in place", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "Owner@Example.com" } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue({ business_id: BIZ } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(json.data.websiteMd).toBe(INGEST_OK.websiteMd);
    expect(updateBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
  });

  it("authorizes admin users without checking business ownership", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue(null);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(getBusiness).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when the authenticated user is not the owner", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "someone@else", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(403);
  });

  it("returns FORBIDDEN when an authenticated user has no email", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: null, isAdmin: false } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(403);
  });

  it("returns FORBIDDEN when the business record cannot be loaded", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(403);
  });

  it("tolerates a thrown getOnboardingDraft and still falls through to session auth", async () => {
    vi.mocked(getOnboardingDraft).mockRejectedValue(new Error("boom"));
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", draftToken: TOKEN }));
    expect(res.status).toBe(200);
  });

  it("propagates VALIDATION_ERROR for malformed websiteUrl", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "not-a-url" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when zod rejects the body shape (non-uuid businessId)", async () => {
    const res = await POST(jsonRequest({ businessId: "not-uuid", websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(400);
  });

  it("logs + surfaces ingestWebsite failures without persisting", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockResolvedValue({ ok: false, error: "fetch_failed", detail: "nope" });

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toBe("fetch_failed");
    expect(updateBusinessWebsiteUrl).not.toHaveBeenCalled();
  });

  it("tolerates updateBusinessWebsiteUrl failures and still persists website_md", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(updateBusinessWebsiteUrl).mockRejectedValue(new Error("db down"));
    vi.mocked(getBusinessConfig).mockResolvedValue({ business_id: BIZ } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(updateBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
  });

  it("handles non-Error rejections from updateBusinessWebsiteUrl via String() fallback", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(updateBusinessWebsiteUrl).mockRejectedValue("plain string");
    vi.mocked(getBusinessConfig).mockResolvedValue({ business_id: BIZ } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
  });

  it("returns a 500 when ingestWebsite itself throws (handleRouteError path)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockRejectedValue(new Error("kaboom"));

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(500);
  });
});
