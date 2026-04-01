import { describe, expect, it } from "vitest";

import { formatAdminLabel, getLogBadgeVariant, getMonthLabel } from "@/lib/admin/dashboard";

describe("admin dashboard month labels", () => {
  it("pins the date to the first day before subtracting months", () => {
    const march31 = new Date("2026-03-31T12:00:00Z");

    expect(getMonthLabel(1, march31)).toBe("Feb");
    expect(getMonthLabel(2, march31)).toBe("Jan");
  });

  it("maps urgent alerts to a distinct badge variant", () => {
    expect(getLogBadgeVariant("urgent_alert")).toBe("urgent");
    expect(getLogBadgeVariant("error")).toBe("error");
    expect(getLogBadgeVariant("success")).toBe("success");
    expect(getLogBadgeVariant("queued")).toBe("pending");
  });

  it("replaces every underscore when formatting admin labels", () => {
    expect(formatAdminLabel("data_flow_check")).toBe("data flow check");
    expect(formatAdminLabel("urgent_alert")).toBe("urgent alert");
  });
});
