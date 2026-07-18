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

const getActiveWhatsAppConnectionByPhoneNumberIdMock = vi.fn();
vi.mock("@/lib/db/whatsapp-connections", () => ({
  getActiveWhatsAppConnectionByPhoneNumberId: (id: string) =>
    getActiveWhatsAppConnectionByPhoneNumberIdMock(id)
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
  processMetaCommentEvent,
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
  getActiveWhatsAppConnectionByPhoneNumberIdMock.mockReset();
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
      messages: [],
      comments: []
    });
    expect(
      parseMetaWebhookBody({
        object: "page",
        entry: [{ id: "p1", changes: [{ field: "feed", value: {} }] }]
      })
    ).toEqual({ leadgen: [], messages: [], comments: [] });
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

  it("parses whatsapp_business_account deliveries: texts, buttons, placeholders, receipts", () => {
    const parsed = parseMetaWebhookBody({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-9",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn-9" },
                contacts: [
                  { wa_id: "15551234567", profile: { name: "Jane Doe" } },
                  { profile: { name: "no-wa-id" } }
                ],
                messages: [
                  { id: "wamid-1", from: "15551234567", type: "text", text: { body: " Hi! " } },
                  // Quick-reply button tap reads as the customer's turn.
                  { id: "wamid-2", from: 15550001111, type: "button", button: { text: "Yes please" } },
                  // Button with payload only.
                  { id: "wamid-2b", from: "15550002222", type: "button", button: { payload: "YES" } },
                  // Image → placeholder.
                  { id: "wamid-3", from: "15550003333", type: "image" },
                  // Reaction/unsupported noise → skipped.
                  { id: "wamid-4", from: "15550004444", type: "reaction" },
                  { id: "wamid-5", from: "15550005555", type: "unsupported" },
                  // No type + no text: nothing usable → skipped.
                  { id: "wamid-5b", from: "15550006666" },
                  // Missing id / missing from → skipped.
                  { from: "15550007777", type: "text", text: { body: "no id" } },
                  { id: "wamid-6", type: "text", text: { body: "no sender" } }
                ]
              }
            },
            // Receipts-only change (statuses) and non-messages fields: ignored.
            { field: "messages", value: { metadata: { phone_number_id: "pn-9" }, statuses: [{}] } },
            { field: "message_template_status_update", value: {} },
            // Missing phone_number_id: unroutable, skipped.
            { field: "messages", value: { messages: [{ id: "wamid-7", from: "1555" }] } },
            // Malformed value shape: skipped by the inner safeParse.
            { field: "messages", value: { messages: "not-an-array" } }
          ]
        },
        // Entry with no changes array at all: skipped.
        { id: "waba-quiet" }
      ]
    });
    expect(parsed?.leadgen).toEqual([]);
    expect(parsed?.messages).toEqual([
      {
        platform: "whatsapp",
        accountId: "pn-9",
        senderId: "15551234567",
        mid: "wamid-1",
        text: "Hi!",
        displayName: "Jane Doe"
      },
      {
        platform: "whatsapp",
        accountId: "pn-9",
        senderId: "15550001111",
        mid: "wamid-2",
        text: "Yes please",
        displayName: null
      },
      {
        platform: "whatsapp",
        accountId: "pn-9",
        senderId: "15550002222",
        mid: "wamid-2b",
        text: "YES",
        displayName: null
      },
      {
        platform: "whatsapp",
        accountId: "pn-9",
        senderId: "15550003333",
        mid: "wamid-3",
        text: MESSENGER_ATTACHMENT_PLACEHOLDER,
        displayName: null
      }
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

  it("extracts instagram comment events, skipping self-comments and id-less values", () => {
    const parsed = parseMetaWebhookBody({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            {
              field: "comments",
              value: {
                id: 42,
                text: " love this! price? ",
                from: { id: 777, username: "jane_doe" },
                media: { id: "m-1" }
              }
            },
            // The account replying under its own post — never a flow event.
            { field: "comments", value: { id: "c-2", from: { id: "ig-1" } } },
            // No comment id → skipped.
            { field: "comments", value: { text: "hi" } },
            // Unrelated instagram change fields → skipped.
            { field: "story_insights", value: {} }
          ]
        },
        // No entry id → skipped.
        { changes: [{ field: "comments", value: { id: "c-9" } }] },
        // No changes array at all (DM-only entry) → nothing to scan.
        { id: "ig-1" }
      ]
    });
    expect(parsed?.comments).toEqual([
      {
        instagramAccountId: "ig-1",
        commentId: "42",
        mediaId: "m-1",
        text: "love this! price?",
        fromId: "777",
        fromUsername: "jane_doe"
      }
    ]);
    // Sparse deliveries (no media/text/username) still parse with "" fills.
    const sparse = parseMetaWebhookBody({
      object: "instagram",
      entry: [{ id: "ig-1", changes: [{ field: "comments", value: { id: "c-4", from: { id: 888 } } }] }]
    });
    expect(sparse?.comments).toEqual([
      {
        instagramAccountId: "ig-1",
        commentId: "c-4",
        mediaId: "",
        text: "",
        fromId: "888",
        fromUsername: ""
      }
    ]);
    // Comment changes never arrive on the page object.
    const pageParsed = parseMetaWebhookBody({
      object: "page",
      entry: [{ id: "p1", changes: [{ field: "comments", value: { id: "c-3" } }] }]
    });
    expect(pageParsed?.comments).toEqual([]);
  });

  it("tolerates a comment value that fails its schema (arrays where objects belong)", () => {
    const parsed = parseMetaWebhookBody({
      object: "instagram",
      entry: [{ id: "ig-1", changes: [{ field: "comments", value: { from: "not-an-object" } }] }]
    });
    expect(parsed?.comments).toEqual([]);
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
      psid: "psid-1",
      displayName: null
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

  it("resolves whatsapp events through the phone-number-id lookup with source whatsapp", async () => {
    getActiveWhatsAppConnectionByPhoneNumberIdMock.mockResolvedValue({
      business_id: BIZ,
      accessToken: "biz-tok",
      phone_number_id: "pn-9"
    });
    upsertMessengerConversationMock.mockResolvedValue({
      conversation: {
        ...CONVERSATION,
        platform: "whatsapp",
        page_id: "pn-9",
        psid: "15551234567",
        display_name: "Jane Doe"
      },
      isNew: true
    });
    appendMessengerMessageMock.mockResolvedValue({ id: 4 });
    insertMessengerJobMock.mockResolvedValue({ id: "job-4" });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    const event: MetaMessageEvent = {
      platform: "whatsapp",
      accountId: "pn-9",
      senderId: "15551234567",
      mid: "wamid-1",
      text: "Hi!",
      displayName: "Jane Doe"
    };
    expect(await processMetaMessageEvent(event)).toBe(true);
    expect(getActiveWhatsAppConnectionByPhoneNumberIdMock).toHaveBeenCalledWith("pn-9");
    expect(getActiveMetaConnectionByPageIdMock).not.toHaveBeenCalled();
    // The delivery's inline profile name rides into the conversation upsert.
    expect(upsertMessengerConversationMock).toHaveBeenCalledWith({
      businessId: BIZ,
      pageId: "pn-9",
      platform: "whatsapp",
      psid: "15551234567",
      displayName: "Jane Doe"
    });
    const [, flowEvent] = processWebhookFlowEventMock.mock.calls[0] as [
      string,
      { source: string }
    ];
    expect(flowEvent.source).toBe("whatsapp");

    // Unconnected phone number id: acknowledged, not errored.
    getActiveWhatsAppConnectionByPhoneNumberIdMock.mockResolvedValue(null);
    expect(await processMetaMessageEvent(event)).toBe(false);

    // Connection without a token is unusable.
    getActiveWhatsAppConnectionByPhoneNumberIdMock.mockResolvedValue({
      business_id: BIZ,
      accessToken: null,
      phone_number_id: "pn-9"
    });
    expect(await processMetaMessageEvent(event)).toBe(false);
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
  it("counts leadgen, comment, and message events independently", async () => {
    getActiveMetaConnectionByPageIdMock
      // leadgen p1 → connected
      .mockResolvedValueOnce({ business_id: BIZ, pageToken: "tok", page_id: "p1" })
      // leadgen p2 → unknown
      .mockResolvedValueOnce(null)
      // message p1 → connected
      .mockResolvedValueOnce({ business_id: BIZ, pageToken: "tok", page_id: "p1" })
      // message p3 → unknown (counts as not enqueued)
      .mockResolvedValueOnce(null);
    // comment ig-1 → connected (handled alongside the leadgen count);
    // comment ig-2 → unknown (counts as not handled).
    getActiveMetaConnectionByInstagramIdMock
      .mockResolvedValueOnce({
        business_id: BIZ,
        pageToken: "tok",
        page_id: "p1",
        instagram_account_id: "ig-1"
      })
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
      comments: [
        {
          instagramAccountId: "ig-1",
          commentId: "c-1",
          mediaId: "m-1",
          text: "price?",
          fromId: "777",
          fromUsername: "jane"
        },
        {
          instagramAccountId: "ig-2",
          commentId: "c-2",
          mediaId: "",
          text: "hello",
          fromId: "888",
          fromUsername: ""
        }
      ],
      messages: [
        { platform: "messenger", accountId: "p1", senderId: "psid-1", mid: "m1", text: "hi" },
        { platform: "messenger", accountId: "p3", senderId: "psid-2", mid: "m2", text: "yo" }
      ]
    });
    expect(result).toEqual({ handled: 2, messagesEnqueued: 1, messagesRateLimited: 0 });
  });

  it("counts rate-limited message events separately (route flips to 429)", async () => {
    rateLimitMock.mockReturnValue({ success: false });
    const result = await processMetaWebhookEvents({
      leadgen: [],
      comments: [],
      messages: [
        { platform: "messenger", accountId: "p1", senderId: "psid-1", mid: "m1", text: "hi" }
      ]
    });
    expect(result).toEqual({ handled: 0, messagesEnqueued: 0, messagesRateLimited: 1 });
  });
});

describe("processMetaCommentEvent", () => {
  const EVENT = {
    instagramAccountId: "ig-1",
    commentId: "c-1",
    mediaId: "m-1",
    text: "how much for a cut?",
    fromId: "777",
    fromUsername: "jane_doe"
  };
  const CONNECTION = {
    business_id: BIZ,
    pageToken: "tok",
    page_id: "p1",
    instagram_account_id: "ig-1"
  };

  it("resolves the tenant and enqueues a flow event keyed by the comment id", async () => {
    getActiveMetaConnectionByInstagramIdMock.mockResolvedValue(CONNECTION);
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    expect(await processMetaCommentEvent(EVENT)).toBe(true);
    expect(getActiveMetaConnectionByInstagramIdMock).toHaveBeenCalledWith("ig-1");
    expect(processWebhookFlowEventMock).toHaveBeenCalledWith(BIZ, {
      source: "instagram_comment",
      eventId: "c-1",
      data: {
        comment_id: "c-1",
        comment_text: "how much for a cut?",
        username: "jane_doe",
        from_id: "777",
        media_id: "m-1",
        instagram_account_id: "ig-1"
      }
    });
  });

  it("omits absent optional fields from the flow payload", async () => {
    getActiveMetaConnectionByInstagramIdMock.mockResolvedValue(CONNECTION);
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 0, flowsMatched: 0 });
    expect(
      await processMetaCommentEvent({
        ...EVENT,
        mediaId: "",
        fromId: "",
        fromUsername: ""
      })
    ).toBe(true);
    expect(processWebhookFlowEventMock).toHaveBeenCalledWith(BIZ, {
      source: "instagram_comment",
      eventId: "c-1",
      data: {
        comment_id: "c-1",
        comment_text: "how much for a cut?",
        instagram_account_id: "ig-1"
      }
    });
  });

  it("acknowledges without enqueueing when rate limited or unconnected", async () => {
    rateLimitMock.mockReturnValueOnce({ success: false });
    expect(await processMetaCommentEvent(EVENT)).toBe(false);
    expect(getActiveMetaConnectionByInstagramIdMock).not.toHaveBeenCalled();

    getActiveMetaConnectionByInstagramIdMock.mockResolvedValue(null);
    expect(await processMetaCommentEvent(EVENT)).toBe(false);
    expect(processWebhookFlowEventMock).not.toHaveBeenCalled();
  });

  it("never throws: lookup and enqueue failures resolve false", async () => {
    getActiveMetaConnectionByInstagramIdMock.mockRejectedValue(new Error("db down"));
    expect(await processMetaCommentEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByInstagramIdMock.mockRejectedValue("lookup string throw");
    expect(await processMetaCommentEvent(EVENT)).toBe(false);

    getActiveMetaConnectionByInstagramIdMock.mockResolvedValue(CONNECTION);
    processWebhookFlowEventMock.mockRejectedValue(new Error("enqueue down"));
    expect(await processMetaCommentEvent(EVENT)).toBe(false);

    processWebhookFlowEventMock.mockRejectedValue("string throw");
    expect(await processMetaCommentEvent(EVENT)).toBe(false);
  });
});
