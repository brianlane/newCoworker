import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import {
  CLINIC_SHEET_TARGETS,
  CLINIC_SHEETS_BUSINESS_ID,
  CLINIC_SHEETS_SOURCE,
  type ClinicSheetTarget
} from "@/lib/clinic-sheets/config";
import { clinicSheetsKeyFromEnv, readClinicSheetTab } from "@/lib/clinic-sheets/read";
import { parseClinicSheetRows, type ClinicSheetPatient } from "@/lib/clinic-sheets/rows";
import { recordSystemLog } from "@/lib/db/system-logs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ClinicSheetPollResult = {
  configured: boolean;
  sheets: number;
  baselined: number;
  enqueued: number;
  failed: number;
};

type PollDeps = {
  keyJson?: string | null;
  fetchImpl?: typeof fetch;
  db?: Db;
  nowMs?: number;
  targets?: readonly ClinicSheetTarget[];
  enqueue?: typeof processWebhookFlowEvent;
  log?: typeof recordSystemLog;
};

/**
 * One pass over the clinic sheets. The first successful read of a sheet
 * marks every patient already on it as seen and does not call. A later row
 * with a new phone is handed to the clinic-sheet flow. A failed read,
 * including the robot being removed from the share, is logged and does not
 * move the baseline.
 */
export async function pollClinicSheets(deps: PollDeps = {}): Promise<ClinicSheetPollResult> {
  const log = deps.log ?? recordSystemLog;
  const targets = deps.targets ?? CLINIC_SHEET_TARGETS;
  const key = clinicSheetsKeyFromEnv(
    deps.keyJson === undefined ? process.env.CLINIC_SHEETS_SA_KEY_JSON : deps.keyJson
  );
  const result: ClinicSheetPollResult = {
    configured: Boolean(key),
    sheets: targets.length,
    baselined: 0,
    enqueued: 0,
    failed: 0
  };
  if (!key) {
    await log({
      businessId: CLINIC_SHEETS_BUSINESS_ID,
      source: "clinic_sheet",
      level: "error",
      event: "clinic_sheet_not_configured",
      message: "Clinic sheet reader has no service account key"
    });
    return result;
  }

  const db = deps.db ?? (await createSupabaseServiceClient());
  const enqueue = deps.enqueue ?? processWebhookFlowEvent;

  for (const target of targets) {
    const read = await readClinicSheetTab({
      key,
      spreadsheetId: target.spreadsheetId,
      sheetGid: target.sheetGid,
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs
    });
    if (!read.ok) {
      result.failed += 1;
      await log({
        businessId: CLINIC_SHEETS_BUSINESS_ID,
        source: "clinic_sheet",
        level: "error",
        event: "clinic_sheet_read_failed",
        message: readFailureMessage(read.status),
        payload: {
          spreadsheet_id: target.spreadsheetId,
          sheet_gid: target.sheetGid,
          clinic_name: target.clinicName,
          status: read.status
        }
      });
      continue;
    }

    const parsed = parseClinicSheetRows(read.grid.values, {
      require10Day: target.require10Day
    });
    if (!parsed.ok) {
      result.failed += 1;
      await log({
        businessId: CLINIC_SHEETS_BUSINESS_ID,
        source: "clinic_sheet",
        level: "error",
        event: "clinic_sheet_columns_unmatched",
        message:
          "Clinic sheet name or phone column was renamed, so this read was not applied",
        payload: {
          spreadsheet_id: target.spreadsheetId,
          sheet_gid: target.sheetGid,
          clinic_name: target.clinicName,
          tab_title: read.grid.title
        }
      });
      continue;
    }

    const baseline = await claimBaseline(db, target);
    if (baseline === "error") {
      result.failed += 1;
      await log({
        businessId: CLINIC_SHEETS_BUSINESS_ID,
        source: "clinic_sheet",
        level: "error",
        event: "clinic_sheet_baseline_failed",
        message: "Clinic sheet baseline could not be recorded",
        payload: {
          spreadsheet_id: target.spreadsheetId,
          sheet_gid: target.sheetGid,
          clinic_name: target.clinicName
        }
      });
      continue;
    }
    if (baseline === "new") {
      const stored = await rememberPhones(db, target.spreadsheetId, parsed.patients);
      if (!stored) {
        await db
          .from("clinic_sheet_baselines")
          .delete()
          .eq("spreadsheet_id", target.spreadsheetId)
          .eq("sheet_gid", target.sheetGid);
        result.failed += 1;
        await log({
          businessId: CLINIC_SHEETS_BUSINESS_ID,
          source: "clinic_sheet",
          level: "error",
          event: "clinic_sheet_baseline_failed",
          message: "Clinic sheet baseline could not be recorded",
          payload: {
            spreadsheet_id: target.spreadsheetId,
            sheet_gid: target.sheetGid,
            clinic_name: target.clinicName
          }
        });
        continue;
      }
      result.baselined += 1;
      await log({
        businessId: CLINIC_SHEETS_BUSINESS_ID,
        source: "clinic_sheet",
        level: "info",
        event: "clinic_sheet_baselined",
        message: `Clinic sheet baseline marked ${parsed.patients.length} existing patients as seen`,
        payload: {
          spreadsheet_id: target.spreadsheetId,
          sheet_gid: target.sheetGid,
          clinic_name: target.clinicName,
          patients: parsed.patients.length
        }
      });
      continue;
    }

    for (const patient of parsed.patients) {
      const fresh = await rememberPhone(db, target.spreadsheetId, patient.phoneE164);
      if (fresh === "seen") continue;
      if (fresh === "error") {
        result.failed += 1;
        await log({
          businessId: CLINIC_SHEETS_BUSINESS_ID,
          source: "clinic_sheet",
          level: "error",
          event: "clinic_sheet_seen_failed",
          message: "Clinic sheet could not record a new patient, so no call was handed off",
          payload: {
            spreadsheet_id: target.spreadsheetId,
            sheet_gid: target.sheetGid,
            clinic_name: target.clinicName
          }
        });
        continue;
      }
      await enqueue(CLINIC_SHEETS_BUSINESS_ID, {
        source: CLINIC_SHEETS_SOURCE,
        eventId: `clinic-sheet:${target.spreadsheetId}:${patient.phoneE164}`,
        data: {
          lead_name: patient.fullName,
          lead_phone: patient.phoneE164,
          clinic_name: target.clinicName,
          first_name: patient.firstName,
          last_name: patient.lastName
        }
      });
      result.enqueued += 1;
    }
  }
  return result;
}

function readFailureMessage(status: number): string {
  if (status === 403 || status === 404) {
    return "Clinic sheet read failed. The robot may have been removed from the share, or the spreadsheet is gone.";
  }
  return "Clinic sheet read failed";
}

async function claimBaseline(
  db: Db,
  target: ClinicSheetTarget
): Promise<"new" | "existing" | "error"> {
  const { error } = await db.from("clinic_sheet_baselines").insert({
    spreadsheet_id: target.spreadsheetId,
    sheet_gid: target.sheetGid
  });
  if (!error) return "new";
  if (error.code === "23505") return "existing";
  return "error";
}

async function rememberPhones(
  db: Db,
  spreadsheetId: string,
  patients: ClinicSheetPatient[]
): Promise<boolean> {
  if (patients.length === 0) return true;
  const { error } = await db.from("clinic_sheet_seen_phones").upsert(
    patients.map((patient) => ({
      spreadsheet_id: spreadsheetId,
      phone_e164: patient.phoneE164
    })),
    { onConflict: "spreadsheet_id,phone_e164", ignoreDuplicates: true }
  );
  return !error;
}

/** "new" when this phone was not already on the sheet. */
async function rememberPhone(
  db: Db,
  spreadsheetId: string,
  phoneE164: string
): Promise<"new" | "seen" | "error"> {
  const { error } = await db.from("clinic_sheet_seen_phones").insert({
    spreadsheet_id: spreadsheetId,
    phone_e164: phoneE164
  });
  if (!error) return "new";
  if (error.code === "23505") return "seen";
  return "error";
}
