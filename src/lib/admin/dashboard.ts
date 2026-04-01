export function getMonthLabel(monthsBack: number, now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - monthsBack, 1);
  return d.toLocaleString("default", { month: "short" });
}

export function getLogBadgeVariant(status: string): "urgent" | "error" | "success" | "pending" {
  if (status === "urgent_alert") return "urgent";
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "pending";
}
