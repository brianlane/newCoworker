import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 }))
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn(async () => ({})) }));

// Keep the real previewFubCsv (pure parsing) so the route's parse-error path
// is exercised for real; mock only the pieces that touch the database.
vi.mock("@/lib/fub-import/run", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/fub-import/run")>();
  return {
    ...mod,
    createFubImportJob: vi.fn(),
    importFubCsv: vi.fn(),
    latestFubImportJob: vi.fn(),
    updateFubImportJob: vi.fn()
  };
});

import { GET, POST } from "@/app/api/dashboard/import/fub/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  createFubImportJob,
  importFubCsv,
  latestFubImportJob,
  updateFubImportJob
} from "@/lib/fub-import/run";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const ADMIN = { userId: "u-2", email: "admin@example.com", isAdmin: true };
const BIZ = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const CSV = "First Name,Phone,Stage\nJane,+16025551234,Lead\nBob,+16025555678,Contacted";

const JOB_ROW = {
  id: JOB,
  business_id: BIZ,
  status: "pending" as const,
  dry_run: true,
  counts: {},
  error: null,
  created_by: OWNER.userId,
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z"
};

function post(body: string, query = `businessId=${BIZ}&dryRun=true`) {
  return POST(
    new Request(`https://x.test/api/dashboard/import/fub?${query}`, { method: "POST", body })
  );
}

async function json(res: Response) {
  return (await res.json()) as { data?: Record<string, unknown>; error?: { message?: string } };
}

beforeEach(() => {
  // Call history as well as behavior: several cases assert that something was
  // NOT called, which a previous case's calls would otherwise satisfy.
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(rateLimit).mockReturnValue({ success: true } as never);
  vi.mocked(createFubImportJob).mockResolvedValue(JOB_ROW as never);
  vi.mocked(updateFubImportJob).mockResolvedValue(undefined as never);
  vi.mocked(importFubCsv).mockResolvedValue({
    totalRows: 2,
    created: 2,
    updated: 0,
    skipped: 0,
    failures: []
  } as never);
  vi.mocked(latestFubImportJob).mockResolvedValue(null as never);
});

describe("POST /api/dashboard/import/fub", () => {
  it("requires a signed-in user", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await post(CSV)).status).toBe(401);
  });

  it("requires manage_settings on the business", async () => {
    await post(CSV);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("lets a platform admin through without a role check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
    await post(CSV);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid business id", async () => {
    expect((await post(CSV, "businessId=nope&dryRun=true")).status).toBe(400);
  });

  it("rejects a dryRun value that is neither true nor false", async () => {
    expect((await post(CSV, `businessId=${BIZ}&dryRun=maybe`)).status).toBe(400);
  });

  it("defaults to a dry run when the caller omits the flag", async () => {
    await post(CSV, `businessId=${BIZ}`);
    expect(createFubImportJob).toHaveBeenCalledWith({}, BIZ, OWNER.userId, true);
    expect(importFubCsv).not.toHaveBeenCalled();
  });

  it("refuses an empty body", async () => {
    const res = await post("   ");
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toContain("Upload your Follow Up Boss export");
  });

  it("refuses a file over the byte cap", async () => {
    const res = await post("Phone\n" + "+16025551234\n".repeat(90_000));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toContain("too large");
  });

  it("refuses a file with no identity column BEFORE recording a job", async () => {
    const res = await post("First Name,Stage\nJane,Lead");
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toContain("No phone or email column");
    // A file we cannot read is the owner's to fix, not an import attempt.
    expect(createFubImportJob).not.toHaveBeenCalled();
  });

  it("rate limits repeated imports", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    expect((await post(CSV)).status).toBe(429);
  });

  it("a dry run reports the preview and writes no contacts", async () => {
    const res = await post(CSV);
    expect(res.status).toBe(200);
    const body = await json(res);
    const job = body.data?.job as { status: string; counts: { preview: { totalRows: number } } };
    expect(job.status).toBe("dry_run_done");
    expect(job.counts.preview.totalRows).toBe(2);
    expect(importFubCsv).not.toHaveBeenCalled();
    expect(updateFubImportJob).toHaveBeenCalledWith(
      {},
      BIZ,
      JOB,
      expect.objectContaining({ status: "dry_run_done" })
    );
  });

  it("a real run imports and reports the summary alongside the preview", async () => {
    const res = await post(CSV, `businessId=${BIZ}&dryRun=false`);
    expect(res.status).toBe(200);
    const job = (await json(res)).data?.job as {
      status: string;
      counts: { preview: unknown; summary: { created: number } };
    };
    expect(job.status).toBe("done");
    expect(job.counts.summary.created).toBe(2);
    expect(job.counts.preview).toBeTruthy();
    expect(createFubImportJob).toHaveBeenCalledWith({}, BIZ, OWNER.userId, false);
  });

  it("marks the job failed and answers 502 when the import throws", async () => {
    vi.mocked(importFubCsv).mockRejectedValue(new Error("contacts unavailable"));
    const res = await post(CSV, `businessId=${BIZ}&dryRun=false`);
    expect(res.status).toBe(502);
    expect((await json(res)).error?.message).toContain("contacts unavailable");
    expect(updateFubImportJob).toHaveBeenCalledWith(
      {},
      BIZ,
      JOB,
      expect.objectContaining({ status: "failed", error: "contacts unavailable" })
    );
  });

  it("records a non-Error throw as a failure too", async () => {
    vi.mocked(importFubCsv).mockRejectedValue("nope");
    const res = await post(CSV, `businessId=${BIZ}&dryRun=false`);
    expect(res.status).toBe(502);
    expect(updateFubImportJob).toHaveBeenCalledWith(
      {},
      BIZ,
      JOB,
      expect.objectContaining({ status: "failed", error: "import failed" })
    );
  });

  it("never asks for or accepts an API key", async () => {
    // The whole point of the CSV surface: no key parameter exists, so a
    // caller sending one gets it ignored rather than stored.
    const source = (
      await import("node:fs/promises")
    ).readFile;
    const text = await source(
      new URL("../src/app/api/dashboard/import/fub/route.ts", import.meta.url),
      "utf8"
    );
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("encryptIntegrationSecret");
  });
});

describe("GET /api/dashboard/import/fub", () => {
  it("requires a signed-in user", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await GET(new Request(`https://x.test/api/dashboard/import/fub?businessId=${BIZ}`));
    expect(res.status).toBe(401);
  });

  it("returns null when the business has never imported", async () => {
    const res = await GET(new Request(`https://x.test/api/dashboard/import/fub?businessId=${BIZ}`));
    expect((await json(res)).data?.job).toBeNull();
  });

  it("returns the latest job for the status card", async () => {
    vi.mocked(latestFubImportJob).mockResolvedValue({
      ...JOB_ROW,
      status: "done",
      dry_run: false,
      counts: { summary: { created: 5 } }
    } as never);
    const res = await GET(new Request(`https://x.test/api/dashboard/import/fub?businessId=${BIZ}`));
    const job = (await json(res)).data?.job as { status: string; counts: unknown };
    expect(job.status).toBe("done");
    expect(job.counts).toEqual({ summary: { created: 5 } });
  });

  it("rate limits status polling", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    const res = await GET(new Request(`https://x.test/api/dashboard/import/fub?businessId=${BIZ}`));
    expect(res.status).toBe(429);
  });

  it("rejects a non-uuid business id", async () => {
    const res = await GET(new Request("https://x.test/api/dashboard/import/fub?businessId=nope"));
    expect(res.status).toBe(400);
  });
});
