/**
 * Tests for Meta leadgen webhook processing (src/lib/meta/webhook.ts):
 * payload parsing, page→tenant resolution, lead fetch + flow enqueue,
 * rate limiting, and the never-throw delivery contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const rateLimitMock = vi.fn((_key: string, _cfg: unknown) => ({ success: true }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (key: string, cfg: unknown) => rateLimitMock(key, cfg)
}));

const getActiveMetaConnectionByPageIdMock = vi.fn();
vi.mock("@/lib/db/meta-connections", () => ({
  getActiveMetaConnectionByPageId: (pageId: string) =>
    getActiveMetaConnectionByPageIdMock(pageId)
}));

const fetchLeadMock = vi.fn();
vi.mock("@/lib/meta/client", () => ({
  fetchLead: (leadgenId: string, pageToken: string) =>
    fetchLeadMock(leadgenId, pageToken)
}));

const processWebhookFlowEventMock = vi.fn();
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: (businessId: string, event: unknown) =>
    processWebhookFlowEventMock(businessId, event)
}));

import {
  parseMetaWebhookBody,
  processMetaLeadgenEvent,
  processMetaWebhookEvents
} from "@/lib/meta/webhook";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rateLimitMock.mockReset().mockReturnValue({ success: true });
  getActiveMetaConnectionByPageIdMock.mockReset();
  fetchLeadMock.mockReset();
  processWebhookFlowEventMock.mockReset();
});

describe("parseMetaWebhookBody", () => {
  it("returns null for a body that is not a Meta webhook payload", () => {
    expect(parseMetaWebhookBody(null)).toBeNull();
    expect(parseMetaWebhookBody({ object: "page" })).toBeNull();
    expect(parseMetaWebhookBody({ entry: [] })).toBeNull();
  });

  it("returns [] for non-page objects and non-leadgen fields", () => {
    expect(parseMetaWebhookBody({ object: "permissions", entry: [] })).toEqual([]);
    expect(
      parseMetaWebhookBody({
        object: "page",
        entry: [{ id: "p1", changes: [{ field: "feed", value: {} }] }]
      })
    ).toEqual([]);
  });

  it("extracts leadgen events, falling back to the entry id for the page", () => {
    expect(
      parseMetaWebhookBody({
        object: "page",
        entry: [
          {
            id: "entry-page",
            changes: [
              { field: "leadgen", value: { leadgen_id: 123, page_id: 456 } },
              { field: "leadgen", value: { leadgen_id: "lg-2" } },
              // No leadgen id at all → skipped.
              { field: "leadgen", value: {} }
            ]
          },
          // No changes array → skipped.
          { id: "quiet" },
          // No page id anywhere → skipped.
          { changes: [{ field: "leadgen", value: { leadgen_id: "lg-3" } }] }
        ]
      })
    ).toEqual([
      { pageId: "456", leadgenId: "123" },
      { pageId: "entry-page", leadgenId: "lg-2" }
    ]);
  });
});

describe("processMetaLeadgenEvent", () => {
  const EVENT = { pageId: "p1", leadgenId: "lg-1" };
  const CONNECTION = { business_id: BIZ, pageToken: "page-tok" };
  const LEAD = {
    id: "lg-1",
    createdTime: "2026-07-14T00:00:00+0000",
    formId: "form-1",
    adId: "ad-1",
    fields: { full_name: "Jane Doe", email: "j@x.com" }
  };

  it("fetches the lead and enqueues a flow event with the leadgen id as the dedupe key", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    fetchLeadMock.mockResolvedValue(LEAD);
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    expect(await processMetaLeadgenEvent(EVENT)).toBe(true);
    expect(fetchLeadMock).toHaveBeenCalledWith("lg-1", "page-tok");
    expect(processWebhookFlowEventMock).toHaveBeenCalledWith(BIZ, {
      source: "facebook_lead_ads",
      eventId: "lg-1",
      data: {
        full_name: "Jane Doe",
        email: "j@x.com",
        leadgen_id: "lg-1",
        form_id: "form-1",
        ad_id: "ad-1",
        created_time: "2026-07-14T00:00:00+0000",
        page_id: "p1"
      }
    });
  });

  it("omits null lead metadata from the flow payload", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    fetchLeadMock.mockResolvedValue({
      ...LEAD,
      formId: null,
      adId: null,
      createdTime: null
    });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 0, flowsMatched: 0 });

    await processMetaLeadgenEvent(EVENT);
    const [, payload] = processWebhookFlowEventMock.mock.calls[0] as [
      string,
      { data: Record<string, unknown> }
    ];
    expect(payload.data).not.toHaveProperty("form_id");
    expect(payload.data).not.toHaveProperty("ad_id");
    expect(payload.data).not.toHaveProperty("created_time");
  });

  it("refuses when rate limited", async () => {
    rateLimitMock.mockReturnValue({ success: false });
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);
    expect(getActiveMetaConnectionByPageIdMock).not.toHaveBeenCalled();
  });

  it("acknowledges (false) for an unknown page and for a lookup failure", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(null);
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByPageIdMock.mockRejectedValue(new Error("db down"));
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);

    // Non-Error rejection exercises the String(err) logging branch.
    getActiveMetaConnectionByPageIdMock.mockRejectedValue("db string failure");
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);
    expect(fetchLeadMock).not.toHaveBeenCalled();
  });

  it("acknowledges (false) when the lead fetch or enqueue fails, without throwing", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    fetchLeadMock.mockRejectedValue(new Error("graph 500"));
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);

    fetchLeadMock.mockResolvedValue(LEAD);
    processWebhookFlowEventMock.mockRejectedValue("string failure");
    expect(await processMetaLeadgenEvent(EVENT)).toBe(false);
  });
});

describe("processMetaWebhookEvents", () => {
  it("counts only the events that reached the flow engine", async () => {
    getActiveMetaConnectionByPageIdMock
      .mockResolvedValueOnce({ business_id: BIZ, pageToken: "tok" })
      .mockResolvedValueOnce(null);
    fetchLeadMock.mockResolvedValue({
      id: "lg-1",
      createdTime: null,
      formId: null,
      adId: null,
      fields: {}
    });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    const result = await processMetaWebhookEvents([
      { pageId: "p1", leadgenId: "lg-1" },
      { pageId: "p2", leadgenId: "lg-2" }
    ]);
    expect(result).toEqual({ handled: 1 });
  });
});
