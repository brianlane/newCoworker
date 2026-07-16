/**
 * Email campaigns DB access (src/lib/campaigns/db.ts): success + error
 * paths for every helper, guarded transitions, and the idempotent
 * recipient-snapshot insert.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  deleteEmailCampaign,
  getEmailCampaign,
  insertCampaignRecipients,
  insertEmailCampaign,
  listDueScheduledCampaigns,
  listEmailCampaigns,
  listPendingRecipients,
  listSendingCampaigns,
  markRecipient,
  patchEmailCampaign,
  transitionEmailCampaign
} from "@/lib/campaigns/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "lte", "is", "not", "order", "limit", "contains"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn();
  c.maybeSingle = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listEmailCampaigns / getEmailCampaign", () => {
  it("lists (explicit client) and gets (default client)", async () => {
    const c = chain({ data: [{ id: CAMPAIGN }], error: null });
    expect(await listEmailCampaigns(BIZ, makeDb(c))).toEqual([{ id: CAMPAIGN }]);

    const g = chain();
    g.maybeSingle.mockResolvedValue({ data: { id: CAMPAIGN }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(g));
    expect(await getEmailCampaign(BIZ, CAMPAIGN)).toEqual({ id: CAMPAIGN });
  });

  it("null payloads coerce and errors throw", async () => {
    const empty = chain({ data: null, error: null });
    expect(await listEmailCampaigns(BIZ, makeDb(empty))).toEqual([]);
    const g = chain();
    g.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getEmailCampaign(BIZ, CAMPAIGN, makeDb(g))).toBeNull();

    await expect(
      listEmailCampaigns(BIZ, makeDb(chain({ data: null, error: { message: "l" } })))
    ).rejects.toThrow(/l/);
    const ge = chain();
    ge.maybeSingle.mockResolvedValue({ data: null, error: { message: "g" } });
    await expect(getEmailCampaign(BIZ, CAMPAIGN, makeDb(ge))).rejects.toThrow(/g/);
  });
});

describe("insert / patch / delete", () => {
  const row = { business_id: BIZ, subject: "s", body_md: "b", audience_tag: "" };

  it("inserts and returns the row; throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: CAMPAIGN, ...row }, error: null });
    expect(await insertEmailCampaign(row, makeDb(c))).toMatchObject({ id: CAMPAIGN });

    const e = chain();
    e.single.mockResolvedValue({ data: null, error: { message: "ins" } });
    await expect(insertEmailCampaign(row, makeDb(e))).rejects.toThrow(/ins/);
  });

  it("patches with updated_at and deletes; throws on errors", async () => {
    const c = chain({ error: null });
    await patchEmailCampaign(BIZ, CAMPAIGN, { subject: "t" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "t", updated_at: expect.any(String) })
    );
    await expect(
      patchEmailCampaign(BIZ, CAMPAIGN, {}, makeDb(chain({ error: { message: "p" } })))
    ).rejects.toThrow(/p/);

    await deleteEmailCampaign(BIZ, CAMPAIGN, makeDb(chain({ error: null })));
    await expect(
      deleteEmailCampaign(BIZ, CAMPAIGN, makeDb(chain({ error: { message: "d" } })))
    ).rejects.toThrow(/d/);
  });
});

describe("transitionEmailCampaign", () => {
  it("reports whether the guarded transition moved a row", async () => {
    const moved = chain({ data: [{ id: CAMPAIGN }], error: null });
    expect(
      await transitionEmailCampaign(BIZ, CAMPAIGN, "scheduled", { status: "sending" }, makeDb(moved))
    ).toBe(true);
    expect(moved.eq).toHaveBeenCalledWith("status", "scheduled");

    const lost = chain({ data: [], error: null });
    expect(
      await transitionEmailCampaign(BIZ, CAMPAIGN, "scheduled", { status: "sending" }, makeDb(lost))
    ).toBe(false);

    await expect(
      transitionEmailCampaign(
        BIZ,
        CAMPAIGN,
        "scheduled",
        { status: "sending" },
        makeDb(chain({ data: null, error: { message: "t" } }))
      )
    ).rejects.toThrow(/t/);
  });
});

describe("due/sending scans", () => {
  it("filters by status and coerces null data", async () => {
    const due = chain({ data: [{ id: CAMPAIGN }], error: null });
    expect(await listDueScheduledCampaigns("2026-07-16T00:00:00Z", makeDb(due))).toHaveLength(1);
    expect(due.eq).toHaveBeenCalledWith("status", "scheduled");
    expect(due.lte).toHaveBeenCalledWith("send_at", "2026-07-16T00:00:00Z");

    const sending = chain({ data: null, error: null });
    expect(await listSendingCampaigns(makeDb(sending))).toEqual([]);
    expect(sending.eq).toHaveBeenCalledWith("status", "sending");

    const dueNull = chain({ data: null, error: null });
    expect(await listDueScheduledCampaigns("2026-07-16T00:00:00Z", makeDb(dueNull))).toEqual([]);
    const pendingNull = chain({ data: null, error: null });
    expect(await listPendingRecipients(CAMPAIGN, 10, makeDb(pendingNull))).toEqual([]);

    await expect(
      listDueScheduledCampaigns("x", makeDb(chain({ data: null, error: { message: "due" } })))
    ).rejects.toThrow(/due/);
    await expect(
      listSendingCampaigns(makeDb(chain({ data: null, error: { message: "send" } })))
    ).rejects.toThrow(/send/);
  });
});

describe("default-client paths", () => {
  it("every helper resolves the service client when none is injected", async () => {
    const listChain = chain({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(listChain));
    await listEmailCampaigns(BIZ);
    await listDueScheduledCampaigns("2026-07-16T00:00:00Z");
    await listSendingCampaigns();
    await listPendingRecipients(CAMPAIGN, 10);
    await insertCampaignRecipients([
      { campaign_id: CAMPAIGN, business_id: BIZ, contact_id: "x", email: "a@b.c" }
    ]);
    await markRecipient("r1", "sent", null);
    await patchEmailCampaign(BIZ, CAMPAIGN, { subject: "t" });
    await transitionEmailCampaign(BIZ, CAMPAIGN, "draft", { status: "cancelled" });
    await deleteEmailCampaign(BIZ, CAMPAIGN);

    const insChain = chain();
    insChain.single.mockResolvedValue({ data: { id: CAMPAIGN }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(insChain));
    await insertEmailCampaign({ business_id: BIZ, subject: "s", body_md: "b", audience_tag: "" });
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("recipients", () => {
  it("snapshot insert is a no-op for empty rows and upserts ignoring duplicates", async () => {
    const c = chain({ error: null });
    await insertCampaignRecipients([], makeDb(c));
    expect(c.upsert).not.toHaveBeenCalled();

    const rows = [{ campaign_id: CAMPAIGN, business_id: BIZ, contact_id: "x", email: "a@b.c" }];
    await insertCampaignRecipients(rows, makeDb(c));
    expect(c.upsert).toHaveBeenCalledWith(rows, {
      onConflict: "campaign_id,contact_id",
      ignoreDuplicates: true
    });
    await expect(
      insertCampaignRecipients(rows, makeDb(chain({ error: { message: "snap" } })))
    ).rejects.toThrow(/snap/);
  });

  it("lists pending batches and stamps outcomes", async () => {
    const c = chain({ data: [{ id: "r1" }], error: null });
    expect(await listPendingRecipients(CAMPAIGN, 50, makeDb(c))).toEqual([{ id: "r1" }]);
    expect(c.limit).toHaveBeenCalledWith(50);
    await expect(
      listPendingRecipients(CAMPAIGN, 50, makeDb(chain({ data: null, error: { message: "lp" } })))
    ).rejects.toThrow(/lp/);

    const sent = chain({ error: null });
    await markRecipient("r1", "sent", null, makeDb(sent));
    expect(sent.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", sent_at: expect.any(String) })
    );
    const failed = chain({ error: null });
    await markRecipient("r1", "failed", "boom", makeDb(failed));
    expect(failed.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error_detail: "boom", sent_at: null })
    );
    await expect(
      markRecipient("r1", "sent", null, makeDb(chain({ error: { message: "mr" } })))
    ).rejects.toThrow(/mr/);
  });
});
