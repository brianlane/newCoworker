/**
 * Who a public-page booking goes to: the mode parser, the eligibility rules
 * (including the deliberate fallback when a fixed page's employee is gone),
 * shift/time-off availability, and the fairness order.
 */
import { describe, expect, it } from "vitest";

import {
  chooseAssignee,
  eligibleMembers,
  memberAvailableAt,
  parseAssignmentMode,
  resolveBroadcastAssignment
} from "@/lib/booking-page/assignment";
import type { TeamMemberRow, TimeOffRow } from "@/lib/db/employees";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TZ = "America/Phoenix";
/** Monday 9:00 AM Phoenix. */
const MONDAY_9AM = "2026-01-05T16:00:00.000Z";

function member(over: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "m-1",
    business_id: BIZ,
    name: "Ana",
    phone_e164: "+14805550100",
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    routing_enabled: true,
    named_broadcast_enabled: true,
    team_broadcast_enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over
  } as TeamMemberRow;
}

function timeOff(over: Partial<TimeOffRow> = {}): TimeOffRow {
  return {
    id: "t-1",
    business_id: BIZ,
    member_id: "m-1",
    starts_on: "2026-01-05",
    ends_on: "2026-01-05",
    reason: null,
    calendar_event_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over
  } as TimeOffRow;
}

describe("parseAssignmentMode", () => {
  it("reads the four modes and treats anything else as unassigned", () => {
    expect(parseAssignmentMode("round_robin")).toBe("round_robin");
    expect(parseAssignmentMode("fixed")).toBe("fixed");
    expect(parseAssignmentMode("any")).toBe("any");
    expect(parseAssignmentMode("broadcast")).toBe("broadcast");
    // A future mode, a typo, or a null column must not change behavior.
    expect(parseAssignmentMode("pooled")).toBe("any");
    expect(parseAssignmentMode(null)).toBe("any");
    expect(parseAssignmentMode(undefined)).toBe("any");
  });
});

describe("eligibleMembers", () => {
  const ana = member({ id: "m-ana", name: "Ana" });
  const ben = member({ id: "m-ben", name: "Ben" });
  const gone = member({ id: "m-gone", name: "Gone", active: false });

  it("drops inactive members in every mode", () => {
    expect(eligibleMembers("any", null, [ana, gone]).map((m) => m.id)).toEqual(["m-ana"]);
    expect(eligibleMembers("round_robin", null, [ana, ben, gone]).map((m) => m.id)).toEqual([
      "m-ana",
      "m-ben"
    ]);
  });

  it("narrows a fixed page to its employee", () => {
    expect(eligibleMembers("fixed", "m-ben", [ana, ben]).map((m) => m.id)).toEqual(["m-ben"]);
  });

  it("falls back to the whole roster when a fixed page's employee is gone", () => {
    // An owner should discover a stale setting from odd assignments, not
    // from a page that shows no times at all.
    expect(eligibleMembers("fixed", "m-gone", [ana, ben, gone]).map((m) => m.id)).toEqual([
      "m-ana",
      "m-ben"
    ]);
    expect(eligibleMembers("fixed", null, [ana]).map((m) => m.id)).toEqual(["m-ana"]);
  });
});

describe("memberAvailableAt", () => {
  it("counts a member with no usable schedule as always on shift", () => {
    expect(memberAvailableAt(member(), [], MONDAY_9AM, TZ)).toBe(true);
    expect(memberAvailableAt(member({ weekly_schedule: "nonsense" }), [], MONDAY_9AM, TZ)).toBe(
      true
    );
  });

  it("respects the weekly schedule", () => {
    const morning = member({ weekly_schedule: { mon: [["08:00", "12:00"]] } });
    expect(memberAvailableAt(morning, [], MONDAY_9AM, TZ)).toBe(true);
    // 9:00 Phoenix is 17:00 in London, outside the same window read there.
    const afternoonOnly = member({ weekly_schedule: { mon: [["13:00", "17:00"]] } });
    expect(memberAvailableAt(afternoonOnly, [], MONDAY_9AM, TZ)).toBe(false);
    // A day with no window at all.
    const tuesdayOnly = member({ weekly_schedule: { tue: [["08:00", "12:00"]] } });
    expect(memberAvailableAt(tuesdayOnly, [], MONDAY_9AM, TZ)).toBe(false);
  });

  it("respects time off, and only that member's", () => {
    expect(memberAvailableAt(member(), [timeOff()], MONDAY_9AM, TZ)).toBe(false);
    expect(
      memberAvailableAt(member(), [timeOff({ member_id: "someone-else" })], MONDAY_9AM, TZ)
    ).toBe(true);
    // A span that ends before the appointment does not block it.
    expect(
      memberAvailableAt(
        member(),
        [timeOff({ starts_on: "2026-01-01", ends_on: "2026-01-04" })],
        MONDAY_9AM,
        TZ
      )
    ).toBe(true);
  });
});

describe("chooseAssignee", () => {
  const ana = member({ id: "m-ana" });
  const ben = member({ id: "m-ben" });

  const base = {
    employeeId: null,
    timeOff: [] as TimeOffRow[],
    startIso: MONDAY_9AM,
    timezone: TZ,
    upcomingCounts: new Map<string, number>()
  };

  it("records nobody for an unassigned page", () => {
    expect(chooseAssignee({ ...base, mode: "any", roster: [ana, ben] })).toEqual({
      memberId: null,
      reason: "unassigned_mode"
    });
  });

  it("gives the booking to the lightest upcoming load", () => {
    // Fairness is measured in real bookings, so a week emptied by
    // cancellations self-corrects instead of compounding.
    const out = chooseAssignee({
      ...base,
      mode: "round_robin",
      roster: [ana, ben],
      upcomingCounts: new Map([
        ["m-ana", 3],
        ["m-ben", 1]
      ])
    });
    expect(out).toEqual({ memberId: "m-ben", reason: "chosen" });
  });

  it("breaks a tie on who has waited longest, then on a stable id", () => {
    const waitedLonger = member({ id: "m-ana", last_offered_at: "2026-01-01T00:00:00Z" });
    const justOffered = member({ id: "m-ben", last_offered_at: "2026-01-04T00:00:00Z" });
    expect(
      chooseAssignee({ ...base, mode: "round_robin", roster: [justOffered, waitedLonger] }).memberId
    ).toBe("m-ana");

    // Never offered waits longest of all.
    expect(
      chooseAssignee({
        ...base,
        mode: "round_robin",
        roster: [justOffered, member({ id: "m-new" })]
      }).memberId
    ).toBe("m-new");

    // Identical in every respect: the same inputs always name the same
    // person rather than depending on row order.
    expect(chooseAssignee({ ...base, mode: "round_robin", roster: [ben, ana] }).memberId).toBe(
      "m-ana"
    );
  });

  it("only considers people actually working that slot", () => {
    const offToday = member({ id: "m-ana" });
    const out = chooseAssignee({
      ...base,
      mode: "round_robin",
      roster: [offToday, ben],
      timeOff: [timeOff({ member_id: "m-ana" })],
      upcomingCounts: new Map([["m-ben", 9]])
    });
    // Ben is far busier, and still gets it: Ana is off.
    expect(out.memberId).toBe("m-ben");
  });

  it("leaves the booking unassigned when nobody eligible is working", () => {
    expect(
      chooseAssignee({
        ...base,
        mode: "round_robin",
        roster: [member({ id: "m-ana", weekly_schedule: { tue: [["08:00", "12:00"]] } })]
      })
    ).toEqual({ memberId: null, reason: "nobody_available" });

    // An empty roster is the same answer, not a crash.
    expect(chooseAssignee({ ...base, mode: "round_robin", roster: [] })).toEqual({
      memberId: null,
      reason: "nobody_available"
    });
  });

  it("gives a fixed page's booking to its employee", () => {
    const out = chooseAssignee({
      ...base,
      mode: "fixed",
      employeeId: "m-ben",
      roster: [ana, ben],
      // Even when they are the busier of the two: that is the point of a
      // per-person page.
      upcomingCounts: new Map([["m-ben", 9]])
    });
    expect(out).toEqual({ memberId: "m-ben", reason: "chosen" });
  });
});

/**
 * Broadcast mode: nobody is picked at booking time. The pure resolver
 * answers one of three shapes, and the solo-owner collapse (the #1500
 * rule) means a one-person owner-only roster never races itself.
 */
describe("broadcast assignment", () => {
  const OWNER_PHONE = "+16026866672";

  it("eligibleMembers treats broadcast like any: the whole active roster", () => {
    const roster = [member(), member({ id: "m-2", active: false })];
    expect(eligibleMembers("broadcast", null, roster).map((m) => m.id)).toEqual(["m-1"]);
  });

  it("chooseAssignee never picks for broadcast", () => {
    const out = chooseAssignee({
      mode: "broadcast",
      employeeId: null,
      roster: [member()],
      timeOff: [],
      startIso: MONDAY_9AM,
      timezone: TZ,
      upcomingCounts: new Map()
    });
    expect(out).toEqual({ memberId: null, reason: "unassigned_mode" });
  });

  it("collapses to a direct owner pick on a one-person owner-only roster", () => {
    const roster = [member({ id: "m-owner", name: "Brian", phone_e164: OWNER_PHONE })];
    expect(resolveBroadcastAssignment(roster, [OWNER_PHONE], null)).toEqual({
      kind: "solo_owner",
      memberId: "m-owner"
    });
  });

  it("invites the active textable roster when there is a real team", () => {
    const roster = [
      member({ id: "m-1", phone_e164: "+14805550100" }),
      member({ id: "m-2", phone_e164: "+14805550101" }),
      member({ id: "m-3", active: false, phone_e164: "+14805550102" }),
      member({ id: "m-4", phone_e164: "" })
    ];
    const out = resolveBroadcastAssignment(roster, [OWNER_PHONE], null);
    expect(out.kind).toBe("invite");
    if (out.kind === "invite") {
      expect(out.invitees.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    }
  });

  it("a solo ASSISTANT roster is a one-person invite, not an owner pick", () => {
    const roster = [member({ id: "m-a", name: "Dana", phone_e164: "+14805550100" })];
    const out = resolveBroadcastAssignment(roster, [OWNER_PHONE], null);
    expect(out.kind).toBe("invite");
  });

  it("never invites the attendee's own number", () => {
    const roster = [
      member({ id: "m-1", phone_e164: "+14805550100" }),
      member({ id: "m-2", phone_e164: "+14805550101" })
    ];
    const out = resolveBroadcastAssignment(roster, [OWNER_PHONE], "+14805550101");
    expect(out.kind).toBe("invite");
    if (out.kind === "invite") {
      expect(out.invitees.map((m) => m.id)).toEqual(["m-1"]);
    }
  });

  it("nobody textable answers nobody", () => {
    const roster = [member({ id: "m-4", phone_e164: "" })];
    expect(resolveBroadcastAssignment(roster, [OWNER_PHONE], null)).toEqual({ kind: "nobody" });
    expect(resolveBroadcastAssignment([], [OWNER_PHONE], null)).toEqual({ kind: "nobody" });
  });
});
