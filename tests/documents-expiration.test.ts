/**
 * Daily expiration + renewal sweep (src/lib/documents/expiration.ts): one
 * reminder per state (expiring-soon / expired / the three renewal tiers),
 * armed/cleared stamps, assignee SMS, outreach flow events, per-document
 * error isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));
vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  patchBusinessDocument: vi.fn()
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));
vi.mock("@/lib/vps/sync-vault", () => ({ syncVaultToVpsAndLog: vi.fn(async () => {}) }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(async () => ({ apiKey: "k" })),
  sendTelnyxSms: vi.fn(async () => ({}))
}));
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: vi.fn(async () => ({ enqueued: 0, flowsEvaluated: 0, flowsMatched: 0 }))
}));

import { sweepDocumentExpirations } from "@/lib/documents/expiration";
import { patchBusinessDocument, type BusinessDocumentRow } from "@/lib/documents/db";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    title: "Summer price list",
    category: "pricing",
    audience: "both",
    storage_path: "p",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "c",
    summary: "s",
    status: "ready",
    error_detail: null,
    expires_at: "2026-07-14T00:00:00Z",
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    contact_id: null,
    renewal_date: null,
    assigned_employee_id: null,
    renewal_due_notified_at: null,
    renewal_final_notified_at: null,
    renewal_overdue_notified_at: null,
    renewal_outreach_enqueued_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

type TableResult = { data: unknown; error: { message: string } | null };

/**
 * Table-aware chainable mock: the docs scan resolves from `documents`;
 * the renewal name lookups resolve (in call order) from `contacts` /
 * `members`. Every chain method is recorded per table for assertions.
 */
function makeTableDb(results: {
  documents: TableResult;
  contacts?: TableResult;
  members?: TableResult;
}) {
  const calls: Record<string, Array<{ name: string; args: unknown[] }>> = {};
  const from = vi.fn((table: string) => {
    const log = (calls[table] ??= []);
    const result: TableResult =
      table === "business_documents"
        ? results.documents
        : table === "contacts"
          ? results.contacts ?? { data: [], error: null }
          : results.members ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "not", "or", "eq", "in"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        log.push({ name: m, args });
        return chain;
      });
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  });
  return { db: { from } as never, calls };
}

function makeDb(rows: BusinessDocumentRow[] | null, error: { message: string } | null = null) {
  return makeTableDb({ documents: { data: rows, error } }).db;
}

const dispatch = vi.mocked(dispatchUrgentNotification);
const patch = vi.mocked(patchBusinessDocument);
const sendSms = vi.mocked(sendTelnyxSms);
const getMessaging = vi.mocked(getTelnyxMessagingForBusiness);
const processFlowEvent = vi.mocked(processWebhookFlowEvent);

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.mockResolvedValue({ results: [] });
  patch.mockResolvedValue(undefined);
  sendSms.mockResolvedValue({} as never);
  getMessaging.mockResolvedValue({ apiKey: "k" } as never);
  processFlowEvent.mockResolvedValue({ enqueued: 0, flowsEvaluated: 0, flowsMatched: 0 });
});

describe("sweepDocumentExpirations", () => {
  it("throws when the scan query fails", async () => {
    await expect(
      sweepDocumentExpirations({ client: makeDb(null, { message: "scan boom" }), now: () => NOW })
    ).rejects.toThrow(/scan boom/);
  });

  it("notifies once about a just-expired document, stamps it, and re-syncs the vault digest", async () => {
    const expired = doc({ expires_at: "2026-07-10T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([expired]), now: () => NOW });
    expect(result).toMatchObject({
      scanned: 1,
      expiredNotified: 1,
      expiringSoonNotified: 0,
      vaultSyncsTriggered: 1
    });
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith(BIZ);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "document_expired",
        summary: expect.stringContaining("has expired")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      expired.id,
      { expired_notified_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("skips an expired document that was already notified (digest already synced then)", async () => {
    const expired = doc({
      expires_at: "2026-07-10T00:00:00Z",
      expired_notified_at: "2026-07-10T02:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([expired]), now: () => NOW });
    expect(result.expiredNotified).toBe(0);
    expect(result.vaultSyncsTriggered).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(syncVaultToVpsAndLog).not.toHaveBeenCalled();
  });

  it("deduplicates vault syncs per business and still syncs when the alert channel fails", async () => {
    const first = doc({ id: "doc-1", expires_at: "2026-07-10T00:00:00Z" });
    const second = doc({ id: "doc-2", expires_at: "2026-07-09T00:00:00Z" });
    dispatch.mockRejectedValueOnce(new Error("channel down")).mockResolvedValueOnce({ results: [] });
    const result = await sweepDocumentExpirations({
      client: makeDb([first, second]),
      now: () => NOW
    });
    // Both docs belong to the same business — one sync, even though the
    // first doc's notification failed (it retries tomorrow; the digest
    // must not stay stale in the meantime).
    expect(result.vaultSyncsTriggered).toBe(1);
    expect(syncVaultToVpsAndLog).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
  });

  it("notifies once about a document expiring within the window", async () => {
    const soon = doc({ expires_at: "2026-07-14T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([soon]), now: () => NOW });
    expect(result.expiringSoonNotified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document_expiring",
        summary: expect.stringContaining("expires 2026-07-14")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      soon.id,
      { expiring_soon_notified_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("skips an expiring-soon document that was already reminded", async () => {
    const soon = doc({
      expires_at: "2026-07-14T00:00:00Z",
      expiring_soon_notified_at: "2026-07-09T00:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([soon]), now: () => NOW });
    expect(result.expiringSoonNotified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves far-future documents alone", async () => {
    const far = doc({ expires_at: "2026-12-01T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([far]), now: () => NOW });
    expect(result).toMatchObject({ scanned: 1, expiredNotified: 0, expiringSoonNotified: 0 });
  });

  it("collects a per-document error and continues with the rest", async () => {
    const bad = doc({ id: "bad-doc", expires_at: "2026-07-10T00:00:00Z" });
    const good = doc({ id: "good-doc", expires_at: "2026-07-13T00:00:00Z" });
    dispatch
      .mockRejectedValueOnce(new Error("channel down"))
      .mockResolvedValueOnce({ results: [] });
    const result = await sweepDocumentExpirations({ client: makeDb([bad, good]), now: () => NOW });
    expect(result.errors).toEqual([{ documentId: "bad-doc", message: "channel down" }]);
    expect(result.expiringSoonNotified).toBe(1);
  });

  it("tolerates non-Error throw values in the per-document net", async () => {
    const bad = doc({ expires_at: "2026-07-10T00:00:00Z" });
    dispatch.mockRejectedValueOnce("string failure");
    const result = await sweepDocumentExpirations({ client: makeDb([bad]), now: () => NOW });
    expect(result.errors[0].message).toBe("string failure");
  });

  it("handles a null data payload and defaults the clock", async () => {
    const result = await sweepDocumentExpirations({ client: makeDb(null) });
    expect(result).toMatchObject({ scanned: 0 });
  });

  it("sends the 30-day heads-up, texts the assignee, and enqueues outreach", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      contact_id: "c-1",
      assigned_employee_id: "m-1"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      contacts: {
        data: [
          { id: "c-1", display_name: "Jane Doe", customer_e164: "+16025551234", email: "jane@x.com" }
        ],
        error: null
      },
      members: { data: [{ id: "m-1", name: "Dania", phone_e164: "+16025559876" }], error: null }
    });
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(result).toMatchObject({
      scanned: 1,
      renewalDueNotified: 1,
      renewalFinalNotified: 0,
      renewalOverdueNotified: 0,
      renewalOutreachEnqueued: 1,
      expiredNotified: 0
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document_renewal_due",
        summary: expect.stringContaining("for Jane Doe renews 2026-08-01"),
        emailBody: expect.stringContaining("Assigned to Dania.")
      })
    );
    // Assignee gets a direct operational-metered text.
    expect(sendSms).toHaveBeenCalledWith(
      { apiKey: "k" },
      "+16025559876",
      expect.stringContaining("You're the assigned handler"),
      { meterBusinessId: BIZ, meterMode: "operational" }
    );
    // Tier stamp first, outreach stamp after the event enqueues.
    expect(patch).toHaveBeenNthCalledWith(
      1,
      BIZ,
      policy.id,
      { renewal_due_notified_at: NOW.toISOString() },
      expect.anything()
    );
    expect(processFlowEvent).toHaveBeenCalledWith(
      BIZ,
      {
        source: "document_renewal",
        eventId: `document_renewal:${policy.id}:2026-08-01T00:00:00Z`,
        data: {
          document_title: "Summer price list",
          category: "pricing",
          renewal_date: "2026-08-01",
          days_until_renewal: 21,
          contact_name: "Jane Doe",
          contact_phone: "+16025551234",
          contact_email: "jane@x.com",
          assigned_employee: "Dania"
        }
      },
      expect.anything()
    );
    expect(patch).toHaveBeenNthCalledWith(
      2,
      BIZ,
      policy.id,
      { renewal_outreach_enqueued_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("falls back to the contact's number when it has no display name", async () => {
    const policy = doc({ expires_at: null, renewal_date: "2026-08-01T00:00:00Z", contact_id: "c-1" });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      contacts: {
        data: [{ id: "c-1", display_name: "  ", customer_e164: "+16025551234", email: null }],
        error: null
      }
    });
    await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("for +16025551234") })
    );
    // Null contact email rides as "" on the outreach payload.
    expect(processFlowEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        data: expect.objectContaining({ contact_email: "", contact_phone: "+16025551234" })
      }),
      expect.anything()
    );
  });

  it("escalates to the final tier at 7 days even after the heads-up fired", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-07-15T00:00:00Z",
      renewal_due_notified_at: "2026-06-15T00:00:00Z",
      renewal_outreach_enqueued_at: "2026-06-15T00:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([policy]), now: () => NOW });
    expect(result).toMatchObject({ renewalFinalNotified: 1, renewalDueNotified: 0 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document_renewal_final",
        summary: expect.stringContaining("Final reminder:")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      policy.id,
      { renewal_final_notified_at: NOW.toISOString() },
      expect.anything()
    );
    expect(processFlowEvent).not.toHaveBeenCalled();
  });

  it("fires only the most urgent tier for a late-entering date and stamps the skipped ones", async () => {
    const policy = doc({ expires_at: null, renewal_date: "2026-07-01T00:00:00Z" });
    const result = await sweepDocumentExpirations({ client: makeDb([policy]), now: () => NOW });
    expect(result).toMatchObject({
      renewalOverdueNotified: 1,
      renewalFinalNotified: 0,
      renewalDueNotified: 0
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document_renewal_overdue",
        summary: expect.stringContaining("was due for renewal 2026-07-01"),
        emailSubject: expect.stringContaining("Renewal overdue")
      })
    );
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      policy.id,
      {
        renewal_due_notified_at: NOW.toISOString(),
        renewal_final_notified_at: NOW.toISOString(),
        renewal_overdue_notified_at: NOW.toISOString()
      },
      expect.anything()
    );
    // No linked contact → no outreach, and no stamp so linking later still fires.
    expect(processFlowEvent).not.toHaveBeenCalled();
    expect(result.renewalOutreachEnqueued).toBe(0);
  });

  it("stays silent once every applicable tier is stamped, and skips far-future renewals", async () => {
    const fullyStamped = doc({
      id: "doc-stamped",
      expires_at: null,
      renewal_date: "2026-07-01T00:00:00Z",
      renewal_due_notified_at: "2026-06-01T00:00:00Z",
      renewal_final_notified_at: "2026-07-04T00:00:00Z",
      renewal_overdue_notified_at: "2026-07-02T00:00:00Z"
    });
    const far = doc({ id: "doc-far", expires_at: null, renewal_date: "2026-12-01T00:00:00Z" });
    const result = await sweepDocumentExpirations({
      client: makeDb([fullyStamped, far]),
      now: () => NOW
    });
    expect(result.renewalDueNotified).toBe(0);
    expect(result.renewalFinalNotified).toBe(0);
    expect(result.renewalOverdueNotified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stays silent inside the final window once the final reminder is stamped", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-07-15T00:00:00Z",
      renewal_due_notified_at: "2026-06-15T00:00:00Z",
      renewal_final_notified_at: "2026-07-08T00:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([policy]), now: () => NOW });
    expect(result.renewalFinalNotified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("back-fills outreach for a contact-linked doc whose reminders already fired", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      contact_id: "c-1",
      renewal_due_notified_at: "2026-07-10T00:00:00Z"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      contacts: {
        data: [{ id: "c-1", display_name: "Jane", customer_e164: "+16025551234", email: null }],
        error: null
      }
    });
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.renewalOutreachEnqueued).toBe(1);
    expect(processFlowEvent).toHaveBeenCalledTimes(1);
  });

  it("handles a doc that is both expired and renewal-due — both notices fire", async () => {
    const both = doc({
      expires_at: "2026-07-10T00:00:00Z",
      renewal_date: "2026-07-20T00:00:00Z"
    });
    const result = await sweepDocumentExpirations({ client: makeDb([both]), now: () => NOW });
    expect(result.expiredNotified).toBe(1);
    expect(result.renewalDueNotified).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("tolerates an assignee-SMS failure without re-firing the tier", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      assigned_employee_id: "m-1"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      members: { data: [{ id: "m-1", name: "Dania", phone_e164: "+16025559876" }], error: null }
    });
    sendSms.mockRejectedValueOnce(new Error("carrier down"));
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(result.renewalDueNotified).toBe(1);
    expect(result.errors).toEqual([]);
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      policy.id,
      { renewal_due_notified_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("tolerates a messaging-config failure the same way", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      assigned_employee_id: "m-1"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      members: { data: [{ id: "m-1", name: "Dania", phone_e164: "+16025559876" }], error: null }
    });
    getMessaging.mockRejectedValueOnce("config gone");
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(result.renewalDueNotified).toBe(1);
    expect(result.errors).toEqual([]);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("leaves the outreach stamp unset when the flow-event enqueue fails (retries tomorrow)", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      contact_id: "c-1"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      contacts: {
        data: [{ id: "c-1", display_name: "Jane", customer_e164: "+16025551234", email: null }],
        error: null
      }
    });
    processFlowEvent.mockRejectedValueOnce(new Error("enqueue down"));
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    // The tier reminder landed and stamped before the outreach failure.
    expect(result.renewalDueNotified).toBe(1);
    expect(result.renewalOutreachEnqueued).toBe(0);
    expect(result.errors).toEqual([{ documentId: policy.id, message: "enqueue down" }]);
    expect(patch).not.toHaveBeenCalledWith(
      BIZ,
      policy.id,
      { renewal_outreach_enqueued_at: NOW.toISOString() },
      expect.anything()
    );
  });

  it("degrades to nameless reminders when the directory lookups fail", async () => {
    const policy = doc({
      expires_at: null,
      renewal_date: "2026-08-01T00:00:00Z",
      contact_id: "c-1",
      assigned_employee_id: "m-1"
    });
    const { db } = makeTableDb({
      documents: { data: [policy], error: null },
      contacts: { data: null, error: { message: "contacts down" } },
      members: { data: null, error: { message: "roster down" } }
    });
    const result = await sweepDocumentExpirations({ client: db, now: () => NOW });
    expect(result.renewalDueNotified).toBe(1);
    const call = dispatch.mock.calls[0][0];
    expect(call.summary).not.toContain(" for ");
    expect(call.emailBody).not.toContain("Assigned to");
    // Unresolvable contact → no outreach event (nobody to reach), no stamp.
    expect(processFlowEvent).not.toHaveBeenCalled();
  });
});
