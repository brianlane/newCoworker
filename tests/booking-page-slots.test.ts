/**
 * Pure slot-engine tests for the public booking page, including the DST
 * invariants the plan mandates (the BizBlasts lesson): a slot's end is
 * ALWAYS start + elapsed duration, in slot generation and booking creation
 * alike, across spring-forward and fall-back transitions.
 */
import { describe, expect, it } from "vitest";

import { computePublicSlots } from "@/lib/booking-page/slots";
import type { ComputePublicSlotsInput } from "@/lib/booking-page/slots";
import type { BusinessHours } from "@/lib/business-profile/profile";

const NY = "America/New_York";

const OPEN_ALL_WEEK: BusinessHours = {
  mon: { open: "09:00", close: "17:00" },
  tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" },
  thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" },
  sat: { open: "09:00", close: "17:00" },
  sun: { open: "09:00", close: "17:00" }
};

function baseInput(overrides: Partial<ComputePublicSlotsInput>): ComputePublicSlotsInput {
  return {
    // A Monday, 08:00 New York (13:00 UTC; EST offset -05 in January).
    now: new Date("2026-01-05T13:00:00Z"),
    timezone: NY,
    durationMinutes: 30,
    busy: [],
    businessHours: OPEN_ALL_WEEK,
    policy: {
      minNoticeMinutes: 0,
      maxAdvanceDays: 0,
      bufferMinutes: 0,
      maxDailyBookings: null,
      requireStaffOnShift: false
    },
    roster: [],
    timeOff: [],
    existingBookingStarts: [],
    ...overrides
  };
}

function localHm(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: NY,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));
}

describe("computePublicSlots", () => {
  it("walks a 30-minute business-local grid inside business hours", () => {
    const slots = computePublicSlots(baseInput({}));
    // Monday 09:00 .. 16:30 (last 30-min slot ending at close): 16 slots.
    expect(slots).toHaveLength(16);
    expect(localHm(slots[0].startIso)).toBe("09:00");
    expect(localHm(slots[slots.length - 1].startIso)).toBe("16:30");
    for (const slot of slots) {
      expect(new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()).toBe(
        30 * 60_000
      );
    }
  });

  it("defaults to weekday 9-to-5 when the owner never set hours", () => {
    // Saturday Jan 10: default hours have no weekend entry.
    const sat = computePublicSlots(
      baseInput({ now: new Date("2026-01-10T13:00:00Z"), businessHours: null })
    );
    expect(sat).toHaveLength(0);
    const mon = computePublicSlots(baseInput({ businessHours: null }));
    expect(mon.length).toBeGreaterThan(0);
  });

  it("treats explicitly closed and unspecified days as closed, and drops malformed windows", () => {
    // Monday with: sun closed (null), mon missing entirely => closed.
    expect(
      computePublicSlots(baseInput({ businessHours: { sun: null } }))
    ).toHaveLength(0);
    // close <= open is fail-closed.
    expect(
      computePublicSlots(
        baseInput({ businessHours: { mon: { open: "17:00", close: "09:00" } } })
      )
    ).toHaveLength(0);
    // Unparseable open time is fail-closed (hand-edited row).
    expect(
      computePublicSlots(
        baseInput({
          businessHours: { mon: { open: "xx:yy", close: "17:00" } } as never
        })
      )
    ).toHaveLength(0);
  });

  it("respects minimum notice and the longer-duration close fit", () => {
    // 60-minute meetings with 4h notice from 08:00: first slot 12:00, last 16:00.
    const slots = computePublicSlots(
      baseInput({
        durationMinutes: 60,
        policy: {
          minNoticeMinutes: 240,
          maxAdvanceDays: 0,
          bufferMinutes: 0,
          maxDailyBookings: null,
          requireStaffOnShift: false
        }
      })
    );
    expect(localHm(slots[0].startIso)).toBe("12:00");
    expect(localHm(slots[slots.length - 1].startIso)).toBe("16:00");
  });

  it("stops at the business-local max-advance day boundary", () => {
    const slots = computePublicSlots(
      baseInput({
        policy: {
          minNoticeMinutes: 0,
          maxAdvanceDays: 1,
          bufferMinutes: 0,
          maxDailyBookings: null,
          requireStaffOnShift: false
        }
      })
    );
    const days = new Set(
      slots.map((s) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: NY }).format(new Date(s.startIso))
      )
    );
    expect([...days].sort()).toEqual(["2026-01-05", "2026-01-06"]);
  });

  it("blocks slots overlapping busy blocks, with the buffer padding both sides", () => {
    const busy = [
      {
        start: new Date("2026-01-05T15:00:00Z"), // 10:00 NY
        end: new Date("2026-01-05T16:00:00Z") // 11:00 NY
      }
    ];
    const noBuffer = computePublicSlots(baseInput({ busy }));
    expect(noBuffer.map((s) => localHm(s.startIso))).not.toContain("10:00");
    expect(noBuffer.map((s) => localHm(s.startIso))).toContain("09:30");
    expect(noBuffer.map((s) => localHm(s.startIso))).toContain("11:00");

    const buffered = computePublicSlots(
      baseInput({
        busy,
        policy: {
          minNoticeMinutes: 0,
          maxAdvanceDays: 0,
          bufferMinutes: 30,
          maxDailyBookings: null,
          requireStaffOnShift: false
        }
      })
    );
    const starts = buffered.map((s) => localHm(s.startIso));
    expect(starts).not.toContain("09:30");
    expect(starts).not.toContain("11:00");
    expect(starts).toContain("11:30");
  });

  it("orders multiple busy blocks before walking the grid", () => {
    const slots = computePublicSlots(
      baseInput({
        busy: [
          // Deliberately unsorted.
          { start: new Date("2026-01-05T19:00:00Z"), end: new Date("2026-01-05T20:00:00Z") },
          { start: new Date("2026-01-05T15:00:00Z"), end: new Date("2026-01-05T16:00:00Z") }
        ]
      })
    );
    const starts = slots.map((s) => localHm(s.startIso));
    expect(starts).not.toContain("10:00"); // 15:00Z block (NY morning)
    expect(starts).not.toContain("14:30"); // 19:00Z block
    expect(starts).toContain("11:00");
  });

  it("drops a day at the daily booking cap (grouped in the business zone)", () => {
    const slots = computePublicSlots(
      baseInput({
        policy: {
          minNoticeMinutes: 0,
          maxAdvanceDays: 1,
          bufferMinutes: 0,
          maxDailyBookings: 2,
          requireStaffOnShift: false
        },
        existingBookingStarts: [
          new Date("2026-01-05T15:00:00Z"),
          new Date("2026-01-05T18:00:00Z")
        ]
      })
    );
    const days = new Set(
      slots.map((s) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: NY }).format(new Date(s.startIso))
      )
    );
    expect(days.has("2026-01-05")).toBe(false);
    expect(days.has("2026-01-06")).toBe(true);
  });

  describe("staff-coverage gate", () => {
    const gated = {
      minNoticeMinutes: 0,
      maxAdvanceDays: 0,
      bufferMinutes: 0,
      maxDailyBookings: null,
      requireStaffOnShift: true
    };

    it("offers nothing when the roster is empty", () => {
      expect(computePublicSlots(baseInput({ policy: gated }))).toHaveLength(0);
    });

    it("a member with no valid schedule counts as always on shift", () => {
      const slots = computePublicSlots(
        baseInput({ policy: gated, roster: [{ id: "m1", weekly_schedule: null }] })
      );
      expect(slots.length).toBeGreaterThan(0);
    });

    it("intersects with the union of member schedules minus time off", () => {
      const morning = { id: "m1", weekly_schedule: { mon: [["09:00", "12:00"]] } };
      const afternoon = { id: "m2", weekly_schedule: { mon: [["13:00", "17:00"]] } };
      const both = computePublicSlots(
        baseInput({ policy: gated, roster: [morning, afternoon] })
      );
      const starts = both.map((s) => localHm(s.startIso));
      expect(starts).toContain("09:00");
      expect(starts).toContain("13:00");
      expect(starts).not.toContain("12:00");

      // The afternoon member is OOO today: afternoon slots disappear.
      const off = computePublicSlots(
        baseInput({
          policy: gated,
          roster: [morning, afternoon],
          timeOff: [{ member_id: "m2", starts_on: "2026-01-05", ends_on: "2026-01-05" }]
        })
      );
      const offStarts = off.map((s) => localHm(s.startIso));
      expect(offStarts).toContain("09:00");
      expect(offStarts).not.toContain("13:00");
    });
  });

  describe("DST invariants (America/New_York)", () => {
    // Both 2026 transitions are Sundays; open the Sunday small hours.
    const NIGHT_HOURS: BusinessHours = { sun: { open: "00:00", close: "05:00" } };

    it("spring forward (2026-03-08): the 2 AM hour never renders and ends stay elapsed", () => {
      const slots = computePublicSlots(
        baseInput({
          // 00:15 EST (05:15Z).
          now: new Date("2026-03-08T05:15:00Z"),
          businessHours: NIGHT_HOURS
        })
      );
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()).toBe(
          30 * 60_000
        );
        expect(localHm(slot.startIso).startsWith("02:")).toBe(false);
      }
      // The slot before the jump flows straight across it: 01:30 EST ends
      // at 03:00 EDT, the SAME instant 30 elapsed minutes later.
      const before = slots.find((s) => localHm(s.startIso) === "01:30");
      expect(before).toBeDefined();
      expect(localHm(before!.endIso)).toBe("03:00");
    });

    it("fall back (2026-11-01): repeated local labels are distinct instants and ends stay elapsed", () => {
      const slots = computePublicSlots(
        baseInput({
          // 00:15 EDT (04:15Z).
          now: new Date("2026-11-01T04:15:00Z"),
          businessHours: NIGHT_HOURS
        })
      );
      // 01:00 occurs twice on the wall clock (EDT then EST) — both offered,
      // as distinct instants.
      const oneAm = slots.filter((s) => localHm(s.startIso) === "01:00");
      expect(oneAm).toHaveLength(2);
      expect(new Set(oneAm.map((s) => s.startIso)).size).toBe(2);
      for (const slot of slots) {
        expect(new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()).toBe(
          30 * 60_000
        );
      }
    });
  });
});
