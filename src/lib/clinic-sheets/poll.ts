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
      await logBaselineFailed(log, target);
      continue;
    }
    if (baseline === "new" || baseline === "finish") {
      const stored = await completeBaseline(db, target.spreadsheetId, target.sheetGid, parsed.patients);
        if (!stored) {
          if (baseline === "new") {
            await db
              .from("clinic_sheet_baselines")
              .delete()
              .eq("spreadsheet_id", target.spreadsheetId)
              .eq("sheet_gid", target.sheetGid)
              .eq("ready", false);
          }
        result.failed += 1;
        await logBaselineFailed(log, target);
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
      const already = await phoneAlreadySeen(db, target.spreadsheetId, patient.phoneE164);
      if (already === "error") {
        result.failed += 1;
        await log({
          businessId: CLINIC_SHEETS_BUSINESS_ID,
          source: "clinic_sheet",
          level: "error",
          event: "clinic_sheet_seen_failed",
          message: "Clinic sheet could not check whether a phone was already sent",
          payload: {
            spreadsheet_id: target.spreadsheetId,
            sheet_gid: target.sheetGid,
            clinic_name: target.clinicName
          }
        });
        continue;
      }
      if (already) continue;
      let handed: Awaited<ReturnType<typeof processWebhookFlowEvent>>;
      try {
        handed = await enqueue(
          CLINIC_SHEETS_BUSINESS_ID,
          {
            source: CLINIC_SHEETS_SOURCE,
            eventId: `clinic-sheet:${target.spreadsheetId}:${patient.phoneE164}`,
            data: {
              lead_name: patient.fullName,
              lead_phone: patient.phoneE164,
              lead_email: patient.email,
              clinic_name: target.clinicName,
              first_name: patient.firstName,
              last_name: patient.lastName
            }
          },
          db,
          { origin: "internal" }
        );
      } catch {
        result.failed += 1;
        await logHandoffFailed(log, target);
        continue;
      }
      if (handed.tierBlocked || (handed.enqueued === 0 && handed.flowsMatched === 0)) {
        result.failed += 1;
        await logHandoffFailed(log, target);
        continue;
      }
      const fresh = await rememberPhone(db, target.spreadsheetId, patient.phoneE164);
      if (fresh === "error") {
        result.failed += 1;
        await log({
          businessId: CLINIC_SHEETS_BUSINESS_ID,
          source: "clinic_sheet",
          level: "error",
          event: "clinic_sheet_seen_failed",
          message: "Clinic sheet handed off a patient but could not record the phone",
          payload: {
            spreadsheet_id: target.spreadsheetId,
            sheet_gid: target.sheetGid,
            clinic_name: target.clinicName
          }
        });
        continue;
      }
      if (handed.enqueued > 0) result.enqueued += 1;
    }
  }
  return result;
}

function logBaselineFailed(
  log: typeof recordSystemLog,
  target: ClinicSheetTarget
): Promise<void> {
  return log({
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
}

function logHandoffFailed(
  log: typeof recordSystemLog,
  target: ClinicSheetTarget
): Promise<void> {
  return log({
    businessId: CLINIC_SHEETS_BUSINESS_ID,
    source: "clinic_sheet",
    level: "error",
    event: "clinic_sheet_handoff_failed",
    message: "Clinic sheet could not hand a new patient to the call flow, so the phone was not marked seen",
    payload: {
      spreadsheet_id: target.spreadsheetId,
      sheet_gid: target.sheetGid,
      clinic_name: target.clinicName
    }
  });
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
): Promise<"new" | "finish" | "existing" | "error"> {
  const { error } = await db.from("clinic_sheet_baselines").insert({
    spreadsheet_id: target.spreadsheetId,
    sheet_gid: target.sheetGid,
    ready: false
  });
  if (!error) return "new";
  if (error.code !== "23505") return "error";
  const { data, error: readError } = await db
    .from("clinic_sheet_baselines")
    .select("ready")
    .eq("spreadsheet_id", target.spreadsheetId)
    .eq("sheet_gid", target.sheetGid)
    .maybeSingle();
  if (readError || !data) return "error";
  return data.ready ? "existing" : "finish";
}

async function completeBaseline(
  db: Db,
  spreadsheetId: string,
  sheetGid: number,
  patients: ClinicSheetPatient[]
): Promise<boolean> {
  const stored = await rememberPhones(db, spreadsheetId, patients);
  if (!stored) return false;
  const { data, error } = await db
    .from("clinic_sheet_baselines")
    .update({ ready: true })
    .eq("spreadsheet_id", spreadsheetId)
    .eq("sheet_gid", sheetGid)
    .select("spreadsheet_id");
  return !error && Array.isArray(data) && data.length > 0;
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
async function phoneAlreadySeen(
  db: Db,
  spreadsheetId: string,
  phoneE164: string
): Promise<boolean | "error"> {
  const { data, error } = await db
    .from("clinic_sheet_seen_phones")
    .select("phone_e164")
    .eq("spreadsheet_id", spreadsheetId)
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (error) return "error";
  return Boolean(data);
}

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
