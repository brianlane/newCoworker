import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/onboarding-drafts", () => ({ getOnboardingDraft: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessWebsiteUrl: vi.fn()
}));
vi.mock("@/lib/db/configs", () => ({
  setBusinessWebsiteMd: vi.fn(),
  setBusinessWebsiteCrawlReport: vi.fn()
}));
vi.mock("@/lib/website-ingest", () => ({
  ingestWebsite: vi.fn(),
  ingestWebsiteFromHtml: vi.fn(),
  WEBSITE_INGEST_MAX_PASTED_HTML_CHARS: 2_000_000,
  WEBSITE_INGEST_DEEP_MAX_PAGES: 80,
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
vi.mock("@/lib/memory/schedule-longform-extract", () => ({
  scheduleLongFormGraphExtract: vi.fn()
}));
vi.mock("@/lib/vps/schedule-vault-sync", () => ({
  scheduleVaultSync: vi.fn()
}));

import { POST } from "@/app/api/onboard/website-ingest/route";
import { scheduleLongFormGraphExtract } from "@/lib/memory/schedule-longform-extract";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { getBusiness, updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { setBusinessWebsiteCrawlReport, setBusinessWebsiteMd } from "@/lib/db/configs";
import { ingestWebsite, ingestWebsiteFromHtml } from "@/lib/website-ingest";
import { getAuthUser } from "@/lib/auth";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

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
  finalUrl: "https://example.com/",
  pages: [
    { url: "https://example.com/", chars: 500 },
    { url: "https://example.com/about", chars: 300 }
  ]
};

describe("api/onboard/website-ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ingestWebsite).mockResolvedValue(INGEST_OK);
    vi.mocked(updateBusinessWebsiteUrl).mockResolvedValue(undefined as never);
    vi.mocked(setBusinessWebsiteMd).mockResolvedValue(undefined as never);
    vi.mocked(setBusinessWebsiteCrawlReport).mockResolvedValue(undefined as never);
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
    // The race-safe helper is called directly; it handles insert-if-absent +
    // targeted update internally, so there's no separate `upsertBusinessConfig`
    // call to assert against anymore.
    expect(setBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
    // Knowledge graph rides the crawl (kg-source: website), attributed to
    // the normalized URL.
    expect(scheduleLongFormGraphExtract).toHaveBeenCalledWith(BIZ, {
      text: INGEST_OK.websiteMd,
      source: "website",
      attributedTo: "https://example.com/"
    });
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

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(json.data.websiteMd).toBe(INGEST_OK.websiteMd);
    expect(setBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
    // Owner-consented bypass: the URL belongs to the owner, robots.txt
    // expresses third-party-crawler preferences (not first-party-agent
    // prohibitions), and many small-business sites ship default-deny
    // wildcards. Bypass is forwarded so onboarding doesn't break on
    // sites like phoenixareasbestrealtor.com whose robots blocks every
    // unknown UA. SSRF/private-IP defenses remain in place.
    // This authenticated path also requests the DEEP crawl profile:
    // sitemap-seeded discovery up to the deep page ceiling, so the vault
    // summary covers the whole site instead of homepage-linked pages only.
    expect(ingestWebsite).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ ignoreRobots: true, sitemapDiscovery: true, maxPages: 80 })
    );
  });

  it("routes pastedHtml through ingestWebsiteFromHtml instead of crawling (WAF escape hatch)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    vi.mocked(ingestWebsiteFromHtml).mockResolvedValue({
      ...INGEST_OK,
      pagesCrawled: 1
    });

    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        websiteUrl: "https://example.com/",
        businessName: "Acme",
        pastedHtml: "<html><body>Acme sells anvils</body></html>"
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(ingestWebsiteFromHtml).toHaveBeenCalledWith(
      "https://example.com/",
      "<html><body>Acme sells anvils</body></html>",
      expect.objectContaining({ businessName: "Acme" })
    );
    // No crawl when source is pasted — the site is known to block us.
    expect(ingestWebsite).not.toHaveBeenCalled();
    // Pasted ingests persist exactly like crawled ones.
    expect(setBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ);
  });

  it("treats a blank pastedHtml as a normal crawl request", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);

    const res = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", pastedHtml: "   " })
    );
    expect(res.status).toBe(200);
    expect(ingestWebsite).toHaveBeenCalled();
    expect(ingestWebsiteFromHtml).not.toHaveBeenCalled();
  });

  it("surfaces a pasted-source ingest failure as data.ok=false with the error code", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    vi.mocked(ingestWebsiteFromHtml).mockResolvedValue({ ok: false, error: "empty_content" });

    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        websiteUrl: "https://example.com/",
        pastedHtml: "<html></html>"
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toBe("empty_content");
    expect(setBusinessWebsiteMd).not.toHaveBeenCalled();
  });

  it("rejects oversized pastedHtml with VALIDATION_ERROR before any ingest work", async () => {
    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        websiteUrl: "https://example.com/",
        pastedHtml: "x".repeat(2_000_001)
      })
    );
    expect(res.status).toBe(400);
    expect(ingestWebsite).not.toHaveBeenCalled();
    expect(ingestWebsiteFromHtml).not.toHaveBeenCalled();
  });

  it("authorizes admin users without checking business ownership", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);

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

  it("returns FORBIDDEN (not 500) when the business row has a null owner_email", async () => {
    // `BusinessRow.owner_email` is typed as `string` but the column is nullable
    // in the DB. A null value used to crash `.toLowerCase()` — this test locks
    // in a clean 403 response instead of the old 500.
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: null } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(403);
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when the business row has an undefined owner_email", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({} as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(403);
    expect(ingestWebsite).not.toHaveBeenCalled();
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

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(setBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
  });

  it("handles non-Error rejections from updateBusinessWebsiteUrl via String() fallback", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(updateBusinessWebsiteUrl).mockRejectedValue("plain string");

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
  });

  it("returns a 500 when ingestWebsite itself throws (handleRouteError path)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockRejectedValue(new Error("kaboom"));

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(500);
  });

  // Vault-sync wiring: every successful ingest re-pushes the new website.md
  // to the live VPS and re-seeds the MongoDB agent's instructions. Without
  // this, the just-persisted `website_md` would land in Supabase only and
  // chat / SMS / voice would still reply from the provision-time vault.
  it("triggers a vault re-seed after a successful ingest", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ);
  });

  it("does NOT trigger a vault re-seed when the ingest itself failed", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockResolvedValue({ ok: false, error: "fetch_failed" });

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(scheduleVaultSync).not.toHaveBeenCalled();
  });

  // --- Last-crawl report persistence ---

  it("persists the crawl report on success (crawl source)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    expect(setBusinessWebsiteCrawlReport).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ source: "crawl", pages: INGEST_OK.pages })
    );
  });

  it("persists the crawl report with pasted_html source for the paste path", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    vi.mocked(ingestWebsiteFromHtml).mockResolvedValue({ ...INGEST_OK, pagesCrawled: 1 });

    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        websiteUrl: "https://example.com/",
        pastedHtml: "<html><body>Acme sells anvils</body></html>"
      })
    );
    expect(res.status).toBe(200);
    expect(setBusinessWebsiteCrawlReport).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ source: "pasted_html" })
    );
  });

  it("tolerates a crawl-report write failure (report is cosmetic, ingest still succeeds)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(setBusinessWebsiteCrawlReport).mockRejectedValue(new Error("db down"));

    const res = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    // The load-bearing writes still happened.
    expect(setBusinessWebsiteMd).toHaveBeenCalled();
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ);
  });

  it("returns the crawled pages list to owners but not to draft callers", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    const ownerRes = await POST(jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/" }));
    const ownerJson = await ownerRes.json();
    expect(ownerJson.data.pages).toEqual(INGEST_OK.pages);

    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: BIZ,
      draft_token: TOKEN,
      payload: {},
      created_at: "",
      updated_at: ""
    } as never);
    const draftRes = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", draftToken: TOKEN })
    );
    const draftJson = await draftRes.json();
    expect(draftJson.data.pages).toBeUndefined();
  });

  // --- NDJSON streaming mode ---

  async function readNdjsonLines(res: Response): Promise<Array<Record<string, unknown>>> {
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("streams NDJSON progress lines followed by a result line when stream:true", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    vi.mocked(ingestWebsite).mockImplementation(async (_url, options) => {
      options?.onProgress?.({ type: "sitemap_found", count: 12 });
      options?.onProgress?.({ type: "page_fetched", url: "https://example.com/", bytes: 1000, index: 1 });
      options?.onProgress?.({ type: "summarizing", pages: 2 });
      return INGEST_OK;
    });

    const res = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", stream: true })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const lines = await readNdjsonLines(res);
    expect(lines.map((l) => l.kind)).toEqual(["progress", "progress", "progress", "result"]);
    expect(lines[0]).toMatchObject({ type: "sitemap_found", count: 12 });
    expect(lines[1]).toMatchObject({ type: "page_fetched", url: "https://example.com/", index: 1 });
    const result = lines[3];
    expect(result).toMatchObject({
      ok: true,
      pagesCrawled: INGEST_OK.pagesCrawled,
      websiteMd: INGEST_OK.websiteMd
    });
    expect(result.pages).toEqual(INGEST_OK.pages);
    // Streaming persists exactly like the JSON path.
    expect(setBusinessWebsiteMd).toHaveBeenCalledWith(BIZ, INGEST_OK.websiteMd);
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ);
  });

  it("streams a summarizing progress line for the pasted-source path (no crawl events exist)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@example.com", isAdmin: false } as never);
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "owner@example.com" } as never);
    vi.mocked(ingestWebsiteFromHtml).mockResolvedValue({ ...INGEST_OK, pagesCrawled: 1 });

    const res = await POST(
      jsonRequest({
        businessId: BIZ,
        websiteUrl: "https://example.com/",
        pastedHtml: "<html><body>Acme sells anvils</body></html>",
        stream: true
      })
    );
    expect(res.status).toBe(200);
    const lines = await readNdjsonLines(res);
    // Without this line a streaming client sits on "Contacting your site…"
    // for the entire Gemini call.
    expect(lines[0]).toMatchObject({ kind: "progress", type: "summarizing", pages: 1 });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "result", ok: true });
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("streams an ok:false result line when the ingest fails (no persistence)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockResolvedValue({ ok: false, error: "fetch_failed", detail: "HTTP 403" });

    const res = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", stream: true })
    );
    expect(res.status).toBe(200);
    const lines = await readNdjsonLines(res);
    expect(lines[lines.length - 1]).toMatchObject({
      kind: "result",
      ok: false,
      error: "fetch_failed",
      detail: "HTTP 403"
    });
    expect(setBusinessWebsiteMd).not.toHaveBeenCalled();
  });

  it("streams a terminal error line when the ingest throws mid-stream", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@nc", isAdmin: true } as never);
    vi.mocked(ingestWebsite).mockRejectedValue(new Error("kaboom"));

    const res = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", stream: true })
    );
    // Status is already committed once the stream starts; the error is a line.
    expect(res.status).toBe(200);
    const lines = await readNdjsonLines(res);
    expect(lines[lines.length - 1]).toMatchObject({ kind: "error" });
  });

  it("keeps auth failures as plain JSON 403 even when stream:true", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(
      jsonRequest({ businessId: BIZ, websiteUrl: "https://example.com/", stream: true })
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type") ?? "").not.toContain("ndjson");
    expect(ingestWebsite).not.toHaveBeenCalled();
  });
});
