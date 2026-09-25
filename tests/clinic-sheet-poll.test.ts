import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clinic-sheets/read", () => ({
  clinicSheetsKeyFromEnv: vi.fn(),
  readClinicSheetTab: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn()
}));

import { pollClinicSheets } from "@/lib/clinic-sheets/poll";
import { clinicSheetsKeyFromEnv, readClinicSheetTab } from "@/lib/clinic-sheets/read";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { recordSystemLog } from "@/lib/db/system-logs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { ClinicSheetTarget } from "@/lib/clinic-sheets/config";

const TARGET: ClinicSheetTarget = {
  spreadsheetId: "sheet-1",
  sheetGid: 7,
  clinicName: "Eros Vitality",
  require10Day: false
};

const GRID = [
  ["First Name", "Last Name", "Phone"],
  ["Ada", "Lovelace", "4805550100"]
];

type DbState = {
  baseline: boolean;
  baselineInsertError: { code: string } | null;
  phoneUpsertError: { code: string } | null;
  phoneInsertError: { code: string } | null;
  seen: Set<string>;
  deletedBaseline: boolean;
};

function makeDb(state: DbState) {
  return {
    from(table: string) {
      if (table === "clinic_sheet_baselines") {
        return {
          insert() {
            if (state.baselineInsertError) return { error: state.baselineInsertError };
            if (state.baseline) return { error: { code: "23505" } };
            state.baseline = true;
            return { error: null };
          },
          delete() {
            return {
              eq() {
                return {
                  eq() {
                    state.baseline = false;
                    state.deletedBaseline = true;
                    return { error: null };
                  }
                };
              }
            };
          }
        };
      }
      return {
        upsert() {
          return { error: state.phoneUpsertError };
        },
        insert(row: { phone_e164: string }) {
          if (state.phoneInsertError) return { error: state.phoneInsertError };
          if (state.seen.has(row.phone_e164)) return { error: { code: "23505" } };
          state.seen.add(row.phone_e164);
          return { error: null };
        }
      };
    }
  };
}

function state(partial: Partial<DbState> = {}): DbState {
  return {
    baseline: false,
    baselineInsertError: null,
    phoneUpsertError: null,
    phoneInsertError: null,
    seen: new Set(),
    deletedBaseline: false,
    ...partial
  };
}

describe("pollClinicSheets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clinicSheetsKeyFromEnv).mockImplementation((raw) =>
      raw ? { client_email: "c@x", private_key: "k", project_id: "p" } : null
    );
    vi.mocked(recordSystemLog).mockResolvedValue(undefined);
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 1,
      flowsEvaluated: 1,
      flowsMatched: 1
    });
  });

  it("logs and skips when the robot key is missing", async () => {
    const result = await pollClinicSheets({ keyJson: null, log: recordSystemLog });
    expect(result.configured).toBe(false);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_not_configured", level: "error" })
    );
    expect(readClinicSheetTab).not.toHaveBeenCalled();
  });

  it("reads the key from the environment when none is passed", async () => {
    process.env.CLINIC_SHEETS_SA_KEY_JSON = "present";
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: false,
      status: 500,
      detail: "down"
    });
    const dbState = state({ baseline: true });
    await pollClinicSheets({
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(clinicSheetsKeyFromEnv).toHaveBeenCalledWith("present");
    delete process.env.CLINIC_SHEETS_SA_KEY_JSON;
  });

  it("logs a removed share and does not baseline", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: false,
      status: 403,
      detail: "permission"
    });
    const dbState = state();
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(result.failed).toBe(1);
    expect(dbState.baseline).toBe(false);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "clinic_sheet_read_failed",
        message: expect.stringContaining("removed from the share")
      })
    );
  });

  it("logs a generic read failure", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({ ok: false, status: 500, detail: "down" });
    await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state()) as never,
      log: recordSystemLog
    });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "clinic_sheet_read_failed",
        message: "Clinic sheet read failed"
      })
    );
  });

  it("logs a renamed name or phone column and does not baseline", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "New Patients", values: [["Given", "Family", "Tel"]] }
    });
    const dbState = state();
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(result.failed).toBe(1);
    expect(dbState.baseline).toBe(false);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_columns_unmatched" })
    );
  });

  it("logs when the baseline row cannot be written", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state({ baselineInsertError: { code: "XX000" } })) as never,
      log: recordSystemLog
    });
    expect(result.failed).toBe(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_baseline_failed" })
    );
  });

  it("baselines existing patients and does not hand them to the flow", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state()) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.baselined).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_baselined" })
    );
  });

  it("drops the baseline claim when the seen-phone write fails", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ phoneUpsertError: { code: "XX000" } });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(result.baselined).toBe(0);
    expect(result.failed).toBe(1);
    expect(dbState.deletedBaseline).toBe(true);
  });

  it("baselines an empty sheet", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: {
        title: "Tab",
        values: [["First Name", "Last Name", "Phone"]]
      }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state()) as never,
      log: recordSystemLog
    });
    expect(result.baselined).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("hands a phone that appears after the baseline to the clinic flow once", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ baseline: true });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(1);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      "d2d421a8-47ef-4a1d-b8af-7e86a02a95f1",
      expect.objectContaining({
        source: "clinic_google_sheet",
        eventId: "clinic-sheet:sheet-1:+14805550100",
        data: expect.objectContaining({
          lead_name: "Ada Lovelace",
          clinic_name: "Eros Vitality"
        })
      })
    );

    vi.mocked(processWebhookFlowEvent).mockClear();
    const again = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(again.enqueued).toBe(0);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("does not hand off a patient when the seen-phone write fails", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state({ baseline: true, phoneInsertError: { code: "XX000" } })) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(result.failed).toBe(1);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_seen_failed" })
    );
  });

  it("uses the default database and logger when they are not injected", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: false,
      status: 404,
      detail: "missing"
    });
    const db = makeDb(state());
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await pollClinicSheets({ keyJson: "key", targets: [TARGET] });
    expect(result.failed).toBe(1);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(recordSystemLog).toHaveBeenCalled();
  });
});
