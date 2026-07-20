/**
 * Production wiring for the Gemini billed-actuals sync — shared by the
 * internal cron route (/api/internal/platform-cost-sync, where it rides the
 * daily vendor sync) and the admin Sync-now route (/api/admin/cost-sync) so
 * the two can never drift.
 *
 * Env (all optional until the operator finishes the one-time setup in
 * docs/GEMINI-SPEND.md — unconfigured records a skip, never an error):
 *   GCP_BILLING_SA_KEY_JSON             — service-account key JSON
 *   GCP_BILLING_EXPORT_TABLE            — `project.dataset.table` of the
 *                                         Cloud Billing standard export
 *   GEMINI_BILLING_SERVICE_DESCRIPTION  — billing service filter override
 */

import { bigQueryQuery, parseGcpServiceAccountKey } from "@/lib/google/bigquery";
import { replaceGeminiBilledWindow } from "@/lib/db/gemini-spend";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  GEMINI_BILLED_SYNC_STATUS_KEY,
  runGeminiBilledSync,
  type GeminiBilledSyncStatus
} from "@/lib/admin/gemini-billed-sync";

export async function runProductionGeminiBilledSync(): Promise<GeminiBilledSyncStatus> {
  const key = parseGcpServiceAccountKey(process.env.GCP_BILLING_SA_KEY_JSON);
  return runGeminiBilledSync({
    exportTableId: process.env.GCP_BILLING_EXPORT_TABLE ?? null,
    serviceDescription: process.env.GEMINI_BILLING_SERVICE_DESCRIPTION?.trim() || undefined,
    runQuery: key === null ? null : (query) => bigQueryQuery({ key, query }),
    replaceGeminiBilledWindow,
    recordStatus: (status) => upsertAdminPlatformSetting(GEMINI_BILLED_SYNC_STATUS_KEY, status)
  });
}
