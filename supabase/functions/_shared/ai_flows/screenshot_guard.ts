/**
 * Tenant guard for the `screenshot_path` scope var.
 *
 * The var is normally WORKER-written (`${business_id}/${run_id}/step-N.jpg`,
 * see storeScreenshot), but it lives in the same `scope.vars` namespace as
 * extraction outputs — an owner can name an extract field `screenshot_path`,
 * and extraction VALUES come from inbound text a stranger controls. The
 * consuming sinks (send_email attachment download, route_to_team MMS
 * signing) read the screenshots bucket with the service role, so without a
 * check a crafted value naming another tenant's `businessId/runId/...` path
 * could exfiltrate that tenant's screenshot. The UUIDs make such paths
 * unguessable in practice; this guard makes the invariant structural
 * instead of probabilistic: a path is usable only under THIS run's own
 * business prefix — anything else reads as "no screenshot".
 */

/** The run's screenshot path, or "" unless it sits under the tenant's prefix. */
export function tenantScreenshotPath(businessId: string, value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (!path.startsWith(`${businessId}/`)) return "";
  // Reject traversal-ish shapes outright; worker-written paths never carry them.
  if (path.includes("..") || path.includes("\\")) return "";
  return path;
}
