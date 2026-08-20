import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));
vi.mock("@/lib/contacts/edit-events", () => ({
  fireTagChangeEvents: vi.fn(),
  fireOwnerAssignedEvent: vi.fn()
}));

import {
  applyBulkContactAction,
  BulkContactError,
  BULK_MAX_CONTACTS
} from "../src/lib/contacts/bulk";
import {
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { getTeamMember } from "@/lib/db/employees";
import {
  fireOwnerAssignedEvent,
  fireTagChangeEvents
} from "@/lib/contacts/edit-events";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY_A = "+15550001111";
const KEY_B = "+15550002222";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

const FAKE_DB = { fake: true } as never;

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    customer_e164: KEY_A,
    tags: [] as string[],
    alias_e164s: [] as string[],
    owner_employee_id: null as string | null,
    ...overrides
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyBulkContactAction validation", () => {
  it("refuses an empty selection", async () => {
    await expect(
      applyBulkContactAction(BIZ, [], { action: "add_tag", tag: "VIP" }, FAKE_DB)
    ).rejects.toThrow(BulkContactError);
  });

  it("refuses more than the per-request cap", async () => {
    const keys = Array.from({ length: BULK_MAX_CONTACTS + 1 }, (_, i) => `+1555000${i}`);
    await expect(
      applyBulkContactAction(BIZ, keys, { action: "add_tag", tag: "VIP" }, FAKE_DB)
    ).rejects.toThrow(/At most 200 contacts/);
  });

  it("refuses a blank tag (whitespace only)", async () => {
    await expect(
      applyBulkContactAction(BIZ, [KEY_A], { action: "remove_tag", tag: "   " }, FAKE_DB)
    ).rejects.toThrow("Enter a tag.");
  });

  it("refuses an over-long tag", async () => {
    await expect(
      applyBulkContactAction(BIZ, [KEY_A], { action: "add_tag", tag: "x".repeat(41) }, FAKE_DB)
    ).rejects.toThrow(/at most 40 characters/);
  });

  it("refuses assigning someone who is not on this business's roster", async () => {
    vi.mocked(getTeamMember).mockResolvedValueOnce(null);
    await expect(
      applyBulkContactAction(
        BIZ,
        [KEY_A],
        { action: "assign_owner", employeeId: EMPLOYEE },
        FAKE_DB
      )
    ).rejects.toThrow(/not on this business's roster/);
    expect(getTeamMember).toHaveBeenCalledWith(BIZ, EMPLOYEE, FAKE_DB);
    // Refused for the whole request: no contact was even read.
    expect(getCustomerMemory).not.toHaveBeenCalled();
  });

  it("builds its own service client when none is injected", async () => {
    const injected = { injected: true };
    defaultClientSpy.mockReturnValueOnce(injected);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    await applyBulkContactAction(BIZ, [KEY_A], { action: "add_tag", tag: "VIP" });
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
    expect(getCustomerMemory).toHaveBeenCalledWith(BIZ, KEY_A, injected);
  });
});

describe("add_tag", () => {
  it("writes through the shared per-contact path and fires the tag diff", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      contactRow({ tags: ["New Lead"], alias_e164s: ["+15550009999"] })
    );

    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );

    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY_A,
      { tags: ["New Lead", "VIP"] },
      FAKE_DB
    );
    expect(fireTagChangeEvents).toHaveBeenCalledWith(BIZ, {
      canonicalE164: KEY_A,
      aliasE164s: ["+15550009999"],
      previousTags: ["New Lead"],
      nextTags: ["New Lead", "VIP"]
    });
    expect(summary).toEqual({
      results: [{ key: KEY_A, ok: true }],
      updated: 1,
      failed: 0
    });
  });

  it("trims the tag, and a null alias column reads as no aliases", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(contactRow({ alias_e164s: null }));
    await applyBulkContactAction(BIZ, [KEY_A], { action: "add_tag", tag: "  VIP  " }, FAKE_DB);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY_A,
      { tags: ["VIP"] },
      FAKE_DB
    );
    expect(fireTagChangeEvents).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ aliasE164s: [] })
    );
  });

  it("is a no-op (still ok) when the contact already has the tag, case-insensitively", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(contactRow({ tags: [" vip "] }));
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(fireTagChangeEvents).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });

  it("reports a per-contact failure instead of silently dropping the tag at the cap", async () => {
    const full = Array.from({ length: 25 }, (_, i) => `tag${i}`);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(contactRow({ tags: full }));
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual({
      key: KEY_A,
      ok: false,
      error: "This contact already has the maximum of 25 tags"
    });
    expect(summary).toMatchObject({ updated: 0, failed: 1 });
  });

  it("writes against the resolved PRIMARY key when the requested key is an alias", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      contactRow({ customer_e164: KEY_B })
    );
    await applyBulkContactAction(BIZ, [KEY_A], { action: "add_tag", tag: "VIP" }, FAKE_DB);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY_B,
      { tags: ["VIP"] },
      FAKE_DB
    );
    expect(fireTagChangeEvents).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ canonicalE164: KEY_B })
    );
    // The RESULT still names the key the caller sent, so the UI can match it.
    expect(vi.mocked(getCustomerMemory)).toHaveBeenCalledWith(BIZ, KEY_A, FAKE_DB);
  });
});

describe("remove_tag", () => {
  it("removes with whitespace-tolerant, case-insensitive identity", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      contactRow({ tags: [" VIP ", "New Lead"] })
    );
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "remove_tag", tag: "vip" },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY_A,
      { tags: ["New Lead"] },
      FAKE_DB
    );
    expect(fireTagChangeEvents).toHaveBeenCalledWith(BIZ, {
      canonicalE164: KEY_A,
      aliasE164s: [],
      previousTags: [" VIP ", "New Lead"],
      nextTags: ["New Lead"]
    });
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });

  it("is a no-op (still ok) when the tag is not on the contact", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(contactRow({ tags: ["New Lead"] }));
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "remove_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(fireTagChangeEvents).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });

  it("treats a contact whose tags column is null as having no tags", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(contactRow({ tags: null }));
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "remove_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });
});

describe("assign_owner", () => {
  it("assigns through the shared path and fires owner_assigned", async () => {
    vi.mocked(getTeamMember).mockResolvedValueOnce({ id: EMPLOYEE, name: "Dana" } as never);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      contactRow({ owner_employee_id: "33333333-3333-4333-8333-333333333333" })
    );
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "assign_owner", employeeId: EMPLOYEE },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY_A,
      { ownerEmployeeId: EMPLOYEE },
      FAKE_DB
    );
    expect(fireOwnerAssignedEvent).toHaveBeenCalledWith(BIZ, {
      canonicalE164: KEY_A,
      previousOwnerEmployeeId: "33333333-3333-4333-8333-333333333333",
      ownerEmployeeId: EMPLOYEE
    });
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });

  it("is a no-op (still ok, no refire) when the contact is already theirs", async () => {
    vi.mocked(getTeamMember).mockResolvedValueOnce({ id: EMPLOYEE, name: "Dana" } as never);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      contactRow({ owner_employee_id: EMPLOYEE })
    );
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "assign_owner", employeeId: EMPLOYEE },
      FAKE_DB
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(fireOwnerAssignedEvent).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual({ key: KEY_A, ok: true });
  });
});

describe("row-by-row failure model", () => {
  it("records a not-found contact and keeps going", async () => {
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(contactRow({ customer_e164: KEY_B }));
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A, KEY_B],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(summary.results).toEqual([
      { key: KEY_A, ok: false, error: "Contact not found" },
      { key: KEY_B, ok: true }
    ]);
    expect(summary).toMatchObject({ updated: 1, failed: 1 });
  });

  it("converts a thrown Error into that contact's failure and continues", async () => {
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(contactRow())
      .mockResolvedValueOnce(contactRow({ customer_e164: KEY_B }));
    vi.mocked(updateCustomerOwnerFields)
      .mockRejectedValueOnce(new Error("updateCustomerOwnerFields: boom"))
      .mockResolvedValueOnce(undefined);
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A, KEY_B],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(summary.results[0]).toEqual({
      key: KEY_A,
      ok: false,
      error: "updateCustomerOwnerFields: boom"
    });
    expect(summary.results[1]).toEqual({ key: KEY_B, ok: true });
  });

  it("labels a non-Error throw as unexpected", async () => {
    vi.mocked(getCustomerMemory).mockRejectedValueOnce("string failure");
    const summary = await applyBulkContactAction(
      BIZ,
      [KEY_A],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    expect(summary.results[0]).toEqual({
      key: KEY_A,
      ok: false,
      error: "Unexpected error"
    });
  });

  it("applies contacts SEQUENTIALLY, in request order", async () => {
    const order: string[] = [];
    vi.mocked(getCustomerMemory).mockImplementation(async (_biz, key) => {
      order.push(`read:${key}`);
      return contactRow({ customer_e164: key as string });
    });
    vi.mocked(updateCustomerOwnerFields).mockImplementation(async (_biz, key) => {
      order.push(`write:${key}`);
    });
    await applyBulkContactAction(
      BIZ,
      [KEY_A, KEY_B],
      { action: "add_tag", tag: "VIP" },
      FAKE_DB
    );
    // Each contact's read AND write finish before the next contact starts,
    // so automations fire exactly as one-by-one edits would.
    expect(order).toEqual([
      `read:${KEY_A}`,
      `write:${KEY_A}`,
      `read:${KEY_B}`,
      `write:${KEY_B}`
    ]);
  });
});
