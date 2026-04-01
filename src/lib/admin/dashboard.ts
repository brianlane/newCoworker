export function getMonthLabel(monthsBack: number, now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - monthsBack, 1);
  return d.toLocaleString("default", { month: "short" });
}
