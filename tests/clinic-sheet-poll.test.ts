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
  ready: boolean;
  baselineInsertError: { code: string } | null;
  baselineReadError: { code: string } | null;
  readyUpdateError: { code: string } | null;
  updateMatchesNone: boolean;
  phoneUpsertError: { code: string } | null;
  phoneInsertError: { code: string } | null;
  phoneLookupError: { code: string } | null;
  lookupIgnoresSeen: boolean;
  seen: Set<string>;
  deletedBaseline: boolean;
};

function makeDb(state: DbState) {
  const filters = () => ({
    eq() {
      return filters();
    },
    maybeSingle() {
      if (state.baselineReadError) return { data: null, error: state.baselineReadError };
      if (!state.baseline) return { data: null, error: null };
      return { data: { ready: state.ready }, error: null };
    }
  });
  return {
    from(table: string) {
      if (table === "clinic_sheet_baselines") {
        return {
          insert() {
            if (state.baselineInsertError) return { error: state.baselineInsertError };
            if (state.baseline) return { error: { code: "23505" } };
            state.baseline = true;
            state.ready = false;
            return { error: null };
          },
          select() {
            return filters();
          },
          update() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      select() {
                        if (state.readyUpdateError) return { error: state.readyUpdateError, data: null };
                        if (state.updateMatchesNone) return { error: null, data: [] };
                        state.ready = true;
                        return { error: null, data: [{ spreadsheet_id: "sheet-1" }] };
                      }
                    };
                  }
                };
              }
            };
          },
          delete() {
            const chain = {
              eq() {
                return chain;
              },
              then(resolve: (value: { error: null }) => void) {
                if (!state.ready) {
                  state.baseline = false;
                  state.ready = false;
                  state.deletedBaseline = true;
                }
                resolve({ error: null });
              }
            };
            return chain;
          }
        };
      }
      return {
        upsert() {
          return { error: state.phoneUpsertError };
        },
        select() {
          return {
            eq() {
              return {
                eq(_column: string, phone: string) {
                  return {
                    maybeSingle() {
                      if (state.phoneLookupError) {
                        return { data: null, error: state.phoneLookupError };
                      }
                      if (state.lookupIgnoresSeen) return { data: null, error: null };
                      return {
                        data: state.seen.has(phone) ? { phone_e164: phone } : null,
                        error: null
                      };
                    }
                  };
                }
              };
            }
          };
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
    ready: false,
    baselineInsertError: null,
    baselineReadError: null,
    readyUpdateError: null,
    updateMatchesNone: false,
    phoneUpsertError: null,
    phoneInsertError: null,
    phoneLookupError: null,
    lookupIgnoresSeen: false,
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
    const dbState = state({ baseline: true, ready: true });
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
          lead_email: "",
          clinic_name: "Eros Vitality"
        })
      }),
      expect.anything(),
      { origin: "internal" }
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

  it("does not mark a phone seen when the handoff throws", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ baseline: true, ready: true });
    vi.mocked(processWebhookFlowEvent).mockRejectedValue(new Error("flow down"));
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(result.failed).toBe(1);
    expect(dbState.seen.size).toBe(0);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_handoff_failed" })
    );
  });

  it("does not call patients while a baseline is still unfinished", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ baseline: true, ready: false });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.baselined).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(dbState.ready).toBe(true);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("logs when the handoff succeeded but the phone row could not be stored", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state({ baseline: true, ready: true, phoneInsertError: { code: "XX000" } })) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(result.failed).toBe(1);
    expect(processWebhookFlowEvent).toHaveBeenCalled();
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_seen_failed" })
    );
  });

  it("does not mark a phone seen when the tier gate refuses the handoff", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 0,
      flowsEvaluated: 0,
      flowsMatched: 0,
      tierBlocked: true
    });
    const dbState = state({ baseline: true, ready: true });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(dbState.seen.size).toBe(0);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_handoff_failed" })
    );
  });

  it("fails when an existing baseline row cannot be read", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(state({ baseline: true, baselineReadError: { code: "XX000" } })) as never,
      log: recordSystemLog
    });
    expect(result.failed).toBe(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "clinic_sheet_baseline_failed" })
    );
  });

  it("drops a new baseline when marking it ready fails", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ readyUpdateError: { code: "XX000" } });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(result.baselined).toBe(0);
    expect(dbState.deletedBaseline).toBe(true);
  });

  it("logs when it cannot tell whether a phone was already sent", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(
        state({ baseline: true, ready: true, phoneLookupError: { code: "XX000" } })
      ) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.failed).toBe(1);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("leaves an unfinished baseline in place when finishing it fails", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ baseline: true, ready: false, phoneUpsertError: { code: "XX000" } });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog
    });
    expect(result.baselined).toBe(0);
    expect(result.failed).toBe(1);
    expect(dbState.deletedBaseline).toBe(false);
    expect(dbState.baseline).toBe(true);
  });

  it("does not mark a phone seen when no flow matched", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 0,
      flowsEvaluated: 1,
      flowsMatched: 0
    });
    const dbState = state({ baseline: true, ready: true });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(dbState.seen.size).toBe(0);
  });

  it("records a duplicate handoff without counting another call", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 0,
      flowsEvaluated: 1,
      flowsMatched: 1
    });
    const dbState = state({ baseline: true, ready: true });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(0);
    expect(dbState.seen.has("+14805550100")).toBe(true);
  });

  it("treats a phone insert conflict as already seen", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({
      baseline: true,
      ready: true,
      lookupIgnoresSeen: true,
      seen: new Set(["+14805550100"])
    });
    const result = await pollClinicSheets({
      keyJson: "key",
      targets: [TARGET],
      db: makeDb(dbState) as never,
      log: recordSystemLog,
      enqueue: processWebhookFlowEvent
    });
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("does not report a baseline when the ready update matches no row", async () => {
    vi.mocked(readClinicSheetTab).mockResolvedValue({
      ok: true,
      grid: { title: "Tab", values: GRID }
    });
    const dbState = state({ updateMatchesNone: true });
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
