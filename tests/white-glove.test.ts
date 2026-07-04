import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WHITE_GLOVE_PACKAGE_IDS,
  WHITE_GLOVE_PRIORITY_SUPPORT_DAYS,
  getWhiteGloveBookingUrl,
  getWhiteGlovePackage,
  hasPrioritySupport,
  listWhiteGlovePackages,
  prioritySupportUntil
} from "@/lib/plans/white-glove";

describe("white-glove packages", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("lists both packages in catalog order with resolved prices", () => {
    const packages = listWhiteGlovePackages();
    expect(packages.map((p) => p.id)).toEqual([...WHITE_GLOVE_PACKAGE_IDS]);
    const setup = packages[0];
    const buildout = packages[1];
    expect(setup.priceCents).toBe(75_000);
    expect(setup.priceUsd).toBe(750);
    expect(buildout.priceCents).toBe(200_000);
    expect(buildout.priceUsd).toBe(2000);
    expect(setup.features.length).toBeGreaterThan(0);
    expect(buildout.features.length).toBeGreaterThan(0);
  });

  it("getWhiteGlovePackage returns the package for known ids", () => {
    expect(getWhiteGlovePackage("setup")?.name).toBe("White-glove setup");
    expect(getWhiteGlovePackage("buildout")?.name).toBe("White-glove buildout");
  });

  it("getWhiteGlovePackage fails closed on unknown ids", () => {
    expect(getWhiteGlovePackage("")).toBeNull();
    expect(getWhiteGlovePackage("platinum")).toBeNull();
  });

  it("prioritySupportUntil is exactly 30 days after purchase", () => {
    const purchasedAt = new Date("2026-07-04T12:00:00.000Z");
    const until = prioritySupportUntil(purchasedAt);
    expect(until.getTime() - purchasedAt.getTime()).toBe(
      WHITE_GLOVE_PRIORITY_SUPPORT_DAYS * 24 * 60 * 60 * 1000
    );
  });

  it("hasPrioritySupport is true only while the window is open", () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    expect(hasPrioritySupport("2026-07-05T00:00:00.000Z", now)).toBe(true);
    expect(hasPrioritySupport("2026-07-04T12:00:00.000Z", now)).toBe(false);
    expect(hasPrioritySupport("2026-07-01T00:00:00.000Z", now)).toBe(false);
  });

  it("hasPrioritySupport is false for null/undefined/invalid values", () => {
    expect(hasPrioritySupport(null)).toBe(false);
    expect(hasPrioritySupport(undefined)).toBe(false);
    expect(hasPrioritySupport("not-a-date")).toBe(false);
  });

  it("getWhiteGloveBookingUrl returns the trimmed env url", () => {
    process.env.WHITE_GLOVE_BOOKING_URL = "  https://cal.example.com/newcoworker  ";
    expect(getWhiteGloveBookingUrl()).toBe("https://cal.example.com/newcoworker");
  });

  it("getWhiteGloveBookingUrl returns null when unset or blank", () => {
    delete process.env.WHITE_GLOVE_BOOKING_URL;
    expect(getWhiteGloveBookingUrl()).toBeNull();
    process.env.WHITE_GLOVE_BOOKING_URL = "   ";
    expect(getWhiteGloveBookingUrl()).toBeNull();
  });
});
