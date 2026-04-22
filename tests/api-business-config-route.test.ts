import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  verifySignupIdentity: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  updateBusinessWebsiteUrl: vi.fn()
}));
vi.mock("@/lib/db/configs", () => ({
  patchBusinessConfig: vi.fn()
}));
vi.mock("@/lib/onboarding/token", () => ({
  verifyOnboardingToken: vi.fn(),
  createPendingOwnerEmail: vi.fn()
}));
vi.mock("@/lib/website-ingest", () => ({
  normalizeWebsiteUrl: (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

type SupabaseQueryStub = {
  from: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
};

const supabaseStub: SupabaseQueryStub = {
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn()
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

import { POST } from "@/app/api/business/config/route";
import { getAuthUser } from "@/lib/auth";
import { updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/business/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessId: BIZ,
    soulMd: "soul",
    identityMd: "identity",
    ...extra
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated owner whose business row exists.
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  supabaseStub.single.mockResolvedValue({ data: { id: BIZ }, error: null });
  supabaseStub.eq.mockReturnValue(supabaseStub);
  supabaseStub.select.mockReturnValue(supabaseStub);
  supabaseStub.from.mockReturnValue(supabaseStub);
  vi.mocked(updateBusinessWebsiteUrl).mockResolvedValue(undefined as never);
  vi.mocked(patchBusinessConfig).mockResolvedValue(undefined as never);
});

describe("api/business/config — websiteUrl persistence", () => {
  it("persists a trimmed, normalized websiteUrl when the dashboard saves a non-empty value", async () => {
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "  https://example.com/  " })));
    expect(res.status).toBe(200);
    // The dashboard now fixes the regression where plain Save discarded URL
    // edits — confirm the URL made it to the businesses row, normalized.
    expect(updateBusinessWebsiteUrl).toHaveBeenCalledWith(BIZ, "https://example.com/");
    expect(patchBusinessConfig).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ soul_md: "soul", identity_md: "identity" })
    );
  });

  it("clears websiteUrl when the owner submits an empty string", async () => {
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "" })));
    expect(res.status).toBe(200);
    expect(updateBusinessWebsiteUrl).toHaveBeenCalledWith(BIZ, null);
  });

  it("clears websiteUrl when the owner submits whitespace only", async () => {
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "   " })));
    expect(res.status).toBe(200);
    expect(updateBusinessWebsiteUrl).toHaveBeenCalledWith(BIZ, null);
  });

  it("rejects malformed websiteUrl with VALIDATION_ERROR before touching the config table", async () => {
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "javascript:alert(1)" })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(updateBusinessWebsiteUrl).not.toHaveBeenCalled();
  });

  it("still patches the config when updateBusinessWebsiteUrl fails (best-effort write)", async () => {
    vi.mocked(updateBusinessWebsiteUrl).mockRejectedValue(new Error("db down"));
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "https://example.com" })));
    expect(res.status).toBe(200);
    // The primary soul/identity save is the higher-value write, so a transient
    // businesses.update failure must not fail the whole save.
    expect(patchBusinessConfig).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "business-config: persist website_url failed",
      expect.objectContaining({ businessId: BIZ, error: "db down" })
    );
  });

  it("tolerates non-Error rejections from updateBusinessWebsiteUrl via String() fallback", async () => {
    vi.mocked(updateBusinessWebsiteUrl).mockRejectedValue("raw string");
    const res = await POST(jsonRequest(baseBody({ websiteUrl: "https://example.com" })));
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "business-config: persist website_url failed",
      expect.objectContaining({ error: "raw string" })
    );
  });

  it("skips the URL branch entirely when the caller omits websiteUrl (preserves existing DB value)", async () => {
    const res = await POST(jsonRequest(baseBody()));
    expect(res.status).toBe(200);
    expect(updateBusinessWebsiteUrl).not.toHaveBeenCalled();
    expect(patchBusinessConfig).toHaveBeenCalled();
  });
});
