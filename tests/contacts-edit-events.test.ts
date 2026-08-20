import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-flows/goal-hooks", () => ({ fireGoalEvent: vi.fn() }));
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));

import {
  fireOwnerAssignedEvent,
  fireTagChangeEvents
} from "../src/lib/contacts/edit-events";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { getTeamMember } from "@/lib/db/employees";

/**
 * Coverage for src/lib/contacts/edit-events.ts: the tag-diff and
 * owner-assigned event contract extracted from the single-contact PATCH
 * route and shared with the bulk path. The route's own test
 * (tests/api-dashboard-customers-route.test.ts) exercises it end to end;
 * this file pins the helper's behavior directly.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const PRIMARY = "+15550001111";
const ALIAS = "+15550002222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fireTagChangeEvents", () => {
  it("fires a goal event per linked number and one added event per new tag", async () => {
    await fireTagChangeEvents(BIZ, {
      canonicalE164: PRIMARY,
      aliasE164s: [ALIAS],
      previousTags: [],
      nextTags: ["VIP"]
    });

    // Goal events go to the primary AND every alias, so parked runs keyed
    // on a merged-away number still jump.
    expect(fireGoalEvent).toHaveBeenCalledTimes(2);
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, PRIMARY, { kind: "tag_added", tag: "VIP" });
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, ALIAS, { kind: "tag_added", tag: "VIP" });

    expect(fireContactEvent).toHaveBeenCalledTimes(1);
    const [biz, event] = vi.mocked(fireContactEvent).mock.calls[0];
    expect(biz).toBe(BIZ);
    expect(event).toMatchObject({
      kind: "tag_changed",
      contact: { e164: PRIMARY, tags: ["VIP"] },
      tag: "VIP",
      change: "added"
    });
    expect((event as { dedupeKey?: string }).dedupeKey).toMatch(
      new RegExp(`^ce:tag:\\${PRIMARY}:vip:added:\\d+$`)
    );
  });

  it("fires a removed event (and no goal event) for a dropped tag", async () => {
    await fireTagChangeEvents(BIZ, {
      canonicalE164: PRIMARY,
      aliasE164s: [],
      previousTags: ["New Lead"],
      nextTags: []
    });

    expect(fireGoalEvent).not.toHaveBeenCalled();
    expect(fireContactEvent).toHaveBeenCalledTimes(1);
    const [, event] = vi.mocked(fireContactEvent).mock.calls[0];
    expect(event).toMatchObject({
      kind: "tag_changed",
      contact: { e164: PRIMARY, tags: [] },
      tag: "New Lead",
      change: "removed"
    });
    expect((event as { dedupeKey?: string }).dedupeKey).toMatch(
      new RegExp(`^ce:tag:\\${PRIMARY}:new lead:removed:\\d+$`)
    );
  });

  it("normalizes both sides so a case/whitespace respelling fires nothing", async () => {
    await fireTagChangeEvents(BIZ, {
      canonicalE164: PRIMARY,
      aliasE164s: [],
      previousTags: [" VIP ", "New Lead"],
      nextTags: ["vip", "new lead"]
    });

    expect(fireGoalEvent).not.toHaveBeenCalled();
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("handles an add and a remove in the same diff, skipping kept tags", async () => {
    await fireTagChangeEvents(BIZ, {
      canonicalE164: PRIMARY,
      aliasE164s: [],
      previousTags: ["VIP", "New Lead"],
      nextTags: ["vip", "Engaged"]
    });

    expect(fireGoalEvent).toHaveBeenCalledTimes(1);
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, PRIMARY, {
      kind: "tag_added",
      tag: "Engaged"
    });
    expect(fireContactEvent).toHaveBeenCalledTimes(2);
    expect(fireContactEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ tag: "Engaged", change: "added" })
    );
    expect(fireContactEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ tag: "New Lead", change: "removed" })
    );
  });
});

describe("fireOwnerAssignedEvent", () => {
  it("does nothing for a clear (null owner)", async () => {
    await fireOwnerAssignedEvent(BIZ, {
      canonicalE164: PRIMARY,
      previousOwnerEmployeeId: "emp-1",
      ownerEmployeeId: null
    });
    expect(getTeamMember).not.toHaveBeenCalled();
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("does nothing when the owner did not change", async () => {
    await fireOwnerAssignedEvent(BIZ, {
      canonicalE164: PRIMARY,
      previousOwnerEmployeeId: "emp-1",
      ownerEmployeeId: "emp-1"
    });
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("fires with the member's name when the roster read finds one", async () => {
    vi.mocked(getTeamMember).mockResolvedValueOnce({ id: "emp-2", name: "Dana" } as never);
    await fireOwnerAssignedEvent(BIZ, {
      canonicalE164: PRIMARY,
      previousOwnerEmployeeId: null,
      ownerEmployeeId: "emp-2"
    });
    expect(fireContactEvent).toHaveBeenCalledTimes(1);
    const [, event] = vi.mocked(fireContactEvent).mock.calls[0];
    expect(event).toMatchObject({
      kind: "owner_assigned",
      contact: { e164: PRIMARY },
      ownerName: "Dana"
    });
    expect((event as { dedupeKey?: string }).dedupeKey).toMatch(
      new RegExp(`^ce:owner:\\${PRIMARY}:emp-2:\\d+$`)
    );
  });

  it("fires without a name when the member row is missing", async () => {
    vi.mocked(getTeamMember).mockResolvedValueOnce(null);
    await fireOwnerAssignedEvent(BIZ, {
      canonicalE164: PRIMARY,
      previousOwnerEmployeeId: "emp-1",
      ownerEmployeeId: "emp-2"
    });
    expect(fireContactEvent).toHaveBeenCalledTimes(1);
    const [, event] = vi.mocked(fireContactEvent).mock.calls[0];
    expect(event).not.toHaveProperty("ownerName");
  });

  it("fires without a name when the roster read fails (best-effort lookup)", async () => {
    vi.mocked(getTeamMember).mockRejectedValueOnce(new Error("db down"));
    await fireOwnerAssignedEvent(BIZ, {
      canonicalE164: PRIMARY,
      previousOwnerEmployeeId: null,
      ownerEmployeeId: "emp-3"
    });
    expect(fireContactEvent).toHaveBeenCalledTimes(1);
    const [, event] = vi.mocked(fireContactEvent).mock.calls[0];
    expect(event).toMatchObject({ kind: "owner_assigned" });
    expect(event).not.toHaveProperty("ownerName");
  });
});
