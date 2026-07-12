/**
 * Admin action audit trail — BizBlasts' SecureLogger security-event pattern
 * on newCoworker's unified log sink: every destructive / sensitive admin API
 * route records WHO did WHAT to WHICH tenant in `system_logs` (source
 * "admin"), so the per-business SystemLogViewer and the fleet dashboards can
 * answer "who deleted / refunded / paused this client?" without grepping
 * server logs.
 *
 * Fire-and-forget by design (`recordSystemLog` never throws): auditing must
 * never take down the admin action it observes.
 */

import { recordSystemLog } from "@/lib/db/system-logs";

export const ADMIN_AUDIT_SOURCE = "admin";

export type AdminAuditInput = {
  /** The acting admin's email (from requireAdmin()); null if unresolvable. */
  adminEmail: string | null;
  /** Snake-case verb, e.g. "delete_client", "force_refund". */
  action: string;
  businessId?: string | null;
  /** Extra structured context persisted into the log payload. */
  detail?: Record<string, unknown>;
};

export async function logAdminAction(input: AdminAuditInput): Promise<void> {
  const adminEmail = input.adminEmail ?? "unknown-admin";
  await recordSystemLog({
    businessId: input.businessId ?? null,
    source: ADMIN_AUDIT_SOURCE,
    level: "info",
    event: `admin.${input.action}`,
    message: `${adminEmail} ran ${input.action.replaceAll("_", " ")}`,
    payload: { adminEmail, ...input.detail }
  });
}
