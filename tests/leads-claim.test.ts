import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/caller-employee", () => ({
  resolveCallerEmployeeId: vi.fn()
}));
vi.mock("@/lib/db/employees", () => ({
  getTeamMember: vi.fn()
}));
vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn()
}));
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({
  fireContactEvent: vi.fn()
}));
vi.mock("@/lib/leads/claim-stamp", () => ({
  stampLeadClaimOnRun: vi.fn()
}));

import { claimLeadForCaller } from "@/lib/leads/claim";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveCallerEmployeeId } from "@/lib/db/caller-employee";
import { getTeamMember } from "@/lib/db/employees";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { stampLeadClaimOnRun } from "@/lib/leads/claim-stamp";

const BIZ = "11111111-1111-4111-8111-111111111111";
const LEAD = "+14805551001";
const EMAIL = "dave@example.com";
const DAVE_ID = "22222222-2222-4222-8222-222222222222";
const RIVAL_ID = "33333333-3333-4333-8333-333333333333";
const AT = Date.parse("2026-08-19T10:20:00Z");

const DAVE = { id: DAVE_ID, name: "Dave", phone_e164: "+16025550001" };

type QueryResult = { data?: unknown; error: { message: string } | null };

/**
 * One-query chain mock for the compare-and-swap write: every chained op is
 * recorded so the test can assert the null-owner guard and the `.select()`
 * verification are actually on the query.
 */
function makeDb(result: QueryResult = { data: null, error: null }) {
  const ops: Array<{ name: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["update", "eq", "is", "select"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      ops.push({ name: m, args });
      return chain;
    });
  }
  (chain as { then: unknown }).then = (
    resolve: (v: QueryResult) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  const from = vi.fn(() => chain);
  return { db: { from } as never, from, ops };
}

function contactRow(over: Record<string, unknown> = {}) {
  return { customer_e164: LEAD, owner_employee_id: null, ...over };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(resolveCallerEmployeeId).mockResolvedValue(DAVE_ID);
  vi.mocked(getTeamMember).mockResolvedValue(DAVE as never);
  vi.mocked(getCustomerMemory).mockResolvedValue(contactRow() as never);
  vi.mocked(stampLeadClaimOnRun).mockResolvedValue({ stamped: true, runId: "run-1" });
  vi.mocked(fireContactEvent).mockResolvedValue(undefined);
});

describe("claimLeadForCaller", () => {
  it("claims an unowned lead: CAS write, run stamp, owner_assigned event", async () => {
    const { db, from, ops } = makeDb({ data: [{ customer_e164: LEAD }], error: null });
    const result = await claimLeadForCaller({
      businessId: BIZ,
      contactKey: LEAD,
      callerEmail: "dave@biz.test",
      db,
      nowMs: AT
    });
    expect(result).toEqual({ outcome: "claimed", ownerEmployeeId: DAVE_ID, ownerName: "Dave" });
    expect(resolveCallerEmployeeId).toHaveBeenCalledWith(BIZ, "dave@biz.test", db);

    expect(from).toHaveBeenCalledWith("contacts");
    const update = ops.find((o) => o.name === "update")!;
    expect(update.args[0]).toMatchObject({ owner_employee_id: DAVE_ID });
    expect(typeof (update.args[0] as { updated_at: string }).updated_at).toBe("string");
    // The race gate and its proof: only a still-null owner matches, and the
    // select() is what tells a zero-row no-op apart from a claim.
    expect(ops).toContainEqual({ name: "is", args: ["owner_employee_id", null] });
    expect(ops).toContainEqual({ name: "select", args: ["customer_e164"] });
    expect(ops).toContainEqual({ name: "eq", args: ["business_id", BIZ] });
    expect(ops).toContainEqual({ name: "eq", args: ["customer_e164", LEAD] });

    expect(stampLeadClaimOnRun).toHaveBeenCalledWith(db, {
      businessId: BIZ,
      leadE164: LEAD,
      claimedByE164: DAVE.phone_e164,
      claimedByName: "Dave",
      nowMs: AT
    });
    expect(fireContactEvent).toHaveBeenCalledWith(BIZ, {
      kind: "owner_assigned",
      contact: { e164: LEAD },
      ownerName: "Dave",
      dedupeKey: `ce:owner:${LEAD}:${DAVE_ID}:${AT}`
    });
  });

  it("defaults the client and the clock when the caller passes neither", async () => {
    const { db } = makeDb({ data: [{ customer_e164: LEAD }], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.spyOn(Date, "now").mockReturnValue(AT + 7);
    const result = await claimLeadForCaller({
      businessId: BIZ,
      contactKey: LEAD,
      callerEmail: "dave@biz.test"
    });
    expect(result.outcome).toBe("claimed");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(fireContactEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ dedupeKey: `ce:owner:${LEAD}:${DAVE_ID}:${AT + 7}` })
    );
    // The stamp inherits the undefined nowMs (it defaults its own clock).
    expect(stampLeadClaimOnRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ nowMs: undefined })
    );
  });

  it("writes against the surviving PRIMARY key when given a merged-away alias", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(
      contactRow({ customer_e164: LEAD }) as never
    );
    const { db, ops } = makeDb({ data: [{ customer_e164: LEAD }], error: null });
    await claimLeadForCaller({
      businessId: BIZ,
      contactKey: "+19998887777",
      callerEmail: "dave@biz.test",
      db,
      nowMs: AT
    });
    expect(getCustomerMemory).toHaveBeenCalledWith(BIZ, "+19998887777", db);
    expect(ops).toContainEqual({ name: "eq", args: ["customer_e164", LEAD] });
    expect(fireContactEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ contact: { e164: LEAD } })
    );
  });

  it("reports an unlinked login without touching the contact", async () => {
    vi.mocked(resolveCallerEmployeeId).mockResolvedValue(null);
    const { db, from } = makeDb();
    expect(
      await claimLeadForCaller({ businessId: BIZ, contactKey: LEAD, callerEmail: null, db })
    ).toEqual({ outcome: "not_linked" });
    expect(from).not.toHaveBeenCalled();
    expect(getCustomerMemory).not.toHaveBeenCalled();
  });

  it("treats a linked-but-vanished roster row as unlinked", async () => {
    vi.mocked(getTeamMember).mockResolvedValue(null);
    const { db, from } = makeDb();
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: LEAD,
        callerEmail: "dave@biz.test",
        db
      })
    ).toEqual({ outcome: "not_linked" });
    expect(from).not.toHaveBeenCalled();
  });

  it("reports a missing contact row as not found", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(null);
    const { db, from } = makeDb();
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: "email:" + EMAIL,
        callerEmail: "dave@biz.test",
        db
      })
    ).toEqual({ outcome: "not_found" });
    expect(from).not.toHaveBeenCalled();
  });

  it("is idempotent for a lead the caller already owns: stamp, no event", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(
      contactRow({ owner_employee_id: DAVE_ID }) as never
    );
    const { db, from } = makeDb();
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: LEAD,
        callerEmail: "dave@biz.test",
        db,
        nowMs: AT
      })
    ).toEqual({ outcome: "already_mine", ownerEmployeeId: DAVE_ID, ownerName: "Dave" });
    // No ownership write, no owner_assigned (nothing changed), but the
    // analytics stamp is re-asserted (backfills a legacy self-claim).
    expect(from).not.toHaveBeenCalled();
    expect(fireContactEvent).not.toHaveBeenCalled();
    expect(stampLeadClaimOnRun).toHaveBeenCalledWith(db, {
      businessId: BIZ,
      leadE164: LEAD,
      claimedByE164: DAVE.phone_e164,
      claimedByName: "Dave",
      nowMs: AT
    });
  });

  it("refuses a lead somebody else owns, naming them", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(
      contactRow({ owner_employee_id: RIVAL_ID }) as never
    );
    vi.mocked(getTeamMember)
      .mockResolvedValueOnce(DAVE as never)
      .mockResolvedValueOnce({ id: RIVAL_ID, name: "Gabby" } as never);
    const { db, from } = makeDb();
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: LEAD,
        callerEmail: "dave@biz.test",
        db
      })
    ).toEqual({ outcome: "already_owned", ownerName: "Gabby" });
    expect(from).not.toHaveBeenCalled();
    expect(stampLeadClaimOnRun).not.toHaveBeenCalled();
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("still refuses when the rival's roster row is gone or unreadable", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(
      contactRow({ owner_employee_id: RIVAL_ID }) as never
    );
    vi.mocked(getTeamMember)
      .mockResolvedValueOnce(DAVE as never)
      .mockResolvedValueOnce(null);
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: LEAD,
        callerEmail: "dave@biz.test",
        db: makeDb().db
      })
    ).toEqual({ outcome: "already_owned", ownerName: null });

    vi.mocked(getCustomerMemory).mockResolvedValue(
      contactRow({ owner_employee_id: RIVAL_ID }) as never
    );
    vi.mocked(getTeamMember)
      .mockResolvedValueOnce(DAVE as never)
      .mockRejectedValueOnce(new Error("roster down"));
    expect(
      await claimLeadForCaller({
        businessId: BIZ,
        contactKey: LEAD,
        callerEmail: "dave@biz.test",
        db: makeDb().db
      })
    ).toEqual({ outcome: "already_owned", ownerName: null });
  });

  it("surfaces a write error instead of pretending the claim landed", async () => {
    const { db } = makeDb({ data: null, error: { message: "db down" } });
    await expect(
      claimLeadForCaller({ businessId: BIZ, contactKey: LEAD, callerEmail: "dave@biz.test", db })
    ).rejects.toThrow("claimLeadForCaller: db down");
    expect(stampLeadClaimOnRun).not.toHaveBeenCalled();
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  describe("a zero-row CAS result is a lost race, never a claim", () => {
    it("names the winner from a fresh read", async () => {
      vi.mocked(getCustomerMemory)
        .mockResolvedValueOnce(contactRow() as never)
        .mockResolvedValueOnce(contactRow({ owner_employee_id: RIVAL_ID }) as never);
      vi.mocked(getTeamMember)
        .mockResolvedValueOnce(DAVE as never)
        .mockResolvedValueOnce({ id: RIVAL_ID, name: "Gabby" } as never);
      const { db } = makeDb({ data: null, error: null });
      expect(
        await claimLeadForCaller({
          businessId: BIZ,
          contactKey: LEAD,
          callerEmail: "dave@biz.test",
          db
        })
      ).toEqual({ outcome: "already_owned", ownerName: "Gabby" });
      expect(fireContactEvent).not.toHaveBeenCalled();
      expect(stampLeadClaimOnRun).not.toHaveBeenCalled();
    });

    it("reads a double-click race (our parallel request won) as already mine", async () => {
      vi.mocked(getCustomerMemory)
        .mockResolvedValueOnce(contactRow() as never)
        .mockResolvedValueOnce(contactRow({ owner_employee_id: DAVE_ID }) as never);
      const { db } = makeDb({ data: [], error: null });
      expect(
        await claimLeadForCaller({
          businessId: BIZ,
          contactKey: LEAD,
          callerEmail: "dave@biz.test",
          db
        })
      ).toEqual({ outcome: "already_mine", ownerEmployeeId: DAVE_ID, ownerName: "Dave" });
    });

    it("reads a vanished row as not found, and a re-nulled owner as owned by unknown", async () => {
      vi.mocked(getCustomerMemory)
        .mockResolvedValueOnce(contactRow() as never)
        .mockResolvedValueOnce(null);
      expect(
        await claimLeadForCaller({
          businessId: BIZ,
          contactKey: LEAD,
          callerEmail: "dave@biz.test",
          db: makeDb({ data: null, error: null }).db
        })
      ).toEqual({ outcome: "not_found" });

      // Degenerate: zero rows matched yet the re-read shows no owner (the
      // row was cleared in between). Refuse without a name; a retry can win.
      vi.mocked(getCustomerMemory)
        .mockResolvedValueOnce(contactRow() as never)
        .mockResolvedValueOnce(contactRow({ owner_employee_id: null }) as never);
      expect(
        await claimLeadForCaller({
          businessId: BIZ,
          contactKey: LEAD,
          callerEmail: "dave@biz.test",
          db: makeDb({ data: null, error: null }).db
        })
      ).toEqual({ outcome: "already_owned", ownerName: null });
    });
  });
});
