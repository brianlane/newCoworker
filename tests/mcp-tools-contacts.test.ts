import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/customer-memory/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/customer-memory/db")>();
  return {
    ...actual,
    createCustomerMemory: vi.fn(),
    getCustomerMemory: vi.fn(),
    updateCustomerOwnerFields: vi.fn()
  };
});
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));
vi.mock("@/lib/ai-flows/goal-hooks", () => ({ fireGoalEvent: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import { createContactTool, updateContactTool } from "@/lib/mcp/tools/contacts";
import {
  createCustomerMemory,
  CustomerExistsError,
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { getTeamMember } from "@/lib/db/employees";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

const ROW = {
  customer_e164: "+15550001111",
  display_name: "Ann",
  email: "ann@x.com",
  type: "customer",
  tags: [] as string[],
  owner_employee_id: null as string | null
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
});

describe("create_contact", () => {
  it("creates the profile and fires contact_created", async () => {
    vi.mocked(createCustomerMemory).mockResolvedValue(ROW as never);
    const result = await createContactTool.handler(
      { phone: "555-000-1111", name: "Ann", email: "ann@x.com", type: "customer" },
      AUTH
    );
    expect(createCustomerMemory).toHaveBeenCalledWith("biz-1", {
      customerE164: "+15550001111",
      displayName: "Ann",
      email: "ann@x.com",
      pinnedMd: null,
      type: "customer"
    });
    expect(fireContactEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        kind: "contact_created",
        contact: { e164: "+15550001111", name: "Ann", email: "ann@x.com" }
      })
    );
    expect(result).toEqual({
      created: true,
      phone: "+15550001111",
      name: "Ann",
      email: "ann@x.com",
      type: "customer"
    });
  });

  it("omits name/email from the trigger payload when absent", async () => {
    vi.mocked(createCustomerMemory).mockResolvedValue({
      ...ROW,
      display_name: null,
      email: null
    } as never);
    await createContactTool.handler({ phone: "+15550001111" }, AUTH);
    expect(createCustomerMemory).toHaveBeenCalledWith("biz-1", {
      customerE164: "+15550001111",
      displayName: null,
      email: null,
      pinnedMd: null
    });
    expect(fireContactEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ contact: { e164: "+15550001111" } })
    );
  });

  it("points duplicates at update_contact", async () => {
    vi.mocked(createCustomerMemory).mockRejectedValue(
      new CustomerExistsError("+15550001111")
    );
    await expect(
      createContactTool.handler({ phone: "+15550001111" }, AUTH)
    ).rejects.toThrow(/use update_contact/);
  });

  it("rethrows unexpected failures", async () => {
    vi.mocked(createCustomerMemory).mockRejectedValue(new Error("db down"));
    await expect(
      createContactTool.handler({ phone: "+15550001111" }, AUTH)
    ).rejects.toThrow("db down");
  });
});

describe("update_contact", () => {
  it("errors when the contact does not exist", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(null);
    await expect(
      updateContactTool.handler({ phone: "+15550001111", name: "Ann" }, AUTH)
    ).rejects.toThrow(/use create_contact/);
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("patches only the supplied fields (manual name provenance)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(ROW as never);
    const result = await updateContactTool.handler(
      { phone: "+15550001111", name: "Annie", notes: "VIP", type: "tester", birthday: null },
      AUTH
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith("biz-1", "+15550001111", {
      displayName: "Annie",
      nameSource: "manual",
      pinnedMd: "VIP",
      type: "tester",
      birthday: null
    });
    expect(fireContactEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: true, phone: "+15550001111" });
  });

  it("also patches email when supplied", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(ROW as never);
    await updateContactTool.handler({ phone: "+15550001111", email: "new@x.com" }, AUTH);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith("biz-1", "+15550001111", {
      email: "new@x.com"
    });
  });

  it("diffs tags and fires goal + tag_changed events for adds and removes", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      ...ROW,
      tags: ["New Lead", "Contacted"]
    } as never);
    await updateContactTool.handler(
      { phone: "+15550001111", tags: ["Contacted", "Booked"] },
      AUTH
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith("biz-1", "+15550001111", {
      tags: ["Contacted", "Booked"]
    });
    // "Booked" was added → goal fast-forward + tag_changed(added).
    expect(fireGoalEvent).toHaveBeenCalledTimes(1);
    expect(fireGoalEvent).toHaveBeenCalledWith("biz-1", "+15550001111", {
      kind: "tag_added",
      tag: "Booked"
    });
    // "New Lead" was removed → tag_changed(removed). "Contacted" unchanged.
    const tagEvents = vi
      .mocked(fireContactEvent)
      .mock.calls.filter(([, e]) => (e as { kind: string }).kind === "tag_changed");
    expect(tagEvents).toHaveLength(2);
    expect(tagEvents[0][1]).toMatchObject({ tag: "Booked", change: "added" });
    expect(tagEvents[1][1]).toMatchObject({ tag: "New Lead", change: "removed" });
  });

  it("handles a null stored tag set", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({ ...ROW, tags: null } as never);
    await updateContactTool.handler({ phone: "+15550001111", tags: ["Won"] }, AUTH);
    expect(fireGoalEvent).toHaveBeenCalledWith("biz-1", "+15550001111", {
      kind: "tag_added",
      tag: "Won"
    });
  });

  it("fires owner_assigned with the member's name on a real owner change", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(ROW as never);
    vi.mocked(getTeamMember).mockResolvedValue({ name: "Sam" } as never);
    await updateContactTool.handler(
      { phone: "+15550001111", owner_employee_id: "3b241101-e2bb-4255-8caf-4136c566a962" },
      AUTH
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith("biz-1", "+15550001111", {
      ownerEmployeeId: "3b241101-e2bb-4255-8caf-4136c566a962"
    });
    expect(fireContactEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ kind: "owner_assigned", ownerName: "Sam" })
    );
  });

  it("omits ownerName when the roster lookup fails", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(ROW as never);
    vi.mocked(getTeamMember).mockRejectedValue(new Error("gone"));
    await updateContactTool.handler(
      { phone: "+15550001111", owner_employee_id: "3b241101-e2bb-4255-8caf-4136c566a962" },
      AUTH
    );
    const call = vi.mocked(fireContactEvent).mock.calls[0][1] as Record<string, unknown>;
    expect(call.kind).toBe("owner_assigned");
    expect("ownerName" in call).toBe(false);
  });

  it("does not fire owner_assigned on a clear or a no-op owner write", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      ...ROW,
      owner_employee_id: "3b241101-e2bb-4255-8caf-4136c566a962"
    } as never);
    await updateContactTool.handler(
      { phone: "+15550001111", owner_employee_id: null },
      AUTH
    );
    await updateContactTool.handler(
      { phone: "+15550001111", owner_employee_id: "3b241101-e2bb-4255-8caf-4136c566a962" },
      AUTH
    );
    expect(fireContactEvent).not.toHaveBeenCalled();
  });
});
