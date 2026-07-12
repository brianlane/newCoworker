/**
 * Production wiring for the platform cost sync — shared by the internal
 * cron route (/api/internal/platform-cost-sync) and the admin Sync-now
 * route (/api/admin/cost-sync) so the two can never drift.
 */

import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import {
  listBusinessVpsAssignments,
  listTenantDids,
  replaceHostingerVpsCosts,
  replaceTelnyxCostWindow
} from "@/lib/db/platform-costs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  runPlatformCostSync,
  type PlatformCostSyncStatus,
  type TelnyxSyncRange
} from "@/lib/admin/cost-sync";

export async function runProductionPlatformCostSync(options?: {
  telnyxRange?: TelnyxSyncRange;
}): Promise<PlatformCostSyncStatus> {
  const hostinger = new HostingerClient({
    /* c8 ignore next 2 -- trivial env-default fallbacks */
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });

  return runPlatformCostSync(
    {
      telnyxApiKey: process.env.TELNYX_API_KEY?.trim() || null,
      listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
      listVirtualMachines: () => hostinger.listVirtualMachines(),
      listTenantDids,
      listBusinessVpsAssignments,
      replaceTelnyxCostWindow,
      replaceHostingerVpsCosts,
      recordStatus: (status) =>
        upsertAdminPlatformSetting(PLATFORM_COST_SYNC_STATUS_KEY, status)
    },
    { telnyxRange: options?.telnyxRange }
  );
}
