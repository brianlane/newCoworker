/**
 * The assignee's "you have a new booking" text: who gets it, every reason
 * it is skipped, and the best-effort contract (a failed text never
 * surfaces, the booking is already durable).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { notifyAssigneeOfBooking } from "@/lib/booking-page/assignee-notify";
import { getTeamMember } from "@/lib/db/employees";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockMember = vi.mocked(getTeamMember);
const mockOptOut = vi.mocked(checkSmsOptOut);
const mockConfig = vi.mocked(getTelnyxMessagingForBusiness);
const mockSend = vi.mocked(sendTelnyxSms);

const NOTICE = {
  visitorName: "Liz",
  visitorPhone: "+14805550177",
  startLocal: "Monday, July 27 at 9:00 AM",
  durationMinutes: 30,
  summary: "Liz + New Coworker (30 min)"
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMember.mockResolvedValue({ id: "m-ana", phone_e164: "+16025550101" } as never);
  mockOptOut.mockResolvedValue({ ok: true, optedOut: false } as never);
  mockConfig.mockResolvedValue({ fromE164: "+16026886672" } as never);
  mockSend.mockResolvedValue({ id: "sms-1", channel: "sms" } as never);
});

describe("notifyAssigneeOfBooking", () => {
  it("texts the member's own phone with who, when, and how long", async () => {
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "+16025550101",
      expect.stringContaining("Liz (+14805550177), Monday, July 27 at 9:00 AM, 30 min"),
      { meterBusinessId: BIZ }
    );
    expect(String(mockSend.mock.calls[0][2])).toContain("new booking");
  });

  it("skips a member who is gone or has no phone", async () => {
    mockMember.mockResolvedValue(null as never);
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);

    mockMember.mockResolvedValue({ id: "m-ana", phone_e164: null } as never);
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("respects a STOP from the member's number, and fails closed on a broken read", async () => {
    mockOptOut.mockResolvedValue({ ok: true, optedOut: true } as never);
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);

    mockOptOut.mockResolvedValue({ ok: false, error: "db down" } as never);
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("swallows and logs every failure: the booking is already durable", async () => {
    mockSend.mockRejectedValue(new Error("telnyx 500"));
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();

    mockMember.mockRejectedValue("string boom");
    expect(await notifyAssigneeOfBooking(BIZ, "m-ana", NOTICE)).toBe(false);
  });
});
