import { describe, it, expect, vi } from "vitest";
import {
  BILLED_SYNC_WINDOW_DAYS,
  DEFAULT_GEMINI_BILLING_SERVICE,
  GEMINI_BILLED_SYNC_STATUS_KEY,
  billedRowsFromQuery,
  billedWindowStartDayUtc,
  buildBilledQuery,
  parseGeminiBilledSyncStatus,
  runGeminiBilledSync,
  validateExportTableId,
  type GeminiBilledSyncDeps,
  type GeminiBilledSyncStatus
} from "@/lib/admin/gemini-billed-sync";

const NOW = new Date("2026-07-19T18:00:00.000Z");
const TABLE = "my-project.billing_export.gcp_billing_export_v1_0188_6BF5_7C34";

function baseDeps(overrides: Partial<GeminiBilledSyncDeps> = {}): GeminiBilledSyncDeps {
  return {
    exportTableId: TABLE,
    runQuery: vi.fn(async () => []),
    replaceGeminiBilledWindow: vi.fn(async () => {}),
    recordStatus: vi.fn(async () => {}),
    now: NOW,
    ...overrides
  };
}

describe("parseGeminiBilledSyncStatus", () => {
  it("returns null for null, non-objects, and missing lastSyncAt", () => {
    expect(parseGeminiBilledSyncStatus(null)).toBeNull();
    expect(parseGeminiBilledSyncStatus("x")).toBeNull();
    expect(parseGeminiBilledSyncStatus({ ok: true })).toBeNull();
  });

  it("round-trips a full status and defaults unusable fields", () => {
    const status: GeminiBilledSyncStatus = {
      lastSyncAt: "2026-07-19T18:00:00.000Z",
      configured: true,
      ok: false,
      rows: 7,
      error: "boom",
      windowStartDay: "2026-06-14"
    };
    expect(parseGeminiBilledSyncStatus(status)).toEqual(status);
    expect(parseGeminiBilledSyncStatus({ lastSyncAt: status.lastSyncAt })).toEqual({
      lastSyncAt: status.lastSyncAt,
      configured: false,
      ok: false,
      rows: 0,
      error: null,
      windowStartDay: null
    });
  });
});

describe("validateExportTableId", () => {
  it("accepts project.dataset.table and trims whitespace", () => {
    expect(validateExportTableId(` ${TABLE} `)).toBe(TABLE);
  });

  it("rejects missing/partial/injection-shaped values", () => {
    expect(validateExportTableId(null)).toBeNull();
    expect(validateExportTableId(undefined)).toBeNull();
    expect(validateExportTableId("")).toBeNull();
    expect(validateExportTableId("dataset.table")).toBeNull();
    expect(validateExportTableId("a.b.c.d")).toBeNull();
    expect(validateExportTableId("p.d.t` WHERE 1=1 --")).toBeNull();
  });
});

describe("buildBilledQuery", () => {
  it("inlines the validated table, the escaped service, and the window day", () => {
    const query = buildBilledQuery(TABLE, DEFAULT_GEMINI_BILLING_SERVICE, "2026-06-14");
    expect(query).toContain(`FROM \`${TABLE}\``);
    expect(query).toContain("service.description = 'Generative Language API'");
    expect(query).toContain(">= '2026-06-14'");
    expect(query).toContain("GROUP BY day, project_id");
  });

  it("escapes quotes and backslashes in the service description", () => {
    const query = buildBilledQuery(TABLE, "O'Brien \\ Service", "2026-06-14");
    expect(query).toContain("service.description = 'O\\'Brien \\\\ Service'");
  });
});

describe("billedRowsFromQuery", () => {
  it("maps rows to micro-USD inserts, defaulting a null project to unknown", () => {
    expect(
      billedRowsFromQuery([
        { day: "2026-07-18", project_id: "gen-lang-client-1", cost: "1.23" },
        { day: "2026-07-19", project_id: null, cost: "0.005" }
      ])
    ).toEqual([
      { day: "2026-07-18", gcp_project_id: "gen-lang-client-1", cost_micros: 1_230_000 },
      { day: "2026-07-19", gcp_project_id: "unknown", cost_micros: 5_000 }
    ]);
  });

  it("drops rows with an unparseable day or cost", () => {
    expect(
      billedRowsFromQuery([
        { day: null, project_id: "p", cost: "1" },
        { day: "not-a-day", project_id: "p", cost: "1" },
        { day: "2026-07-18", project_id: "p", cost: null },
        { day: "2026-07-18", project_id: "p", cost: "NaN-ish" }
      ])
    ).toEqual([]);
  });
});

describe("billedWindowStartDayUtc", () => {
  it("returns the UTC day the default window back (covers the 90-day admin view)", () => {
    expect(BILLED_SYNC_WINDOW_DAYS).toBe(95);
    expect(billedWindowStartDayUtc(NOW)).toBe("2026-04-15");
    expect(billedWindowStartDayUtc(NOW, 7)).toBe("2026-07-12");
  });
});

describe("runGeminiBilledSync", () => {
  it("replaces the rolling window with the queried rows and records ok", async () => {
    const runQuery = vi.fn(async (query: string) => {
      expect(query).toContain(`FROM \`${TABLE}\``);
      return [{ day: "2026-07-18", project_id: "prod", cost: "2.5" }];
    });
    const deps = baseDeps({ runQuery });
    const status = await runGeminiBilledSync(deps);
    expect(status).toEqual({
      lastSyncAt: NOW.toISOString(),
      configured: true,
      ok: true,
      rows: 1,
      error: null,
      windowStartDay: "2026-04-15"
    });
    expect(deps.replaceGeminiBilledWindow).toHaveBeenCalledWith("2026-04-15", [
      { day: "2026-07-18", gcp_project_id: "prod", cost_micros: 2_500_000 }
    ]);
    expect(deps.recordStatus).toHaveBeenCalledWith(status);
    expect(GEMINI_BILLED_SYNC_STATUS_KEY).toBe("gemini_billed_sync_status");
  });

  it("passes a custom service description into the query", async () => {
    const runQuery = vi.fn(async (_query: string) => []);
    await runGeminiBilledSync(baseDeps({ runQuery, serviceDescription: "Vertex AI" }));
    expect(vi.mocked(runQuery).mock.calls[0][0]).toContain(
      "service.description = 'Vertex AI'"
    );
  });

  it("records a skip (configured=false, still ok=false is NOT set) when the table is missing", async () => {
    const deps = baseDeps({ exportTableId: null });
    const status = await runGeminiBilledSync(deps);
    expect(status.configured).toBe(false);
    expect(status.ok).toBe(false);
    expect(status.error).toBeNull();
    expect(status.windowStartDay).toBeNull();
    expect(deps.runQuery).not.toHaveBeenCalled();
    expect(deps.replaceGeminiBilledWindow).not.toHaveBeenCalled();
  });

  it("records a skip when the service-account key is missing (runQuery null)", async () => {
    const deps = baseDeps({ runQuery: null });
    const status = await runGeminiBilledSync(deps);
    expect(status.configured).toBe(false);
    expect(status.error).toBeNull();
    expect(deps.replaceGeminiBilledWindow).not.toHaveBeenCalled();
  });

  it("records a configured failure with the error message (Error and non-Error)", async () => {
    const errStatus = await runGeminiBilledSync(
      baseDeps({
        runQuery: vi.fn(async () => {
          throw new Error("bq down");
        })
      })
    );
    expect(errStatus).toMatchObject({ configured: true, ok: false, error: "bq down", rows: 0 });

    const strStatus = await runGeminiBilledSync(
      baseDeps({
        replaceGeminiBilledWindow: vi.fn(async () => {
          throw "replace-string-failure";
        })
      })
    );
    expect(strStatus).toMatchObject({ ok: false, error: "replace-string-failure" });
  });

  it("defaults `now` to the current time", async () => {
    const status = await runGeminiBilledSync(baseDeps({ now: undefined }));
    expect(Date.parse(status.lastSyncAt)).toBeGreaterThan(0);
  });
});
