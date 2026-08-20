import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}) as never)
}));
vi.mock("@/lib/integrations/secrets", () => ({
  decryptIntegrationSecret: vi.fn(() => "fub-key")
}));
vi.mock("@/lib/fub-import/client", () => ({
  createFubClient: vi.fn(() => ({}) as never)
}));
vi.mock("@/lib/fub-import/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fub-import/run")>();
  return {
    ...actual,
    getFubImportJob: vi.fn(),
    runFubImportChunk: vi.fn(),
    updateFubImportJob: vi.fn()
  };
});

import { POST } from "@/app/api/dashboard/import/fub/run/route";
import { getAuthUser } from "@/lib/auth";
import {
  getFubImportJob,
  runFubImportChunk,
  type FubImportJobRow
} from "@/lib/fub-import/run";

const BIZ = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";

const USER = { userId: "u-1", email: "owner@example.com", isAdmin: true };

function job(overrides: Partial<FubImportJobRow> = {}): FubImportJobRow {
  return {
    id: JOB,
    business_id: BIZ,
    status: "dry_run_done",
    dry_run: true,
    api_key_encrypted: "enc:v1:x",
    counts: {},
    cursor: {},
    error: null,
    created_by: null,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    ...overrides
  };
}

function run() {
  return POST(
    new Request("http://localhost/api/dashboard/import/fub/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: BIZ, jobId: JOB })
    })
  );
}

describe("api/dashboard/import/fub/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(runFubImportChunk).mockResolvedValue({
      status: "done",
      counts: {} as never,
      cursor: {} as never
    });
  });

  // Regression: dry_run false means a REAL run has begun (the engine claims
  // the job before its first Follow Up Boss call), so a run that failed even
  // on its opening page still has a cursor worth resuming.
  it("resumes a real run that failed before it saved a single page", async () => {
    vi.mocked(getFubImportJob).mockResolvedValue(
      job({
        status: "failed",
        dry_run: false,
        error: "FUB 503",
        cursor: { phase: "people", next: null, offset: 0 }
      })
    );
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { status: "done" } });
    expect(runFubImportChunk).toHaveBeenCalledTimes(1);
  });

  it("refuses a job whose preview failed, which has nothing to resume", async () => {
    vi.mocked(getFubImportJob).mockResolvedValue(
      job({ status: "failed", dry_run: true, error: "bad key" })
    );
    const res = await run();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { message: "Run the dry run first, then start the import from its results." }
    });
    expect(runFubImportChunk).not.toHaveBeenCalled();
  });
});
