import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/google/bigquery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/bigquery")>();
  return { ...actual, bigQueryQuery: vi.fn(async () => []) };
});
vi.mock("@/lib/db/gemini-spend", () => ({
  replaceGeminiBilledWindow: vi.fn(async () => {})
}));
vi.mock("@/lib/admin/platform-settings", () => ({
  upsertAdminPlatformSetting: vi.fn(async () => {})
}));

import { runProductionGeminiBilledSync } from "@/lib/admin/gemini-billed-sync-runner";
import { GEMINI_BILLED_SYNC_STATUS_KEY } from "@/lib/admin/gemini-billed-sync";
import { bigQueryQuery } from "@/lib/google/bigquery";
import { replaceGeminiBilledWindow } from "@/lib/db/gemini-spend";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";

const ORIGINAL_ENV = { ...process.env };

const SA_KEY_JSON = JSON.stringify({
  client_email: "sync@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  project_id: "p"
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GCP_BILLING_SA_KEY_JSON;
  delete process.env.GCP_BILLING_EXPORT_TABLE;
  delete process.env.GEMINI_BILLING_SERVICE_DESCRIPTION;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("runProductionGeminiBilledSync", () => {
  it("records a not-configured skip when the env is absent", async () => {
    const status = await runProductionGeminiBilledSync();
    expect(status.configured).toBe(false);
    expect(bigQueryQuery).not.toHaveBeenCalled();
    expect(replaceGeminiBilledWindow).not.toHaveBeenCalled();
    expect(upsertAdminPlatformSetting).toHaveBeenCalledWith(
      GEMINI_BILLED_SYNC_STATUS_KEY,
      status
    );
  });

  it("wires the BigQuery client + window replace when fully configured", async () => {
    process.env.GCP_BILLING_SA_KEY_JSON = SA_KEY_JSON;
    process.env.GCP_BILLING_EXPORT_TABLE = "p.billing_export.gcp_billing_export_v1_X";
    vi.mocked(bigQueryQuery).mockResolvedValueOnce([
      { day: "2026-07-18", project_id: "p", cost: "1" }
    ]);
    const status = await runProductionGeminiBilledSync();
    expect(status).toMatchObject({ configured: true, ok: true, rows: 1 });
    expect(bigQueryQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.objectContaining({ project_id: "p" }),
        query: expect.stringContaining("service.description = 'Generative Language API'")
      })
    );
    expect(replaceGeminiBilledWindow).toHaveBeenCalledWith(expect.any(String), [
      { day: "2026-07-18", gcp_project_id: "p", cost_micros: 1_000_000 }
    ]);
  });

  it("honors a service-description override and treats a blank one as default", async () => {
    process.env.GCP_BILLING_SA_KEY_JSON = SA_KEY_JSON;
    process.env.GCP_BILLING_EXPORT_TABLE = "p.billing_export.gcp_billing_export_v1_X";
    process.env.GEMINI_BILLING_SERVICE_DESCRIPTION = "Vertex AI";
    await runProductionGeminiBilledSync();
    expect(vi.mocked(bigQueryQuery).mock.calls[0][0].query).toContain(
      "service.description = 'Vertex AI'"
    );

    process.env.GEMINI_BILLING_SERVICE_DESCRIPTION = "   ";
    await runProductionGeminiBilledSync();
    expect(vi.mocked(bigQueryQuery).mock.calls[1][0].query).toContain(
      "service.description = 'Generative Language API'"
    );
  });

  it("skips when the key parses but the table env is missing", async () => {
    process.env.GCP_BILLING_SA_KEY_JSON = SA_KEY_JSON;
    const status = await runProductionGeminiBilledSync();
    expect(status.configured).toBe(false);
    expect(bigQueryQuery).not.toHaveBeenCalled();
  });
});
