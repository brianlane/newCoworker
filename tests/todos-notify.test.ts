/**
 * Assignment notification (src/lib/todos/notify.ts): who gets texted, every
 * skip reason, and the never-throws contract. The SMS body itself is pinned
 * in tests/todos-core.test.ts (buildTodoAssignmentSms); here we assert the
 * assembled message reaches the roster phone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusinessTimezone: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));

import { isNewAssignment, notifyTodoAssignment } from "@/lib/todos/notify";
import type { Todo } from "@/lib/todos/core";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTeamMember } from "@/lib/db/employees";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

const TODO: Todo = {
  id: "todo-1",
  businessId: BIZ,
  contactId: null,
  dealId: null,
  title: "Send the packet",
  details: null,
  assigneeEmployeeId: "emp-1",
  dueAt: "2026-08-25T21:00:00.000Z",
  completedAt: null,
  completedBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const MEMBER = {
  id: "emp-1",
  name: "Gabby",
  phone_e164: "+15550009999",
  active: true
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({} as never);
  vi.mocked(getTeamMember).mockResolvedValue(MEMBER as never);
  vi.mocked(getBusinessTimezone).mockResolvedValue("America/Phoenix");
});

describe("isNewAssignment", () => {
  it("is true exactly when someone NEW now holds the to-do", () => {
    expect(isNewAssignment(null, "emp-1")).toBe(true);
    expect(isNewAssignment("emp-old", "emp-new")).toBe(true);
    expect(isNewAssignment("emp-1", "emp-1")).toBe(false);
    expect(isNewAssignment("emp-1", null)).toBe(false);
    expect(isNewAssignment(null, null)).toBe(false);
  });
});

describe("notifyTodoAssignment", () => {
  it("texts the assignee's roster phone with the title and business-local due date", async () => {
    // Every dependency injected, exercising the deps side of each default.
    const sendSms = vi.fn().mockResolvedValue(undefined);
    const getMember = vi.fn().mockResolvedValue(MEMBER);
    const getTimezone = vi.fn().mockResolvedValue("America/Phoenix");
    const outcome = await notifyTodoAssignment(BIZ, TODO, {
      client: {} as never,
      getMember: getMember as never,
      getTimezone: getTimezone as never,
      sendSms
    });
    expect(outcome).toBe("sent");
    expect(getMember).toHaveBeenCalledWith(BIZ, "emp-1", {});
    expect(getTimezone).toHaveBeenCalledWith(BIZ, {});
    expect(sendSms).toHaveBeenCalledWith(
      BIZ,
      "+15550009999",
      'New Coworker: you were assigned a to-do: "Send the packet". Due Tue, Aug 25, 2:00 PM.'
    );
  });

  it("omits the due phrase when the to-do has no due date", async () => {
    const sendSms = vi.fn().mockResolvedValue(undefined);
    await notifyTodoAssignment(BIZ, { ...TODO, dueAt: null }, { client: {} as never, sendSms });
    expect(sendSms).toHaveBeenCalledWith(
      BIZ,
      "+15550009999",
      'New Coworker: you were assigned a to-do: "Send the packet".'
    );
  });

  it("skips an unassigned to-do without touching any dependency", async () => {
    const outcome = await notifyTodoAssignment(BIZ, {
      ...TODO,
      assigneeEmployeeId: null
    });
    expect(outcome).toBe("skipped_unassigned");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    expect(getTeamMember).not.toHaveBeenCalled();
  });

  it("skips (with a warn) when the roster row is gone or has no phone", async () => {
    vi.mocked(getTeamMember).mockResolvedValue(null as never);
    expect(await notifyTodoAssignment(BIZ, TODO, { client: {} as never })).toBe(
      "skipped_member_missing"
    );

    vi.mocked(getTeamMember).mockResolvedValue({ ...MEMBER, phone_e164: "" } as never);
    expect(await notifyTodoAssignment(BIZ, TODO, { client: {} as never })).toBe(
      "skipped_member_missing"
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not text a deactivated member", async () => {
    vi.mocked(getTeamMember).mockResolvedValue({ ...MEMBER, active: false } as never);
    const sendSms = vi.fn();
    expect(await notifyTodoAssignment(BIZ, TODO, { client: {} as never, sendSms })).toBe(
      "skipped_member_inactive"
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("defaults to the tenant Telnyx config + metered send when no sendSms is injected", async () => {
    const config = { messagingProfileId: "profile-1", fromE164: "+15550000000" };
    vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue(config as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "msg-1", channel: "sms" } as never);

    const outcome = await notifyTodoAssignment(BIZ, TODO);
    expect(outcome).toBe("sent");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(getTelnyxMessagingForBusiness).toHaveBeenCalledWith(BIZ, {});
    expect(sendTelnyxSms).toHaveBeenCalledWith(
      config,
      "+15550009999",
      expect.stringContaining("Send the packet"),
      { meterBusinessId: BIZ }
    );
  });

  it("never throws: a failed send (or roster read) logs and reports failed", async () => {
    const sendSms = vi.fn().mockRejectedValue(new Error("telnyx down"));
    expect(await notifyTodoAssignment(BIZ, TODO, { client: {} as never, sendSms })).toBe(
      "failed"
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "todo assignment notify failed (to-do unaffected)",
      expect.objectContaining({ businessId: BIZ, error: "telnyx down" })
    );

    vi.mocked(getTeamMember).mockRejectedValue("roster exploded");
    expect(await notifyTodoAssignment(BIZ, TODO, { client: {} as never })).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "todo assignment notify failed (to-do unaffected)",
      expect.objectContaining({ error: "roster exploded" })
    );
  });
});
