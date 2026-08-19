/**
 * resolveCallerEmployeeId (src/lib/db/caller-employee.ts): which roster
 * member a signed-in caller IS.
 *
 * The defect this guards (HQ, Aug 19 2026): the owner's login has no
 * business_members row (ownership is implicit via businesses.owner_email),
 * so "My tasks" told the account's own owner that their login wasn't
 * linked, on a roster whose only member IS them. The owner path must
 * recognize their roster row the way the Employees page badges it (phone
 * matches an owner number, row active), and only for the real owner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/contact-names", () => ({ businessOwnerNumbers: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn() }));

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { resolveCallerEmployeeId } from "@/lib/db/caller-employee";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers } from "@/lib/db/employees";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PHONE = "+16026951142";

type TableResults = {
  business_members?: { employee_id: string | null } | null;
  businesses?: { owner_email: string | null } | null;
};

/** Chainable stub covering the two maybeSingle() lookups the helper makes. */
function stubClient(results: TableResults, calls: string[] = []) {
  return {
    from(table: string) {
      calls.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        maybeSingle: async () => ({
          data: results[table as keyof TableResults] ?? null,
          error: null
        })
      };
      return chain;
    }
  } as never;
}

const member = (over: Record<string, unknown> = {}) => ({
  id: "mem-owner",
  name: "Brian",
  phone_e164: OWNER_PHONE,
  active: true,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(businessOwnerNumbers).mockResolvedValue([OWNER_PHONE]);
  vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
});

describe("resolveCallerEmployeeId", () => {
  it("returns null without an email, before any query", () => {
    const calls: string[] = [];
    void stubClient({}, calls);
    return Promise.all([
      expect(resolveCallerEmployeeId(BIZ, null, stubClient({}, calls))).resolves.toBeNull(),
      expect(resolveCallerEmployeeId(BIZ, undefined, stubClient({}, calls))).resolves.toBeNull()
    ]).then(() => expect(calls).toEqual([]));
  });

  it("prefers the explicit business_members link and stops there", async () => {
    const calls: string[] = [];
    const client = stubClient(
      { business_members: { employee_id: "mem-linked" } },
      calls
    );
    await expect(
      resolveCallerEmployeeId(BIZ, "Staff@Example.com", client)
    ).resolves.toBe("mem-linked");
    expect(calls).toEqual(["business_members"]);
    expect(listTeamMembers).not.toHaveBeenCalled();
  });

  it("falls through a member row whose employee link is empty", async () => {
    const client = stubClient({
      business_members: { employee_id: null },
      businesses: null
    });
    await expect(
      resolveCallerEmployeeId(BIZ, "staff@example.com", client)
    ).resolves.toBeNull();
  });

  it("resolves the owner to their phone-matched active roster row", async () => {
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBe(
      "mem-owner"
    );
  });

  it("matches owner_email case-insensitively, like getBusinessRoleForEmail", async () => {
    // Signup can keep a mixed-case owner_email while auth emails are
    // lowercased; the check that ADMITS the caller to the page compares
    // normalized, so this one must too or the owner reads as unlinked.
    const client = stubClient({ businesses: { owner_email: "Owner@Example.COM " } });
    await expect(
      resolveCallerEmployeeId(BIZ, "owner@example.com", client)
    ).resolves.toBe("mem-owner");
  });

  it("returns null when the business row is missing or has no owner_email", async () => {
    await expect(
      resolveCallerEmployeeId(BIZ, OWNER_EMAIL, stubClient({ businesses: null }))
    ).resolves.toBeNull();
    await expect(
      resolveCallerEmployeeId(
        BIZ,
        OWNER_EMAIL,
        stubClient({ businesses: { owner_email: null } })
      )
    ).resolves.toBeNull();
  });

  it("also resolves the owner on a multi-person roster", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ id: "mem-2", name: "Dave", phone_e164: "+15555550102" }),
      member()
    ] as never);
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBe(
      "mem-owner"
    );
  });

  it("returns null for a non-owner with no member row", async () => {
    const client = stubClient({ businesses: { owner_email: "someone-else@example.com" } });
    await expect(
      resolveCallerEmployeeId(BIZ, "stranger@example.com", client)
    ).resolves.toBeNull();
    expect(listTeamMembers).not.toHaveBeenCalled();
  });

  it("returns null when no roster phone matches an owner number", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ phone_e164: "+15555550199" })
    ] as never);
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBeNull();
  });

  it("never hands back an inactive roster row", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member({ active: false })] as never);
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBeNull();
  });

  it("uses the default service client when none is passed", async () => {
    defaultClientSpy.mockReturnValue(
      stubClient({ business_members: { employee_id: "mem-x" } })
    );
    await expect(resolveCallerEmployeeId(BIZ, "a@b.com")).resolves.toBe("mem-x");
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null (and warns) instead of throwing on a read failure", async () => {
    vi.mocked(listTeamMembers).mockRejectedValue(new Error("boom"));
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("survives a non-Error failure too", async () => {
    vi.mocked(listTeamMembers).mockRejectedValue("string failure");
    const client = stubClient({ businesses: { owner_email: OWNER_EMAIL } });
    await expect(resolveCallerEmployeeId(BIZ, OWNER_EMAIL, client)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
