import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { assertCronAuth } from "@/lib/cron-auth";
import {
  DATA_BACKUP_BUCKET,
  deleteDataBackupRow,
  getDataBackup,
  upsertDataBackup
} from "@/lib/db/data-backups";
import {
  getCustomerProfileByEmail,
  getCustomerProfileById,
  incrementLifetimeSubscriptionCount,
  isWithinLifetimeRefundWindow,
  markFirstPaidIfUnset,
  markRefundUsed,
  normalizeEmailForProfile,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import {
  listRefundsForSubscription,
  recordSubscriptionRefund
} from "@/lib/db/subscription-refunds";
import { deleteBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { isCanceledInGrace, listGraceExpiredSubscriptions } from "@/lib/db/subscriptions";

function tableClient(result: unknown, error: unknown = null) {
  const chain = {
    upsert: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: result, error }),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: result, error }),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValue({ error })
  };
  return { from: vi.fn(() => chain), chain };
}

describe("node cron auth", () => {
  beforeEach(() => {
    delete process.env.INTERNAL_CRON_SECRET;
  });

  it("accepts only the configured internal cron secret", () => {
    process.env.INTERNAL_CRON_SECRET = " secret ";
    expect(assertCronAuth(new Request("http://x", { headers: { authorization: "Bearer secret" } }))).toBe(true);
    expect(assertCronAuth(new Request("http://x", { headers: { authorization: "secret" } }))).toBe(true);
    expect(assertCronAuth(new Request("http://x", { headers: { authorization: "Bearer wrong" } }))).toBe(false);
  });

  it("rejects missing secret/header/token", () => {
    expect(assertCronAuth(new Request("http://x", { headers: { authorization: "Bearer secret" } }))).toBe(false);
    process.env.INTERNAL_CRON_SECRET = "secret";
    expect(assertCronAuth(new Request("http://x"))).toBe(false);
    expect(assertCronAuth(new Request("http://x", { headers: { authorization: "Bearer   " } }))).toBe(false);
  });

  it("rejects if constant-time comparison throws", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      return {
        ...actual,
        timingSafeEqual: vi.fn(() => {
          throw new Error("comparison failed");
        })
      };
    });
    const { assertCronAuth: throwingAssertCronAuth } = await import("@/lib/cron-auth");
    process.env.INTERNAL_CRON_SECRET = "secret";
    expect(
      throwingAssertCronAuth(new Request("http://x", { headers: { authorization: "Bearer secret" } }))
    ).toBe(false);
    vi.doUnmock("node:crypto");
  });

});

describe("data backup db helpers", () => {
  it("upserts, reads, returns null on read error, and deletes", async () => {
    const row = {
      business_id: "biz",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: "backups/biz/latest.tar.gz",
      sha256: "abc",
      size_bytes: 12,
      created_at: "now",
      updated_at: "now"
    };
    const { chain } = tableClient(row);
    const client = { from: vi.fn(() => chain) } as never;

    await expect(
      upsertDataBackup({ businessId: "biz", storagePath: row.storage_path, sha256: "abc", sizeBytes: 12 }, client)
    ).resolves.toEqual(row);
    expect(chain.upsert).toHaveBeenCalledWith(expect.objectContaining({ storage_bucket: DATA_BACKUP_BUCKET }), {
      onConflict: "business_id"
    });
    await expect(getDataBackup("biz", client)).resolves.toEqual(row);
    chain.single.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    await expect(getDataBackup("biz", client)).resolves.toBeNull();
    await expect(deleteDataBackupRow("biz", client)).resolves.toBeUndefined();
  });

  it("uses default service client for backup writes and deletes", async () => {
    const row = { business_id: "biz" };
    const upsertChain = tableClient(row).chain;
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => upsertChain) } as never);
    await expect(
      upsertDataBackup({ businessId: "biz", storagePath: "p", sha256: "s", sizeBytes: 1 })
    ).resolves.toEqual(row);

    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => deleteChain) } as never);
    await expect(deleteDataBackupRow("biz")).resolves.toBeUndefined();
  });

  it("throws db helper errors", async () => {
    const failing = tableClient(null, { message: "boom" }).chain;
    const client = { from: vi.fn(() => failing) } as never;
    await expect(
      upsertDataBackup({ businessId: "biz", storagePath: "p", sha256: "s", sizeBytes: 1 }, client)
    ).rejects.toThrow("upsertDataBackup: boom");
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { message: "delete failed" } })
    };
    await expect(deleteDataBackupRow("biz", { from: vi.fn(() => deleteChain) } as never)).rejects.toThrow(
      "deleteDataBackupRow: delete failed"
    );
  });
});

describe("customer profile helpers", () => {
  it("normalizes emails and rejects malformed input", () => {
    expect(normalizeEmailForProfile(" First.Last+tag@GoogleMail.com ")).toBe("firstlast@gmail.com");
    expect(normalizeEmailForProfile("a+b@example.com")).toBe("a@example.com");
    expect(() => normalizeEmailForProfile("not-an-email")).toThrow("invalid email");
  });

  it("runs profile RPC helpers and validates return shapes", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: "prof-1", error: null })
      .mockResolvedValueOnce({ data: 4, error: null })
      .mockResolvedValueOnce({ data: 99, error: null })
      .mockResolvedValueOnce({ data: "not-number", error: null });
    const client = { rpc } as never;
    await expect(
      upsertCustomerProfile({ email: "User+tag@gmail.com", stripeCustomerId: "cus", signupIp: "1.2.3.4" }, client)
    ).resolves.toBe("prof-1");
    expect(rpc).toHaveBeenCalledWith("upsert_customer_profile", {
      p_normalized_email: "user@gmail.com",
      p_stripe_customer_id: "cus",
      p_last_signup_ip: "1.2.3.4"
    });
    await expect(incrementLifetimeSubscriptionCount("prof-1", client)).resolves.toBe(4);
    await expect(upsertCustomerProfile({ email: "x@example.com" }, client)).rejects.toThrow("expected uuid");
    await expect(incrementLifetimeSubscriptionCount("prof-1", client)).rejects.toThrow("expected number");
  });

  it("uses default service client for profile helpers", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      rpc: vi.fn().mockResolvedValue({ data: "prof-default", error: null })
    } as never);
    await expect(upsertCustomerProfile({ email: "default@example.com" })).resolves.toBe("prof-default");

    const row = {
      id: "prof-default",
      normalized_email: "default@example.com",
      stripe_customer_id: null,
      last_signup_ip: null,
      lifetime_subscription_count: 0,
      refund_used_at: null,
      first_paid_at: null,
      created_at: "now",
      updated_at: "now"
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => tableClient(row).chain) } as never);
    await expect(getCustomerProfileById("prof-default")).resolves.toEqual(row);
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => tableClient(row).chain) } as never);
    await expect(getCustomerProfileByEmail("default@example.com")).resolves.toEqual(row);
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      rpc: vi.fn().mockResolvedValue({ data: 1, error: null })
    } as never);
    await expect(incrementLifetimeSubscriptionCount("prof-default")).resolves.toBe(1);

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({ error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => updateChain) } as never);
    await expect(markRefundUsed("prof-default", new Date())).resolves.toBeUndefined();
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => updateChain) } as never);
    await expect(markFirstPaidIfUnset("prof-default", new Date())).resolves.toBeUndefined();
  });

  it("surfaces RPC and update errors", async () => {
    const rpcClient = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "rpc failed" } }) } as never;
    await expect(upsertCustomerProfile({ email: "x@example.com" }, rpcClient)).rejects.toThrow("rpc failed");
    await expect(incrementLifetimeSubscriptionCount("prof", rpcClient)).rejects.toThrow("rpc failed");

    const { chain } = tableClient(null, { message: "write failed" });
    const client = { from: vi.fn(() => chain) } as never;
    await expect(markRefundUsed("prof", new Date(), client)).rejects.toThrow("markRefundUsed: write failed");
    await expect(markFirstPaidIfUnset("prof", new Date(), client)).rejects.toThrow("markFirstPaidIfUnset: write failed");
  });

  it("reads profiles and calculates refund window", async () => {
    const row = {
      id: "prof-1",
      normalized_email: "owner@example.com",
      stripe_customer_id: null,
      last_signup_ip: null,
      lifetime_subscription_count: 1,
      refund_used_at: null,
      first_paid_at: "2026-04-01T00:00:00.000Z",
      created_at: "now",
      updated_at: "now"
    };
    const { chain } = tableClient(row);
    const client = { from: vi.fn(() => chain) } as never;
    await expect(getCustomerProfileById("prof-1", client)).resolves.toEqual(row);
    await expect(getCustomerProfileByEmail("Owner@Example.com", client)).resolves.toEqual(row);
    chain.single.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    await expect(getCustomerProfileById("missing", client)).resolves.toBeNull();
    chain.single.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    await expect(getCustomerProfileByEmail("missing@example.com", client)).resolves.toBeNull();

    expect(isWithinLifetimeRefundWindow(row, new Date("2026-04-15T00:00:00.000Z"))).toBe(true);
    expect(isWithinLifetimeRefundWindow(row, new Date("2026-05-15T00:00:00.000Z"))).toBe(false);
    expect(isWithinLifetimeRefundWindow({ first_paid_at: null, refund_used_at: null })).toBe(false);
    expect(isWithinLifetimeRefundWindow({ first_paid_at: row.first_paid_at, refund_used_at: "used" })).toBe(false);
  });
});

describe("subscription refunds db helpers", () => {
  it("records, idempotently returns duplicates, lists, and throws errors", async () => {
    const row = {
      id: "refund-row",
      subscription_id: "sub-1",
      customer_profile_id: "prof-1",
      stripe_refund_id: "re_1",
      stripe_charge_id: "ch_1",
      amount_cents: 1000,
      currency: "usd",
      reason: "admin_force",
      created_at: "now"
    };
    const { chain } = tableClient(row);
    const client = { from: vi.fn(() => chain) } as never;
    await expect(
      recordSubscriptionRefund({
        subscriptionId: "sub-1",
        customerProfileId: "prof-1",
        stripeRefundId: "re_1",
        stripeChargeId: "ch_1",
        amountCents: 1000,
        reason: "admin_force"
      }, client)
    ).resolves.toEqual(row);
    await expect(listRefundsForSubscription("sub-1", client)).resolves.toEqual(row);

    chain.single.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dupe" } });
    chain.single.mockResolvedValueOnce({ data: row, error: null });
    await expect(
      recordSubscriptionRefund({
        subscriptionId: "sub-1",
        customerProfileId: null,
        stripeRefundId: "re_1",
        stripeChargeId: null,
        amountCents: 1000,
        currency: "eur",
        reason: "thirty_day_money_back"
      }, client)
    ).resolves.toEqual(row);

    chain.single.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dupe" } });
    chain.single.mockResolvedValueOnce({ data: null, error: { message: "lookup failed" } });
    await expect(
      recordSubscriptionRefund({
        subscriptionId: "sub-1",
        customerProfileId: null,
        stripeRefundId: "re_1",
        stripeChargeId: null,
        amountCents: 1000,
        reason: "thirty_day_money_back"
      }, client)
    ).rejects.toThrow("duplicate but lookup failed");

    chain.single.mockResolvedValueOnce({ data: null, error: { message: "insert failed" } });
    await expect(
      recordSubscriptionRefund({
        subscriptionId: "sub-1",
        customerProfileId: null,
        stripeRefundId: "re_2",
        stripeChargeId: null,
        amountCents: 1000,
        reason: "dispute_lost"
      }, client)
    ).rejects.toThrow("recordSubscriptionRefund: insert failed");

    chain.order.mockResolvedValueOnce({ data: null, error: { message: "list failed" } });
    await expect(listRefundsForSubscription("sub-1", client)).rejects.toThrow("listRefundsForSubscription: list failed");
    chain.order.mockResolvedValueOnce({ data: null, error: null });
    await expect(listRefundsForSubscription("sub-1", client)).resolves.toEqual([]);
  });

  it("uses default service client when no client is passed", async () => {
    const row = { business_id: "biz" };
    const { chain } = tableClient(row);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({ from: vi.fn(() => chain) } as never);
    await expect(getDataBackup("biz")).resolves.toEqual(row);

    const refundRow = {
      id: "refund-row",
      subscription_id: "sub-1",
      customer_profile_id: null,
      stripe_refund_id: "re_default",
      stripe_charge_id: null,
      amount_cents: 500,
      currency: "usd",
      reason: "admin_force",
      created_at: "now"
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      from: vi.fn(() => tableClient(refundRow).chain)
    } as never);
    await expect(
      recordSubscriptionRefund({
        subscriptionId: "sub-1",
        customerProfileId: null,
        stripeRefundId: "re_default",
        stripeChargeId: null,
        amountCents: 500,
        reason: "admin_force"
      })
    ).resolves.toEqual(refundRow);
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      from: vi.fn(() => tableClient([refundRow]).chain)
    } as never);
    await expect(listRefundsForSubscription("sub-1")).resolves.toEqual([refundRow]);
  });
});

describe("remaining lifecycle DB/auth helpers", () => {
  it("sets/deletes business rows and lists grace-expired subscriptions", async () => {
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null })
    };
    await expect(
      setBusinessCustomerProfile("biz", "prof", { from: vi.fn(() => updateChain) } as never)
    ).resolves.toBeUndefined();
    updateChain.eq.mockResolvedValueOnce({ error: { message: "bad" } });
    await expect(
      setBusinessCustomerProfile("biz", "prof", { from: vi.fn(() => updateChain) } as never)
    ).rejects.toThrow("setBusinessCustomerProfile: bad");

    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null })
    };
    await expect(deleteBusiness("biz", { from: vi.fn(() => deleteChain) } as never)).resolves.toBeUndefined();
    expect(deleteChain.delete).toHaveBeenCalled();
    deleteChain.eq.mockResolvedValueOnce({ error: { message: "delete failed" } });
    await expect(deleteBusiness("biz", { from: vi.fn(() => deleteChain) } as never)).rejects.toThrow(
      "deleteBusiness: delete failed"
    );

    const subRows = [{ id: "sub-1" }];
    const listChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: subRows, error: null })
    };
    await expect(
      listGraceExpiredSubscriptions(new Date("2026-05-01T00:00:00.000Z"), 10, {
        from: vi.fn(() => listChain)
      } as never)
    ).resolves.toEqual(subRows);
    listChain.limit.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      listGraceExpiredSubscriptions(new Date("2026-05-01T00:00:00.000Z"), 10, {
        from: vi.fn(() => listChain)
      } as never)
    ).resolves.toEqual([]);
    listChain.limit.mockResolvedValueOnce({ data: null, error: { message: "list failed" } });
    await expect(
      listGraceExpiredSubscriptions(new Date("2026-05-01T00:00:00.000Z"), 10, {
        from: vi.fn(() => listChain)
      } as never)
    ).rejects.toThrow("listGraceExpiredSubscriptions: list failed");

    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => updateChain) } as never);
    await expect(setBusinessCustomerProfile("biz", "prof")).resolves.toBeUndefined();
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => deleteChain) } as never);
    await expect(deleteBusiness("biz")).resolves.toBeUndefined();
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ from: vi.fn(() => listChain) } as never);
    listChain.limit.mockResolvedValueOnce({ data: subRows, error: null });
    await expect(listGraceExpiredSubscriptions()).resolves.toEqual(subRows);
  });

  it("finds auth users by email across pages and handles misses/errors", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: `u-page1-${i}`,
      email: `user${i}@example.com`
    }));
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce({ data: { users: fullPage }, error: null })
      .mockResolvedValueOnce({ data: { users: [{ id: "u2", email: "Owner@Example.com" }] }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      auth: { admin: { listUsers } }
    } as never);
    await expect(findAuthUserIdByEmail(" owner@example.com ")).resolves.toBe("u2");

    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }) } }
    } as never);
    await expect(findAuthUserIdByEmail("missing@example.com")).resolves.toBeNull();
    await expect(findAuthUserIdByEmail("  ")).resolves.toBeNull();

    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [{ id: "other", email: "other@example.com" }] },
            error: null
          })
        }
      }
    } as never);
    await expect(findAuthUserIdByEmail("short-miss@example.com")).resolves.toBeNull();

    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } }
    } as never);
    await expect(findAuthUserIdByEmail("error@example.com")).resolves.toBeNull();

    await expect(findAuthUserIdByEmail(undefined as unknown as string)).resolves.toBeNull();
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: null, error: null }) } }
    } as never);
    await expect(findAuthUserIdByEmail("nodata@example.com")).resolves.toBeNull();
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [{ id: "null-email", email: null }] },
            error: null
          })
        }
      }
    } as never);
    await expect(findAuthUserIdByEmail("null-email@example.com")).resolves.toBeNull();
  });

  it("covers canceled-in-grace predicate branches", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isCanceledInGrace({ status: "active", grace_ends_at: future, wiped_at: null })).toBe(false);
    expect(isCanceledInGrace({ status: "canceled", grace_ends_at: future, wiped_at: "now" })).toBe(false);
    expect(isCanceledInGrace({ status: "canceled", grace_ends_at: null, wiped_at: null })).toBe(false);
    expect(isCanceledInGrace({ status: "canceled", grace_ends_at: future, wiped_at: null })).toBe(true);
  });
});
