export function getMonthLabel(monthsBack: number, now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - monthsBack, 1);
  return d.toLocaleString("default", { month: "short" });
}

export function formatAdminLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function getLogBadgeVariant(status: string): "urgent" | "error" | "success" | "pending" {
  if (status === "urgent_alert") return "urgent";
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "pending";
}

/**
 * Badge variant for a `vps_inventory` row (fleet economics Phase B).
 * `available` is the state the pool exists for (an owned box waiting to be
 * adopted) so it gets the green; `retired` is a dead row kept for audit.
 */
export function getVpsInventoryBadgeVariant(state: string): "success" | "pending" | "neutral" {
  if (state === "available") return "success";
  if (state === "assigned") return "pending";
  return "neutral";
}
