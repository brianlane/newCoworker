import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  countActiveWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions
} from "@/lib/db/webhook-subscriptions";

function chain(terminal?: unknown) {
  const c = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    delete: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    single: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) };
}

const SUB = {
  id: "hook-1",
  business_id: "biz-1",
  event: "sms.inbound",
  target_url: "https://hooks.zapier.com/abc",
  active: true,
  last_cursor: "2026-07-01T00:00:00Z",
  consecutive_failures: 0,
  api_key_id: "key-1",
  created_at: "2026-07-01T00:00:00Z"
};

describe("webhook_subscriptions DB layer", () => {
  it("createWebhookSubscription inserts event/url/api-key and returns the row", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: SUB, error: null });
    const db = makeDb(c);
    const row = await createWebhookSubscription(
      {
        businessId: "biz-1",
        event: "sms.inbound",
        targetUrl: "https://hooks.zapier.com/abc",
        apiKeyId: "key-1"
      },
      db as never
    );
    expect(row).toEqual(SUB);
    expect(db.from).toHaveBeenCalledWith("webhook_subscriptions");
    expect(c.insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      event: "sms.inbound",
      target_url: "https://hooks.zapier.com/abc",
      api_key_id: "key-1"
    });
  });

  it("createWebhookSubscription defaults api_key_id to null and throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: SUB, error: null });
    await createWebhookSubscription(
      { businessId: "biz-1", event: "sms.inbound", targetUrl: "https://x.example/h" },
      makeDb(c) as never
    );
    expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ api_key_id: null }));

    const err = chain();
    err.single.mockResolvedValue({ data: null, error: { message: "db" } });
    await expect(
      createWebhookSubscription(
        { businessId: "b", event: "sms.inbound", targetUrl: "https://x.example/h" },
        makeDb(err) as never
      )
    ).rejects.toThrow(/db/);
  });

  it("listWebhookSubscriptions returns only active hooks for the business", async () => {
    const c = chain({ data: [SUB], error: null });
    const db = makeDb(c);
    await expect(listWebhookSubscriptions("biz-1", db as never)).resolves.toEqual([SUB]);
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(c.eq).toHaveBeenCalledWith("active", true);

    await expect(
      listWebhookSubscriptions("b", makeDb(chain({ data: null, error: null })) as never)
    ).resolves.toEqual([]);
    await expect(
      listWebhookSubscriptions("b", makeDb(chain({ data: null, error: { message: "db" } })) as never)
    ).rejects.toThrow(/db/);
  });

  it("countActiveWebhookSubscriptions returns the exact count", async () => {
    await expect(
      countActiveWebhookSubscriptions("b", makeDb(chain({ count: 2, error: null })) as never)
    ).resolves.toBe(2);
    await expect(
      countActiveWebhookSubscriptions("b", makeDb(chain({ count: null, error: null })) as never)
    ).resolves.toBe(0);
    await expect(
      countActiveWebhookSubscriptions(
        "b",
        makeDb(chain({ count: null, error: { message: "db" } })) as never
      )
    ).rejects.toThrow(/db/);
  });

  it("deleteWebhookSubscription hard-deletes scoped to the business", async () => {
    const c = chain({ data: [{ id: "hook-1" }], error: null });
    const db = makeDb(c);
    await expect(deleteWebhookSubscription("biz-1", "hook-1", db as never)).resolves.toBe(true);
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("id", "hook-1");
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz-1");

    await expect(
      deleteWebhookSubscription("biz-1", "gone", makeDb(chain({ data: [], error: null })) as never)
    ).resolves.toBe(false);
    await expect(
      deleteWebhookSubscription("biz-1", "gone", makeDb(chain({ data: null, error: null })) as never)
    ).resolves.toBe(false);
    await expect(
      deleteWebhookSubscription(
        "b",
        "h",
        makeDb(chain({ data: null, error: { message: "db" } })) as never
      )
    ).rejects.toThrow(/db/);
  });

  it("every helper falls back to the default service client when none is injected", async () => {
    const createChain = chain();
    createChain.single.mockResolvedValue({ data: SUB, error: null });

    const dbs = [
      makeDb(createChain),
      makeDb(chain({ data: [], error: null })),
      makeDb(chain({ count: 0, error: null })),
      makeDb(chain({ data: [], error: null }))
    ];
    dbs.forEach((db) => defaultClientSpy.mockReturnValueOnce(db));

    await createWebhookSubscription({
      businessId: "b",
      event: "sms.inbound",
      targetUrl: "https://x.example/h"
    });
    await listWebhookSubscriptions("b");
    await countActiveWebhookSubscriptions("b");
    await deleteWebhookSubscription("b", "h");
    expect(defaultClientSpy).toHaveBeenCalledTimes(4);
  });
});
