/**
 * Tests for the Business-profile lib: hours parsing/formatting, the
 * markdown rendering that feeds every prompt composer, and the
 * refresh-into-business_configs helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/configs", () => ({ patchBusinessConfig: vi.fn() }));

import {
  BUSINESS_HOURS_DAYS,
  businessTypeLabel,
  formatHoursTime,
  isValidHoursTime,
  parseBusinessHours,
  renderBusinessProfileMd
} from "@/lib/business-profile/profile";
import { refreshBusinessProfileMd } from "@/lib/business-profile/refresh";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";

describe("isValidHoursTime", () => {
  it("accepts 24h HH:MM values", () => {
    expect(isValidHoursTime("00:00")).toBe(true);
    expect(isValidHoursTime("09:30")).toBe(true);
    expect(isValidHoursTime("23:59")).toBe(true);
  });

  it("rejects out-of-range and malformed values", () => {
    expect(isValidHoursTime("24:00")).toBe(false);
    expect(isValidHoursTime("12:60")).toBe(false);
    expect(isValidHoursTime("9:00")).toBe(false);
    expect(isValidHoursTime("noon")).toBe(false);
    expect(isValidHoursTime("")).toBe(false);
  });
});

describe("formatHoursTime", () => {
  it("formats morning, noon, afternoon, and midnight correctly", () => {
    expect(formatHoursTime("09:00")).toBe("9:00 AM");
    expect(formatHoursTime("12:00")).toBe("12:00 PM");
    expect(formatHoursTime("13:30")).toBe("1:30 PM");
    expect(formatHoursTime("00:15")).toBe("12:15 AM");
  });
});

describe("parseBusinessHours", () => {
  it("returns null for non-objects, arrays, and null", () => {
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours("mon")).toBeNull();
    expect(parseBusinessHours(42)).toBeNull();
    expect(parseBusinessHours([{ mon: null }])).toBeNull();
    expect(parseBusinessHours(undefined)).toBeNull();
  });

  it("keeps valid open/close windows and explicit closed days", () => {
    const parsed = parseBusinessHours({
      mon: { open: "09:00", close: "17:00" },
      tue: null
    });
    expect(parsed).toEqual({ mon: { open: "09:00", close: "17:00" }, tue: null });
  });

  it("drops malformed day entries without throwing (hand-edited rows)", () => {
    const parsed = parseBusinessHours({
      mon: { open: "9am", close: "17:00" },
      tue: { open: "09:00" },
      wed: "closed",
      thu: [{ open: "09:00", close: "17:00" }],
      fri: { open: "10:00", close: "14:00" }
    });
    expect(parsed).toEqual({ fri: { open: "10:00", close: "14:00" } });
  });

  it("returns null when nothing usable remains", () => {
    expect(parseBusinessHours({ mon: "x", sun: { open: "bad" } })).toBeNull();
    expect(parseBusinessHours({ unknown_day: null })).toBeNull();
    expect(parseBusinessHours({})).toBeNull();
  });

  it("covers every known day key", () => {
    const all: Record<string, unknown> = {};
    for (const day of BUSINESS_HOURS_DAYS) all[day] = { open: "08:00", close: "12:00" };
    const parsed = parseBusinessHours(all);
    expect(parsed && Object.keys(parsed)).toHaveLength(7);
  });
});

describe("businessTypeLabel", () => {
  it("maps known slugs to their catalog label", () => {
    expect(businessTypeLabel("real_estate")).toBe("Real Estate");
    expect(businessTypeLabel("hvac_services")).toBe("HVAC Services");
  });

  it("humanizes unknown slugs instead of leaking snake_case into the prompt", () => {
    expect(businessTypeLabel("goat_yoga")).toBe("Goat Yoga");
    expect(businessTypeLabel("solo")).toBe("Solo");
  });

  it("tolerates stray underscores", () => {
    expect(businessTypeLabel("_odd__slug_")).toBe("Odd Slug");
  });
});

describe("renderBusinessProfileMd", () => {
  it("returns empty string when no facts are set (prompt composers skip the section)", () => {
    expect(renderBusinessProfileMd({ name: "" })).toBe("");
    expect(
      renderBusinessProfileMd({
        name: "  ",
        businessType: "",
        phone: null,
        address: "   ",
        timezone: undefined,
        hours: null
      })
    ).toBe("");
  });

  it("renders all facts with labeled industry and 12h hours", () => {
    const md = renderBusinessProfileMd({
      name: "Sunrise Realty",
      ownerName: "Amy Laidlaw",
      businessType: "real_estate",
      phone: "+1 602 555 0147",
      address: "123 Main St, Phoenix, AZ",
      timezone: "America/Phoenix",
      hours: {
        mon: { open: "09:00", close: "17:00" },
        sat: null
      }
    });
    expect(md).toContain("## Business profile");
    expect(md).toContain("- Business name: Sunrise Realty");
    expect(md).toContain("- Owner / primary contact: Amy Laidlaw");
    expect(md).toContain("- Industry: Real Estate");
    expect(md).toContain("- Phone: +1 602 555 0147");
    expect(md).toContain("- Address: 123 Main St, Phoenix, AZ");
    expect(md).toContain("- Timezone: America/Phoenix");
    expect(md).toContain("### Business hours");
    expect(md).toContain("- Monday: 9:00 AM to 5:00 PM");
    expect(md).toContain("- Saturday: Closed");
    // Days the owner never specified are omitted, not claimed closed.
    expect(md).not.toContain("- Sunday");
  });

  it("renders hours-only profiles (facts block omitted)", () => {
    const md = renderBusinessProfileMd({
      name: "",
      hours: { sun: { open: "10:00", close: "14:00" } }
    });
    expect(md).toContain("### Business hours");
    expect(md).toContain("- Sunday: 10:00 AM to 2:00 PM");
    expect(md).not.toContain("- Business name:");
  });

  it("renders facts-only profiles (hours block omitted)", () => {
    const md = renderBusinessProfileMd({ name: "Acme", hours: {} });
    expect(md).toContain("- Business name: Acme");
    expect(md).not.toContain("### Business hours");
  });
});

describe("refreshBusinessProfileMd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({} as never);
  });

  it("renders from the current businesses row and patches profile_md", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: "biz-1",
      name: "Acme Plumbing",
      owner_name: "Pat Piper",
      business_type: "plumbing",
      phone: "+16025550147",
      address: "9 Pipe Rd",
      timezone: "America/Phoenix",
      business_hours: { mon: { open: "08:00", close: "16:00" } }
    } as never);
    const db = { tag: "client" };

    const md = await refreshBusinessProfileMd("biz-1", db as never);

    expect(md).toContain("- Owner / primary contact: Pat Piper");
    expect(md).toContain("- Industry: Plumbing");
    expect(md).toContain("- Monday: 8:00 AM to 4:00 PM");
    expect(patchBusinessConfig).toHaveBeenCalledWith("biz-1", { profile_md: md }, db);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("writes an empty profile_md when the row has no profile facts (clears stale content)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: "biz-2",
      name: "",
      business_type: null,
      phone: null,
      address: null,
      timezone: null,
      business_hours: null
    } as never);

    const md = await refreshBusinessProfileMd("biz-2");

    expect(md).toBe("");
    expect(patchBusinessConfig).toHaveBeenCalledWith("biz-2", { profile_md: "" }, {});
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("handles rows where optional fields are absent entirely (legacy shape)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: "biz-3", name: "Legacy Co" } as never);

    const md = await refreshBusinessProfileMd("biz-3");

    expect(md).toContain("- Business name: Legacy Co");
  });

  it("throws when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await expect(refreshBusinessProfileMd("missing")).rejects.toThrow(
      "refreshBusinessProfileMd: business missing not found"
    );
    expect(patchBusinessConfig).not.toHaveBeenCalled();
  });
});
