/**
 * The AI door of "Who bookings go to"
 * (src/lib/booking-page/ai-door-assignment.ts): the same resolution the
 * public page runs, applied after an AI-made booking is durable. Everything
 * is best-effort: any failure answers unassigned, which is yesterday's
 * behavior for this door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  countUpcomingByAssignee: vi.fn(),
  getBookingPageForBusiness: vi.fn(),
  stampAssigneeByClaimId: vi.fn()
}));
vi.mock("@/lib/booking-page/assignee-notify", () => ({ notifyAssigneeOfBooking: vi.fn() }));
vi.mock("@/lib/booking-page/claim-offers", () => ({ broadcastBookingClaim: vi.fn() }));
vi.mock("@/lib/db/contact-names", () => ({ businessOwnerNumbers: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({
  listTeamMembers: vi.fn(),
  listTimeOff: vi.fn(),
  markMemberOffered: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { applyAiBookingAssignment } from "@/lib/booking-page/ai-door-assignment";
import { notifyAssigneeOfBooking } from "@/lib/booking-page/assignee-notify";
import { broadcastBookingClaim } from "@/lib/booking-page/claim-offers";
import {
  countUpcomingByAssignee,
  getBookingPageForBusiness,
  stampAssigneeByClaimId
} from "@/lib/booking-page/db";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers, listTimeOff, markMemberOffered } from "@/lib/db/employees";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER_PHONE = "+16026866672";

const INPUT = {
  dedupeClaimId: "dedupe-1",
  attendeeName: "Pat Visitor",
  attendeePhone: "+14805550100",
  startIso: "2026-01-05T16:00:00.000Z",
  startLocal: "Monday, January 5 at 9:00 AM",
  summary: "Strategy call",
  durationMinutes: 30
};

const page = (over: Record<string, unknown> = {}) => ({
  id: "page-1",
  business_id: BIZ,
  assignment_mode: "broadcast",
  employee_id: null,
  notify_assignee: true,
  ...over
});

const member = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  name: "Ana",
  phone_e164: "+14805550111",
  active: true,
  weekly_schedule: null,
  last_offered_at: null,
  ...over
});

/** Client used only for the business timezone read. */
function tzClient(timezone: string | null) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone } }) }) })
    })
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBookingPageForBusiness).mockResolvedValue(page() as never);
  vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
  vi.mocked(listTimeOff).mockResolvedValue([] as never);
  vi.mocked(countUpcomingByAssignee).mockResolvedValue(new Map());
  vi.mocked(businessOwnerNumbers).mockResolvedValue([]);
  vi.mocked(stampAssigneeByClaimId).mockResolvedValue(true);
  vi.mocked(markMemberOffered).mockResolvedValue(undefined as never);
  vi.mocked(broadcastBookingClaim).mockResolvedValue(["+14805550111"]);
});

describe("applyAiBookingAssignment", () => {
  it("does nothing without a dedupe row to stamp", async () => {
    const out = await applyAiBookingAssignment(BIZ, { ...INPUT, dedupeClaimId: null }, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(getBookingPageForBusiness).not.toHaveBeenCalled();
  });

  it("does nothing without a page, or on mode any", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValueOnce(null);
    expect(await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"))).toEqual({
      assigneeMemberId: null,
      invitedPhones: []
    });
    vi.mocked(getBookingPageForBusiness).mockResolvedValueOnce(
      page({ assignment_mode: "any" }) as never
    );
    expect(await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"))).toEqual({
      assigneeMemberId: null,
      invitedPhones: []
    });
    expect(listTeamMembers).not.toHaveBeenCalled();
  });

  it("broadcast + real team: parks the claim and reports the invited phones", async () => {
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: ["+14805550111"] });
    expect(broadcastBookingClaim).toHaveBeenCalledWith(
      BIZ,
      "dedupe-1",
      [expect.objectContaining({ id: "m-1" })],
      expect.objectContaining({ visitorName: "Pat Visitor", startLocal: INPUT.startLocal }),
      expect.anything()
    );
    expect(stampAssigneeByClaimId).not.toHaveBeenCalled();
    expect(notifyAssigneeOfBooking).not.toHaveBeenCalled();
  });

  it("broadcast + solo owner: stamps the owner directly, no invite, no assignee text", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ id: "m-owner", name: "Brian", phone_e164: OWNER_PHONE })
    ] as never);
    vi.mocked(businessOwnerNumbers).mockResolvedValue([OWNER_PHONE]);
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: "m-owner", invitedPhones: [] });
    expect(stampAssigneeByClaimId).toHaveBeenCalledWith("dedupe-1", "m-owner", expect.anything());
    expect(broadcastBookingClaim).not.toHaveBeenCalled();
    expect(notifyAssigneeOfBooking).not.toHaveBeenCalled();
  });

  it("broadcast + nobody textable: unassigned, no machinery", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member({ phone_e164: "" })] as never);
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(broadcastBookingClaim).not.toHaveBeenCalled();
  });

  it("round robin: picks, stamps, advances the tiebreak, and texts the assignee", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("America/Phoenix"));
    expect(out).toEqual({ assigneeMemberId: "m-1", invitedPhones: [] });
    expect(stampAssigneeByClaimId).toHaveBeenCalledWith("dedupe-1", "m-1", expect.anything());
    expect(markMemberOffered).toHaveBeenCalledWith("m-1", expect.anything());
    expect(notifyAssigneeOfBooking).toHaveBeenCalledWith(
      BIZ,
      "m-1",
      expect.objectContaining({ visitorName: "Pat Visitor", durationMinutes: 30 })
    );
  });

  it("fixed: books the named employee", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "fixed", employee_id: "m-1" }) as never
    );
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient(null));
    expect(out.assigneeMemberId).toBe("m-1");
  });

  it("a raced stamp (already assigned) stops there: no tiebreak, no text", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    vi.mocked(stampAssigneeByClaimId).mockResolvedValue(false);
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(markMemberOffered).not.toHaveBeenCalled();
    expect(notifyAssigneeOfBooking).not.toHaveBeenCalled();
  });

  it("notify_assignee off keeps the stamp but drops the text", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin", notify_assignee: false }) as never
    );
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out.assigneeMemberId).toBe("m-1");
    expect(notifyAssigneeOfBooking).not.toHaveBeenCalled();
  });

  it("nobody available on a round robin answers unassigned and says why", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    vi.mocked(listTeamMembers).mockResolvedValue([member({ active: false })] as never);
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "ai-booking: booking left unassigned",
      expect.objectContaining({ reason: "nobody_available" })
    );
  });

  it("a timezone read that throws degrades to UTC rather than failing the pick", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    const throwingTz = {
      from() {
        throw new Error("reset");
      }
    } as never;
    const out = await applyAiBookingAssignment(BIZ, INPUT, throwingTz);
    expect(out.assigneeMemberId).toBe("m-1");
  });

  it("never throws: a page read failure answers unassigned", async () => {
    vi.mocked(getBookingPageForBusiness).mockRejectedValue(new Error("boom"));
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "ai-booking: assignment failed (booking unaffected)",
      expect.objectContaining({ businessId: BIZ })
    );
  });
});

describe("plumbing arms", () => {
  it("builds its own client when none is passed", async () => {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(tzClient("UTC") as never);
    const out = await applyAiBookingAssignment(BIZ, INPUT);
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: ["+14805550111"] });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("a failed tiebreak advance never fails the assignment", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    vi.mocked(markMemberOffered).mockRejectedValue(new Error("denied"));
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out.assigneeMemberId).toBe("m-1");
  });
});

describe("phoneless attendee", () => {
  it("the assignee text renders without a visitor phone", async () => {
    vi.mocked(getBookingPageForBusiness).mockResolvedValue(
      page({ assignment_mode: "round_robin" }) as never
    );
    const out = await applyAiBookingAssignment(
      BIZ,
      { ...INPUT, attendeePhone: null },
      tzClient("UTC")
    );
    expect(out.assigneeMemberId).toBe("m-1");
    expect(notifyAssigneeOfBooking).toHaveBeenCalledWith(
      BIZ,
      "m-1",
      expect.objectContaining({ visitorPhone: "" })
    );
  });
});

describe("non-Error failure shape", () => {
  it("a bare-string throw still degrades to unassigned with a string log", async () => {
    vi.mocked(getBookingPageForBusiness).mockRejectedValue("reset");
    const out = await applyAiBookingAssignment(BIZ, INPUT, tzClient("UTC"));
    expect(out).toEqual({ assigneeMemberId: null, invitedPhones: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "ai-booking: assignment failed (booking unaffected)",
      expect.objectContaining({ error: "reset" })
    );
  });
});
