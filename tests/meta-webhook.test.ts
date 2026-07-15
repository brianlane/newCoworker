/**
 * Tests for Meta webhook processing (src/lib/meta/webhook.ts): payload
 * parsing for leadgen changes AND Messenger/Instagram messaging events,
 * page/IG → tenant resolution, lead fetch + flow enqueue, conversation
 * ingest + reply-job enqueue, first-contact flow triggers, rate limiting,
 * and the never-throw delivery contract.
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
const getActiveMetaConnectionByInstagramIdMock = vi.fn();
vi.mock("@/lib/db/meta-connections", () => ({
  getActiveMetaConnectionByPageId: (pageId: string) =>
    getActiveMetaConnectionByPageIdMock(pageId),
  getActiveMetaConnectionByInstagramId: (igId: string) =>
    getActiveMetaConnectionByInstagramIdMock(igId)
}));

const fetchLeadMock = vi.fn();
vi.mock("@/lib/meta/client", () => ({
  fetchLead: (leadgenId: string, pageToken: string) =>
    fetchLeadMock(leadgenId, pageToken)
}));

const upsertMessengerConversationMock = vi.fn();
const appendMessengerMessageMock = vi.fn();
const insertMessengerJobMock = vi.fn();
const deleteMessengerMessageMock = vi.fn();
vi.mock("@/lib/messenger/db", () => ({
  upsertMessengerConversation: (input: unknown) => upsertMessengerConversationMock(input),
  appendMessengerMessage: (input: unknown) => appendMessengerMessageMock(input),
  insertMessengerJob: (input: unknown) => insertMessengerJobMock(input),
  deleteMessengerMessage: (id: number) => deleteMessengerMessageMock(id)
}));

const processWebhookFlowEventMock = vi.fn();
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: (businessId: string, event: unknown) =>
    processWebhookFlowEventMock(businessId, event)
}));

import {
  MESSENGER_ATTACHMENT_PLACEHOLDER,
  parseMetaWebhookBody,
  processMetaLeadgenEvent,
  processMetaMessageEvent,
  processMetaWebhookEvents,
  type MetaMessageEvent
} from "@/lib/meta/webhook";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rateLimitMock.mockReset().mockReturnValue({ success: true });
  getActiveMetaConnectionByPageIdMock.mockReset();
  getActiveMetaConnectionByInstagramIdMock.mockReset();
  fetchLeadMock.mockReset();
  upsertMessengerConversationMock.mockReset();
  appendMessengerMessageMock.mockReset();
  insertMessengerJobMock.mockReset();
  deleteMessengerMessageMock.mockReset().mockResolvedValue(undefined);
  processWebhookFlowEventMock.mockReset();
});

describe("parseMetaWebhookBody", () => {
  it("returns null for a body that is not a Meta webhook payload", () => {
    expect(parseMetaWebhookBody(null)).toBeNull();
    expect(parseMetaWebhookBody({ object: "page" })).toBeNull();
    expect(parseMetaWebhookBody({ entry: [] })).toBeNull();
  });

  it("returns empty events for unknown objects and non-leadgen fields", () => {
    expect(parseMetaWebhookBody({ object: "permissions", entry: [] })).toEqual({
      leadgen: [],
      messages: []
    });
    expect(
      parseMetaWebhookBody({
        object: "page",
        entry: [{ id: "p1", changes: [{ field: "feed", value: {} }] }]
      })
    ).toEqual({ leadgen: [], messages: [] });
  });

  it("extracts leadgen events, falling back to the entry id for the page", () => {
    const parsed = parseMetaWebhookBody({
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
    });
    expect(parsed?.leadgen).toEqual([
      { pageId: "456", leadgenId: "123" },
      { pageId: "entry-page", leadgenId: "lg-2" }
    ]);
    expect(parsed?.messages).toEqual([]);
  });

  it("extracts messenger messages, skipping echoes, receipts, and self-sends", () => {
    const parsed = parseMetaWebhookBody({
      object: "page",
      entry: [
        {
          id: "page-1",
          messaging: [
            { sender: { id: "psid-1" }, message: { mid: "m1", text: "Hi there" } },
            // Echo of the page's own send.
            { sender: { id: "psid-1" }, message: { mid: "m2", text: "x", is_echo: true } },
            // The page itself as sender (extra echo safety).
            { sender: { id: "page-1" }, message: { mid: "m3", text: "self" } },
            // Delivery/read receipt shape: no message at all.
            { sender: { id: "psid-1" } },
            // No mid → cannot dedupe; skipped.
            { sender: { id: "psid-1" }, message: { text: "no mid" } },
            // Attachment-only message → placeholder.
            { sender: { id: "psid-2" }, message: { mid: "m4", attachments: [{}] } },
            // Empty message with no attachments → noise.
            { sender: { id: "psid-3" }, message: { mid: "m5" } },
            // Postback button tap → title becomes the turn.
            { sender: { id: "psid-4" }, postback: { mid: "m6", title: "Get started" } },
            // Postback with payload only.
            { sender: { id: "psid-5" }, postback: { mid: "m7", payload: "START" } },
            // Postback without mid or label → skipped.
            { sender: { id: "psid-6" }, postback: {} },
            // No sender at all → unattributable, skipped.
            { message: { mid: "m8", text: "ghost" } }
          ]
        },
        // Entry with no id: senders can't be resolved → skipped.
        { messaging: [{ sender: { id: "psid-9" }, message: { mid: "m9", text: "hey" } }] }
      ]
    });
    expect(parsed?.messages).toEqual([
      { platform: "messenger", accountId: "page-1", senderId: "psid-1", mid: "m1", text: "Hi there" },
      {
        platform: "messenger",
        accountId: "page-1",
        senderId: "psid-2",
        mid: "m4",
        text: MESSENGER_ATTACHMENT_PLACEHOLDER
      },
      { platform: "messenger", accountId: "page-1", senderId: "psid-4", mid: "m6", text: "Get started" },
      { platform: "messenger", accountId: "page-1", senderId: "psid-5", mid: "m7", text: "START" }
    ]);
  });

  it("parses instagram-object messaging with platform instagram and no leadgen", () => {
    const parsed = parseMetaWebhookBody({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          // Leadgen changes never arrive on the instagram object; ignored.
          changes: [{ field: "leadgen", value: { leadgen_id: "lg-9" } }],
          messaging: [
            { sender: { id: 777 }, message: { mid: "ig-m1", text: "dm hello" } }
          ]
        }
      ]
    });
    expect(parsed?.leadgen).toEqual([]);
    expect(parsed?.messages).toEqual([
      { platform: "instagram", accountId: "ig-1", senderId: "777", mid: "ig-m1", text: "dm hello" }
    ]);
  });
});

describe("processMetaLeadgenEvent", () => {
  const EVENT = { pageId: "p1", leadgenId: "lg-1" };
  const CONNECTION = { business_id: BIZ, pageToken: "page-tok", page_id: "p1" };
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

describe("processMetaMessageEvent", () => {
  const EVENT: MetaMessageEvent = {
    platform: "messenger",
    accountId: "p1",
    senderId: "psid-1",
    mid: "m1",
    text: "Hi there"
  };
  const IG_EVENT: MetaMessageEvent = {
    platform: "instagram",
    accountId: "ig-1",
    senderId: "igsid-1",
    mid: "ig-m1",
    text: "dm hello"
  };
  const CONNECTION = { business_id: BIZ, pageToken: "page-tok", page_id: "p1" };
  const CONVERSATION = {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    page_id: "p1",
    platform: "messenger",
    psid: "psid-1",
    display_name: null
  };

  it("ingests a message: conversation upsert, mid-deduped append, job enqueue", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: CONVERSATION,
      isNew: false
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 7 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-1" });

    expect(await processMetaMessageEvent(EVENT)).toBe(true);
    expect(upsertMessengerConversationMock).toHaveBeenCalledWith({
      businessId: BIZ,
      pageId: "p1",
      platform: "messenger",
      psid: "psid-1"
    });
    expect(appendMessengerMessageMock).toHaveBeenCalledWith({
      conversationId: CONVERSATION.id,
      businessId: BIZ,
      role: "user",
      content: "Hi there",
      mid: "m1"
    });
    expect(insertMessengerJobMock).toHaveBeenCalledWith({
      businessId: BIZ,
      conversationId: CONVERSATION.id,
      userMessageId: 7
    });
    // Not a new conversation: no flow trigger.
    expect(processWebhookFlowEventMock).not.toHaveBeenCalled();
  });

  it("fires the first-contact flow trigger for NEW conversations (with display name)", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: { ...CONVERSATION, display_name: "Jane" },
      isNew: true
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 1 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-1" });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    expect(await processMetaMessageEvent(EVENT)).toBe(true);
    expect(processWebhookFlowEventMock).toHaveBeenCalledWith(BIZ, {
      source: "facebook_messenger",
      eventId: CONVERSATION.id,
      data: {
        platform: "messenger",
        page_id: "p1",
        psid: "psid-1",
        display_name: "Jane",
        first_message: "Hi there"
      }
    });
  });

  it("keeps ingesting when the first-contact flow trigger fails", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: CONVERSATION,
      isNew: true
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 1 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-1" });
    processWebhookFlowEventMock.mockRejectedValue(new Error("flow engine down"));

    expect(await processMetaMessageEvent(EVENT)).toBe(true);
    const [, flowEvent] = processWebhookFlowEventMock.mock.calls[0] as [
      string,
      { data: Record<string, unknown> }
    ];
    // No display name → key omitted; instagram source labels covered below.
    expect(flowEvent.data).not.toHaveProperty("display_name");
    expect(insertMessengerJobMock).toHaveBeenCalled();

    // Non-Error throw shapes log safely too.
    processWebhookFlowEventMock.mockRejectedValue("flow string failure");
    expect(await processMetaMessageEvent(EVENT)).toBe(true);
  });

  it("resolves instagram events through the IG lookup with the instagram_dm source", async () => {
    getActiveMetaConnectionByInstagramIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: { ...CONVERSATION, platform: "instagram", psid: "igsid-1" },
      isNew: true
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 2 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-2" });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 0, flowsMatched: 0 });

    expect(await processMetaMessageEvent(IG_EVENT)).toBe(true);
    expect(getActiveMetaConnectionByInstagramIdMock).toHaveBeenCalledWith("ig-1");
    expect(getActiveMetaConnectionByPageIdMock).not.toHaveBeenCalled();
    const [, flowEvent] = processWebhookFlowEventMock.mock.calls[0] as [
      string,
      { source: string }
    ];
    expect(flowEvent.source).toBe("instagram_dm");
  });

  it("skips duplicate redeliveries (mid dedupe returned null)", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: CONVERSATION,
      isNew: false
    });
    appendMessengerMessageMock.mockResolvedValue(null);

    expect(await processMetaMessageEvent(EVENT)).toBe(false);
    expect(insertMessengerJobMock).not.toHaveBeenCalled();
  });

  it("returns rate_limited (so the route asks Meta to redeliver) when shed", async () => {
    rateLimitMock.mockReturnValue({ success: false });
    expect(await processMetaMessageEvent(EVENT)).toBe("rate_limited");
    expect(getActiveMetaConnectionByPageIdMock).not.toHaveBeenCalled();
  });

  it("acknowledges (false) for unconnected accounts and lookup failures", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(null);
    expect(await processMetaMessageEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByPageIdMock.mockResolvedValue({
      business_id: BIZ,
      pageToken: "tok",
      page_id: null
    });
    expect(await processMetaMessageEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByPageIdMock.mockRejectedValue(new Error("db down"));
    expect(await processMetaMessageEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByPageIdMock.mockRejectedValue("db string failure");
    expect(await processMetaMessageEvent(EVENT)).toBe(false);
    expect(upsertMessengerConversationMock).not.toHaveBeenCalled();
  });

  it("acknowledges (false) when ingest writes fail, without throwing", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockRejectedValue(new Error("insert fail"));
    expect(await processMetaMessageEvent(EVENT)).toBe(false);

    upsertMessengerConversationMock.mockResolvedValue({
      conversation: CONVERSATION,
      isNew: false
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 3 });
    insertMessengerJobMock.mockRejectedValue("job insert string failure");
    expect(await processMetaMessageEvent(EVENT)).toBe(false);
    // Compensating delete: the orphan message row (no reply job would ever
    // answer it) is removed so a Meta redelivery can re-ingest cleanly.
    expect(deleteMessengerMessageMock).toHaveBeenCalledWith(3);
  });

  it("logs (but survives) a failed compensating delete after a job-insert failure", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONNECTION);
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: CONVERSATION,
      isNew: false
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 3 });
    insertMessengerJobMock.mockRejectedValue(new Error("job insert fail"));
    deleteMessengerMessageMock.mockRejectedValue(new Error("cleanup fail"));
    expect(await processMetaMessageEvent(EVENT)).toBe(false);

    deleteMessengerMessageMock.mockRejectedValue("cleanup string fail");
    expect(await processMetaMessageEvent(EVENT)).toBe(false);
  });
});

describe("processMetaWebhookEvents", () => {
  it("counts leadgen and message events independently", async () => {
    getActiveMetaConnectionByPageIdMock
      // leadgen p1 → connected
      .mockResolvedValueOnce({ business_id: BIZ, pageToken: "tok", page_id: "p1" })
      // leadgen p2 → unknown
      .mockResolvedValueOnce(null)
      // message p1 → connected
      .mockResolvedValueOnce({ business_id: BIZ, pageToken: "tok", page_id: "p1" })
      // message p3 → unknown (counts as not enqueued)
      .mockResolvedValueOnce(null);
    fetchLeadMock.mockResolvedValue({
      id: "lg-1",
      createdTime: null,
      formId: null,
      adId: null,
      fields: {}
    });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: {
        id: "33333333-3333-4333-8333-333333333333",
        business_id: BIZ,
        page_id: "p1",
        platform: "messenger",
        psid: "psid-1",
        display_name: null
      },
      isNew: false
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 9 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-9" });

    const result = await processMetaWebhookEvents({
      leadgen: [
        { pageId: "p1", leadgenId: "lg-1" },
        { pageId: "p2", leadgenId: "lg-2" }
      ],
      messages: [
        { platform: "messenger", accountId: "p1", senderId: "psid-1", mid: "m1", text: "hi" },
        { platform: "messenger", accountId: "p3", senderId: "psid-2", mid: "m2", text: "yo" }
      ]
    });
    expect(result).toEqual({ handled: 1, messagesEnqueued: 1, messagesRateLimited: 0 });
  });

  it("counts rate-limited message events separately (route flips to 429)", async () => {
    rateLimitMock.mockReturnValue({ success: false });
    const result = await processMetaWebhookEvents({
      leadgen: [],
      messages: [
        { platform: "messenger", accountId: "p1", senderId: "psid-1", mid: "m1", text: "hi" }
      ]
    });
    expect(result).toEqual({ handled: 0, messagesEnqueued: 0, messagesRateLimited: 1 });
  });
});
