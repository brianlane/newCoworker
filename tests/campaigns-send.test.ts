/**
 * Campaign sending engine (src/lib/campaigns/send.ts): unsubscribe token
 * mint/verify, audience snapshotting (suppression + tag filter + email
 * de-dupe), guarded promotion, batched sends with per-recipient outcomes,
 * completion, and per-campaign error isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));
vi.mock("@/lib/campaigns/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns/db")>()),
  listDueScheduledCampaigns: vi.fn(),
  listSendingCampaigns: vi.fn(),
  listPendingRecipients: vi.fn(),
  insertCampaignRecipients: vi.fn(),
  deletePendingRecipients: vi.fn(),
  claimRecipient: vi.fn(),
  countRecipientsByStatus: vi.fn(),
  markRecipient: vi.fn(),
  patchEmailCampaign: vi.fn(),
  transitionEmailCampaign: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(async () => ({ name: "Truly Insurance", owner_email: "owner@truly.test" }))
}));
vi.mock("@/lib/email/tenant-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/tenant-mailbox")>()),
  ensureTenantMailbox: vi.fn(async () => ({ local_part: "truly" }))
}));

import {
  CAMPAIGN_BATCH_PER_SWEEP,
  buildMarketingUnsubscribeUrl,
  marketingUnsubscribeToken,
  processCampaignSweep,
  verifyMarketingUnsubscribeToken
} from "@/lib/campaigns/send";
import {
  claimRecipient,
  countRecipientsByStatus,
  deletePendingRecipients,
  insertCampaignRecipients,
  listDueScheduledCampaigns,
  listPendingRecipients,
  listSendingCampaigns,
  markRecipient,
  patchEmailCampaign,
  transitionEmailCampaign,
  type CampaignRecipientRow,
  type EmailCampaignRow
} from "@/lib/campaigns/db";
import { getBusiness } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-16T18:00:00Z");

const listDue = vi.mocked(listDueScheduledCampaigns);
const listSending = vi.mocked(listSendingCampaigns);
const listPending = vi.mocked(listPendingRecipients);
const insertRecipients = vi.mocked(insertCampaignRecipients);
const deletePendings = vi.mocked(deletePendingRecipients);
const claim = vi.mocked(claimRecipient);
const countByStatus = vi.mocked(countRecipientsByStatus);
const mark = vi.mocked(markRecipient);
const patch = vi.mocked(patchEmailCampaign);
const transition = vi.mocked(transitionEmailCampaign);

function campaign(overrides: Partial<EmailCampaignRow> = {}): EmailCampaignRow {
  return {
    id: "c-1",
    business_id: BIZ,
    subject: "Spring special",
    body_md: "Hi!\n\nBook a check-up.",
    audience_tag: "",
    status: "scheduled",
    send_at: "2026-07-16T17:00:00Z",
    started_at: null,
    completed_at: null,
    recipients_total: 0,
    recipients_sent: 0,
    recipients_failed: 0,
    recipients_skipped: 0,
    snapshotted_at: "2026-07-16T17:00:01Z",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    ...overrides
  };
}

function recipient(id: string, email: string): CampaignRecipientRow {
  return {
    id,
    campaign_id: "c-1",
    business_id: BIZ,
    contact_id: `contact-${id}`,
    email,
    status: "pending",
    error_detail: null,
    sent_at: null,
    created_at: "2026-07-16T17:00:01Z"
  };
}

/** Contacts-scan mock for the snapshot query. */
function makeDb(
  contacts: Array<{ id: string; email: string | null; tags?: string[] | null }> | null,
  error: { message: string } | null = null
) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "is", "in", "order", "limit", "contains"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ name: m, args });
      return chain;
    });
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: contacts, error }).then(resolve);
  return { db: { from: vi.fn(() => chain) } as never, calls };
}

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "RESEND_API_KEY", "INTEGRATIONS_ENCRYPTION_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";
  process.env.RESEND_API_KEY = "re_test";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-secret";
  listDue.mockResolvedValue([]);
  listSending.mockResolvedValue([]);
  listPending.mockResolvedValue([]);
  insertRecipients.mockResolvedValue(undefined);
  deletePendings.mockResolvedValue(undefined);
  claim.mockResolvedValue(true);
  countByStatus.mockResolvedValue(0);
  mark.mockResolvedValue(undefined);
  patch.mockResolvedValue(undefined);
  transition.mockResolvedValue(true);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("unsubscribe tokens", () => {
  it("mints per-(business, contact) tokens that verify constant-time", () => {
    const token = marketingUnsubscribeToken(BIZ, "contact-1");
    expect(token).toHaveLength(32);
    expect(verifyMarketingUnsubscribeToken(BIZ, "contact-1", token)).toBe(true);
    expect(verifyMarketingUnsubscribeToken(BIZ, "contact-2", token)).toBe(false);
    expect(verifyMarketingUnsubscribeToken(BIZ, "contact-1", "short")).toBe(false);
  });

  it("builds the unsubscribe URL off the app origin", () => {
    const url = buildMarketingUnsubscribeUrl("https://app.test/", BIZ, "contact-1");
    expect(url).toBe(
      `https://app.test/api/marketing/unsubscribe?bid=${BIZ}&c=contact-1&t=${marketingUnsubscribeToken(BIZ, "contact-1")}`
    );
  });
});

describe("processCampaignSweep — promotion", () => {
  it("claims FIRST (single writer), then snapshots a suppressed/de-duped audience", async () => {
    const { db, calls } = makeDb([
      { id: "a", email: "jane@x.test" },
      { id: "b", email: "JANE@x.test " }, // same address, different row → one mail
      { id: "c", email: null }, // filtered defensively
      { id: "d", email: "not-an-email" } // no @ → dropped
    ]);
    listDue.mockResolvedValue([campaign()]);
    const result = await processCampaignSweep({ client: db, now: () => NOW });
    expect(result.promoted).toBe(1);
    const rows = insertRecipients.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contact_id: "a", email: "jane@x.test" });
    // Claim-first: the guarded transition is the single-writer lock — an
    // overlapping sweep on a stale due-list loses it BEFORE touching any
    // recipient rows. Then stale pendings clear, rows land, and the
    // snapshot stamp + total is recorded.
    expect(transition.mock.invocationCallOrder[0]).toBeLessThan(
      deletePendings.mock.invocationCallOrder[0]
    );
    expect(deletePendings.mock.invocationCallOrder[0]).toBeLessThan(
      insertRecipients.mock.invocationCallOrder[0]
    );
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      "scheduled",
      { status: "sending", started_at: NOW.toISOString() },
      db
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      { snapshotted_at: NOW.toISOString(), recipients_total: 1 },
      db
    );
    // The scan applied the customer/email/suppression filters, in a
    // deterministic order (no arbitrary-subset clipping).
    expect(calls.find((c) => c.name === "is")?.args).toEqual(["marketing_unsubscribed_at", null]);
    expect(calls.find((c) => c.name === "order")?.args).toEqual([
      "created_at",
      { ascending: true }
    ]);
  });

  it("matches the audience tag case-insensitively; a lost claim never touches recipient rows", async () => {
    const tagged = makeDb([
      { id: "a", email: "a@x.test", tags: ["VIP", "buyer"] }, // matches "vip"
      { id: "b", email: "b@x.test", tags: ["other"] }, // no match
      { id: "c", email: "c@x.test", tags: null } // no tags at all
    ]);
    listDue.mockResolvedValue([campaign({ audience_tag: "vip" })]);
    await processCampaignSweep({ client: tagged.db, now: () => NOW });
    const rows = insertRecipients.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contact_id: "a" });

    vi.clearAllMocks();
    listDue.mockResolvedValue([campaign()]);
    listSending.mockResolvedValue([]);
    transition.mockResolvedValue(false); // cancel/another sweep won the race
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW });
    expect(result.promoted).toBe(0);
    // The loser must not delete or insert a live campaign's queue.
    expect(deletePendings).not.toHaveBeenCalled();
    expect(insertRecipients).not.toHaveBeenCalled();
  });

  it("a snapshot failure after the claim leaves snapshotted_at unset for the drain to retry", async () => {
    const { db } = makeDb(null, { message: "scan boom" });
    listDue.mockResolvedValue([campaign()]);
    const result = await processCampaignSweep({ client: db, now: () => NOW });
    expect(result.errors).toEqual([{ campaignId: "c-1", message: expect.stringContaining("scan boom") }]);
    // The claim happened; the snapshot stamp did not.
    expect(transition).toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("processCampaignSweep — sending", () => {
  it("claims then sends from the tenant mailbox with unsubscribe wiring, deriving counters", async () => {
    const sendEmail = vi.fn(async () => "resend-id");
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test"), recipient("r2", "bob@x.test")]);
    countByStatus.mockImplementation(async (_id, status) => (status === "sent" ? 5 : 0));
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });

    expect(result.sent).toBe(2);
    expect(listPending).toHaveBeenCalledWith("c-1", CAMPAIGN_BATCH_PER_SWEEP, db);
    // Each recipient is claimed atomically BEFORE its send.
    expect(claim).toHaveBeenCalledWith("r1", db);
    expect(claim).toHaveBeenCalledWith("r2", db);
    const [apiKey, to, subject, opts] = sendEmail.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { from?: string; replyTo?: string; unsubscribeUrl?: string; html?: string }
    ];
    expect(apiKey).toBe("re_test");
    expect(to).toBe("jane@x.test");
    expect(subject).toBe("Spring special");
    expect(opts.from).toBe("Truly Insurance <truly@newcoworker.com>");
    expect(opts.replyTo).toBe("owner@truly.test");
    expect(opts.unsubscribeUrl).toContain("/api/marketing/unsubscribe?bid=");
    expect(opts.html).toContain("Spring special");
    // Counters derived from recipient rows — never read-modify-write.
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      { recipients_sent: 5, recipients_failed: 0, recipients_skipped: 0 },
      db
    );
  });

  it("skips (without emailing) recipients who unsubscribed after the snapshot", async () => {
    const sendEmail = vi.fn(async () => "resend-id");
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test"), recipient("r2", "bob@x.test")]);
    // The contacts query in the SENDING phase is the suppression re-check:
    // contact-r1 comes back as unsubscribed.
    const { db } = makeDb([{ id: "contact-r1", email: "jane@x.test" }]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown[])[1]).toBe("bob@x.test");
    expect(mark).toHaveBeenCalledWith("r1", "skipped", "unsubscribed after scheduling", db);
  });

  it("a lost claim skips the recipient (overlapping sweep can't double-send)", async () => {
    const sendEmail = vi.fn(async () => "resend-id");
    claim.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test"), recipient("r2", "bob@x.test")]);
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown[])[1]).toBe("bob@x.test");
  });

  it("downgrades a claimed recipient on send failure and keeps going", async () => {
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error("bounce"))
      .mockResolvedValueOnce("resend-id");
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "bad@x.test"), recipient("r2", "ok@x.test")]);
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(mark).toHaveBeenCalledWith("r1", "failed", "bounce", db);
    expect(mark).not.toHaveBeenCalledWith("r2", "sent", null, db);
  });

  it("re-snapshots a sending campaign whose snapshot never landed before draining", async () => {
    const sendEmail = vi.fn(async () => "resend-id");
    // Crashed between claim and snapshot: sending, but snapshotted_at null.
    listSending.mockResolvedValue([campaign({ status: "sending", snapshotted_at: null })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test")]);
    const { db } = makeDb([{ id: "a", email: "jane@x.test" }]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    // The snapshot retried (delete + insert + stamp), then the drain sent.
    expect(deletePendings).toHaveBeenCalledWith("c-1", db);
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      { snapshotted_at: NOW.toISOString(), recipients_total: 1 },
      db
    );
    expect(result.sent).toBe(1);
    expect(result.completed).toBe(0);
  });

  it("completes a campaign with no pending recipients left, refreshing counters", async () => {
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([]);
    countByStatus.mockImplementation(async (_id, status) =>
      status === "sent" ? 9 : status === "failed" ? 1 : 0
    );
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW });
    expect(result.completed).toBe(1);
    // Completion carries freshly derived counters — a batch that crashed
    // before its counter patch can't close the campaign with stale zeros.
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      "sending",
      {
        status: "sent",
        completed_at: NOW.toISOString(),
        recipients_sent: 9,
        recipients_failed: 1,
        recipients_skipped: 0
      },
      db
    );
  });

  it("isolates a per-campaign batch error (incl. non-Error throws) and defaults the clock", async () => {
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockRejectedValueOnce("string failure");
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db });
    expect(result.errors).toEqual([{ campaignId: "c-1", message: "string failure" }]);
  });

  it("suppression re-check tolerates a null payload and isolates a lookup failure", async () => {
    const sendEmail = vi.fn(async () => "resend-id");
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test")]);
    const { db } = makeDb(null); // null contacts payload → nobody suppressed
    const ok = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    expect(ok.sent).toBe(1);

    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test")]);
    const failing = makeDb(null, { message: "sup boom" });
    const bad = await processCampaignSweep({ client: failing.db, now: () => NOW, sendEmail });
    expect(bad.errors).toEqual([
      { campaignId: "c-1", message: expect.stringContaining("sup boom") }
    ]);
  });

  it("isolates an Error-typed batch failure too", async () => {
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockRejectedValueOnce(new Error("batch boom"));
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db });
    expect(result.errors).toEqual([{ campaignId: "c-1", message: "batch boom" }]);
  });

  it("degrades gracefully: env fallbacks, nameless business, no owner email, string send errors", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    vi.mocked(getBusiness).mockResolvedValueOnce(null as never);
    const sendEmail = vi.fn().mockRejectedValueOnce("send blip");
    listSending.mockResolvedValue([campaign({ status: "sending" })]);
    listPending.mockResolvedValue([recipient("r1", "jane@x.test")]);
    const { db } = makeDb([]);
    const result = await processCampaignSweep({ client: db, now: () => NOW, sendEmail });
    expect(result.failed).toBe(1);
    const [apiKey, , , opts] = sendEmail.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { from?: string; replyTo?: string; unsubscribeUrl?: string }
    ];
    expect(apiKey).toBe("");
    expect(opts.from).toBe("New Coworker <truly@newcoworker.com>");
    expect(opts.replyTo).toBeUndefined();
    expect(opts.unsubscribeUrl).toContain("http://localhost:3000/api/marketing/unsubscribe");
    expect(mark).toHaveBeenCalledWith("r1", "failed", "send blip", db);
  });

  it("treats a null snapshot payload as an empty audience and reports string promotion errors", async () => {
    const { db } = makeDb(null);
    listDue.mockResolvedValue([campaign()]);
    const result = await processCampaignSweep({ client: db, now: () => NOW });
    expect(result.promoted).toBe(1);
    expect(insertRecipients).toHaveBeenCalledWith([], db);
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      "c-1",
      expect.objectContaining({ recipients_total: 0 }),
      db
    );

    vi.clearAllMocks();
    listDue.mockResolvedValue([campaign()]);
    listSending.mockResolvedValue([]);
    transition.mockRejectedValueOnce("promotion blip");
    const second = await processCampaignSweep({ client: makeDb([]).db, now: () => NOW });
    expect(second.errors).toEqual([{ campaignId: "c-1", message: "promotion blip" }]);
  });
});
