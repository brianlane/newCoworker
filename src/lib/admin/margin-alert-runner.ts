/**
 * Production wiring for the margin alert (config from
 * admin_platform_settings, economics from the fleet margin loader, digest
 * via the ops inbox) — invoked by the internal platform-cost-sync route
 * right after a sync lands the freshest vendor numbers.
 */

import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import { sendOpsMarginAlertEmail } from "@/lib/email/ops-notify";
import {
  MARGIN_ALERT_SETTINGS_KEY,
  runMarginAlert,
  type MarginAlertRunResult
} from "@/lib/admin/margin-alert";

export async function runProductionMarginAlert(): Promise<MarginAlertRunResult> {
  return runMarginAlert({
    getConfigRaw: () => getAdminPlatformSetting(MARGIN_ALERT_SETTINGS_KEY),
    loadEconomics: async () => {
      const data = await loadFleetMargins();
      return {
        economics: data.economics,
        businessNames: new Map(data.businesses.map((b) => [b.id, b.name]))
      };
    },
    sendAlertEmail: (input) => sendOpsMarginAlertEmail(input)
  });
}
