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
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  // Spread the real module: the dead-token classifier (isMetaTokenDead) is
  // pure and must behave for real here, or a 190 in a lead fetch silently
  // stops escalating.
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  fetchLead: (leadgenId: string, pageToken: string) => fetchLeadMock(leadgenId, pageToken)
}));
vi.mock("@/lib/meta/webhook-extras", () => ({
  processMetaEchoEvent: vi.fn(async () => false),
  processMetaReferralEvent: vi.fn(async () => false),
  processMetaTemplateStatusEvent: vi.fn(async () => false),
  processMetaMessageStatusEvent: vi.fn(async () => false)
}));
vi.mock("@/lib/meta/token-health", () => ({
  reportMetaCallFailure: vi.fn(async () => false),
  clearMetaTokenInvalid: vi.fn(async () => undefined)
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
  INSTAGRAM_COMMENT_FLOW_SOURCE,
  MESSENGER_ATTACHMENT_PLACEHOLDER,
  parseMetaWebhookBody,
  processMetaCommentEvent,
  processMetaLeadgenEvent,
  processMetaMessageEvent,
  processMetaWebhookEvents,
  type MetaMessageEvent
} from "@/lib/meta/webhook";
import { INSTAGRAM_COMMENT_SOURCE } from "@/lib/ai-flows/templates";

describe("instagram_comment source parity", () => {
  it("the starter template's trigger matches the source this webhook emits", () => {
    // templates.ts duplicates the string rather than importing it (that module
    // reaches client bundles; this one is server-only). Drift here would mean
    // comments arrive and the starter silently never matches: the exact
    // failure mode of shipping webhook plumbing with no consumer.
    expect(INSTAGRAM_COMMENT_SOURCE).toBe(INSTAGRAM_COMMENT_FLOW_SOURCE);
  });
});

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
    const empty = {
      leadgen: [],
      messages: [],
      comments: [],
      echoes: [],
      referrals: [],
      templateStatuses: [],
      messageStatuses: []
    };
    expect(parseMetaWebhookBody({ object: "permissions", entry: [] })).toEqual(empty);
    // A feed change with an empty value is not a comment: no item, no verb.
    expect(
      parseMetaWebhookBody({
        object: "page",
        entry: [{ id: "p1", changes: [{ field: "feed", value: {} }] }]
      })
    ).toEqual(empty);
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
            // A receipt with neither id nor status carries nothing to apply.
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
            // The account replying under its own post: never a flow event.
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
        platform: "instagram",
        accountId: "ig-1",
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
        platform: "instagram",
        accountId: "ig-1",
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
      messageStatuses: [],
      echoes: [],
      referrals: [],
      templateStatuses: [],
      leadgen: [
        { pageId: "p1", leadgenId: "lg-1" },
        { pageId: "p2", leadgenId: "lg-2" }
      ],
      comments: [
        {
          platform: "instagram",
          accountId: "ig-1",
          commentId: "c-1",
          mediaId: "m-1",
          text: "price?",
          fromId: "777",
          fromUsername: "jane"
        },
        {
          platform: "instagram",
          accountId: "ig-2",
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
      messageStatuses: [],
      echoes: [],
      referrals: [],
      templateStatuses: [],
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
    platform: "instagram" as const,
    accountId: "ig-1",
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

describe("processMetaCommentEvent: Facebook", () => {
  const FB_EVENT = {
    platform: "facebook" as const,
    accountId: "p1",
    commentId: "fb-c-1",
    mediaId: "fb-p-1",
    text: "how much?",
    fromId: "777",
    fromUsername: "Jane Doe"
  };
  const CONN = { business_id: BIZ, page_id: "p1", instagram_account_id: "ig-1" };

  it("resolves the tenant by PAGE id, not Instagram id", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(CONN);
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });

    expect(await processMetaCommentEvent(FB_EVENT)).toBe(true);
    expect(getActiveMetaConnectionByPageIdMock).toHaveBeenCalledWith("p1");
    expect(getActiveMetaConnectionByInstagramIdMock).not.toHaveBeenCalled();
    expect(processWebhookFlowEventMock).toHaveBeenCalledWith(BIZ, {
      source: "facebook_comment",
      eventId: "fb-c-1",
      data: {
        comment_id: "fb-c-1",
        comment_text: "how much?",
        username: "Jane Doe",
        from_id: "777",
        media_id: "fb-p-1",
        // page_id, not instagram_account_id: a Facebook comment has no IG
        // account, and a flow templating the wrong one would render blank.
        page_id: "p1"
      }
    });
  });

  it("acknowledges an unconnected Page without enqueueing", async () => {
    getActiveMetaConnectionByPageIdMock.mockResolvedValue(null);
    expect(await processMetaCommentEvent(FB_EVENT)).toBe(false);
    expect(processWebhookFlowEventMock).not.toHaveBeenCalled();
  });
});

describe("Facebook Page comments (object page, field feed)", () => {
  const PAGE = "1202310049632520";

  function feed(value: Record<string, unknown>) {
    return parseMetaWebhookBody({
      object: "page",
      entry: [{ id: PAGE, changes: [{ field: "feed", value }] }]
    });
  }

  const COMMENT = {
    item: "comment",
    verb: "add",
    comment_id: "fb-c-1",
    post_id: "fb-p-1",
    message: "how much for a cut?",
    from: { id: "777", name: "Jane Doe" }
  };

  it("parses a new comment on a Page post", async () => {
    expect((await feed(COMMENT))!.comments).toEqual([
      {
        platform: "facebook",
        accountId: PAGE,
        commentId: "fb-c-1",
        mediaId: "fb-p-1",
        text: "how much for a cut?",
        fromId: "777",
        fromUsername: "Jane Doe"
      }
    ]);
  });

  it("IGNORES everything on the feed that is not a NEW comment", async () => {
    // The feed field is the whole Page firehose. Without the item check a
    // like fires a flow; without the verb check an edit fires it a second
    // time, and a removal fires it on a comment that no longer exists.
    for (const value of [
      { ...COMMENT, item: "like" },
      { ...COMMENT, item: "post" },
      { ...COMMENT, item: "reaction" },
      { ...COMMENT, item: "share" },
      { ...COMMENT, verb: "edited" },
      { ...COMMENT, verb: "remove" },
      { ...COMMENT, verb: "hide" },
      { ...COMMENT, item: undefined },
      { ...COMMENT, verb: undefined }
    ]) {
      expect((await feed(value))!.comments).toEqual([]);
    }
  });

  it("suppresses the Page's OWN comments, so our reply cannot re-trigger", async () => {
    // Our public reply arrives back as a feed comment from the Page itself.
    // Without this, every reply starts another run, which answers itself.
    expect((await feed({ ...COMMENT, from: { id: PAGE, name: "New Coworker" } }))!.comments).toEqual(
      []
    );
  });

  it("drops a feed change whose fields are the wrong TYPE", async () => {
    // The outer schema already guarantees `value` is an object, so the inner
    // parse only ever fails on a type mismatch inside it.
    for (const value of [
      { ...COMMENT, item: 123 },
      { ...COMMENT, verb: { a: 1 } },
      { ...COMMENT, message: 5 },
      { ...COMMENT, from: "jane" }
    ]) {
      expect((await feed(value as unknown as Record<string, unknown>))!.comments).toEqual([]);
    }
  });

  it("still emits a comment that carries no `from` block", async () => {
    // Unusual but real, and the comment is still worth acting on. Matches the
    // Instagram path, which also emits with an empty fromId rather than
    // dropping. The echo guard compares against the Page id, and "" is not it.
    expect(
      (await feed({ item: "comment", verb: "add", comment_id: "c", message: "hi" }))!.comments
    ).toEqual([
      {
        platform: "facebook",
        accountId: PAGE,
        commentId: "c",
        mediaId: "",
        text: "hi",
        fromId: "",
        fromUsername: ""
      }
    ]);
  });

  it("drops a comment with no id, and tolerates missing optional fields", async () => {
    expect((await feed({ ...COMMENT, comment_id: undefined }))!.comments).toEqual([]);

    const sparse = (await feed({ item: "comment", verb: "add", comment_id: "c", from: { id: "9" } }))!;
    expect(sparse.comments).toEqual([
      {
        platform: "facebook",
        accountId: PAGE,
        commentId: "c",
        mediaId: "",
        text: "",
        fromId: "9",
        fromUsername: ""
      }
    ]);
  });

  it("still parses leadgen on the same object, which shares the changes array", async () => {
    const events = (await parseMetaWebhookBody({
      object: "page",
      entry: [
        {
          id: PAGE,
          changes: [
            { field: "leadgen", value: { page_id: PAGE, leadgen_id: "lg-1" } },
            { field: "feed", value: COMMENT }
          ]
        }
      ]
    }))!;
    expect(events.leadgen).toEqual([{ pageId: PAGE, leadgenId: "lg-1" }]);
    expect(events.comments).toHaveLength(1);
  });
});

describe("a dead Meta token during a lead fetch", () => {
  it("escalates, because Meta 200s and the lead is gone for good", async () => {
    // There is no dead-letter row and Meta never redelivers, so this is the
    // costliest place a silent token failure can happen.
    const { reportMetaCallFailure, clearMetaTokenInvalid } = await import(
      "@/lib/meta/token-health"
    );
    vi.mocked(reportMetaCallFailure).mockClear();
    getActiveMetaConnectionByPageIdMock.mockResolvedValue({
      business_id: BIZ,
      pageToken: "tok"
    });
    fetchLeadMock.mockRejectedValue(new Error("Session has expired"));

    expect(await processMetaLeadgenEvent({ pageId: "p1", leadgenId: "lg-1" })).toBe(false);
    expect(vi.mocked(reportMetaCallFailure)).toHaveBeenCalledWith(
      BIZ,
      expect.any(Error),
      { surface: "lead_fetch" }
    );

    // And a successful fetch heals the flag without waiting for the owner.
    vi.mocked(clearMetaTokenInvalid).mockClear();
    fetchLeadMock.mockResolvedValue({ id: "lg-1", fields: {}, formId: null, adId: null, createdTime: null });
    processWebhookFlowEventMock.mockResolvedValue({ enqueued: 1, flowsMatched: 1 });
    await processMetaLeadgenEvent({ pageId: "p1", leadgenId: "lg-1" });
    expect(vi.mocked(clearMetaTokenInvalid)).toHaveBeenCalledWith(BIZ);
  });
});

describe("Page-side echoes: a colleague in Meta's inbox", () => {
  const PAGE = "p1";
  const OUR_APP = "1554839372962421";

  function echo(message: Record<string, unknown>) {
    return parseMetaWebhookBody({
      object: "page",
      entry: [
        {
          id: PAGE,
          messaging: [{ sender: { id: PAGE }, recipient: { id: "psid-1" }, message }]
        }
      ]
    });
  }

  it("is parsed even though its sender IS the page", async () => {
    // The sender-is-page guard exists to stop our sends looping back as
    // INBOUND. Echoes have to be handled before it or they never arrive.
    const events = (await echo({
      is_echo: true,
      mid: "m-echo",
      text: "I can help with that",
      app_id: 26390203743090
    }))!;
    expect(events.echoes).toEqual([
      {
        platform: "messenger",
        accountId: PAGE,
        recipientId: "psid-1",
        mid: "m-echo",
        text: "I can help with that",
        appId: "26390203743090"
      }
    ]);
    // And it is NOT also treated as an inbound customer message.
    expect(events.messages).toEqual([]);
  });

  it("carries our own app id through, for the handler to drop", async () => {
    const events = (await echo({
      is_echo: true,
      mid: "m-ours",
      text: "hi",
      app_id: OUR_APP
    }))!;
    expect(events.echoes[0].appId).toBe(OUR_APP);
  });

  it("drops an echo with no mid or no recipient", async () => {
    expect((await echo({ is_echo: true, text: "x", app_id: 1 }))!.echoes).toEqual([]);
    const noRecipient = (await parseMetaWebhookBody({
      object: "page",
      entry: [{ id: PAGE, messaging: [{ sender: { id: PAGE }, message: { is_echo: true, mid: "m" } }] }]
    }))!;
    expect(noRecipient.echoes).toEqual([]);
  });

  it("records an attachment-only echo with an empty text", async () => {
    const events = (await echo({ is_echo: true, mid: "m-att", app_id: 26390203743090 }))!;
    expect(events.echoes[0].text).toBe("");
  });

  it("reports an absent app id as empty, which the handler reads as not-ours", async () => {
    const events = (await echo({ is_echo: true, mid: "m-noapp", text: "hi" }))!;
    expect(events.echoes[0].appId).toBe("");
  });
});

describe("Click-to-Messenger referrals", () => {
  const PAGE = "p1";

  function messagingItem(item: Record<string, unknown>) {
    return parseMetaWebhookBody({
      object: "page",
      entry: [{ id: PAGE, messaging: [{ sender: { id: "psid-1" }, recipient: { id: PAGE }, ...item }] }]
    });
  }

  const REF = {
    ref: "SPRING_SALE",
    source: "ADS",
    type: "OPEN_THREAD",
    ad_id: "120200000000000",
    ads_context_data: { ad_title: "Spring roof special" }
  };

  it("reads a referral riding ALONE (existing thread reopened from an ad)", async () => {
    expect((await messagingItem({ referral: REF }))!.referrals).toEqual([
      {
        platform: "messenger",
        accountId: PAGE,
        senderId: "psid-1",
        ref: "SPRING_SALE",
        source: "ADS",
        type: "OPEN_THREAD",
        adId: "120200000000000",
        adTitle: "Spring roof special"
      }
    ]);
  });

  it("reads a referral nested on the FIRST MESSAGE of a new thread", async () => {
    // The most common entry path, and the one that would have been missed by
    // reading only the standalone form.
    const events = (await messagingItem({
      message: { mid: "m-1", text: "how much?", referral: REF }
    }))!;
    expect(events.referrals).toHaveLength(1);
    // The message itself still lands as an ordinary inbound turn.
    expect(events.messages).toHaveLength(1);
  });

  it("reads a referral nested on a Get Started POSTBACK", async () => {
    const events = (await messagingItem({
      postback: { mid: "m-2", title: "Get Started", payload: "GET_STARTED", referral: REF }
    }))!;
    expect(events.referrals).toHaveLength(1);
  });

  it("tolerates a referral with only a ref code and no ad", async () => {
    const events = (await messagingItem({ referral: { ref: "flyer-qr", source: "SHORTLINK" } }))!;
    expect(events.referrals[0]).toMatchObject({
      ref: "flyer-qr",
      source: "SHORTLINK",
      type: "",
      adId: "",
      adTitle: ""
    });
  });

  it("tolerates a referral with every field absent but still emits it", async () => {
    // Covers each field's empty-string fallback: Meta omits what it has not
    // got, and a half-populated referral is still attribution.
    const events = (await messagingItem({ referral: { ad_id: 12345 } }))!;
    expect(events.referrals[0]).toEqual({
      platform: "messenger",
      accountId: PAGE,
      senderId: "psid-1",
      ref: "",
      source: "",
      type: "",
      adId: "12345",
      adTitle: ""
    });
  });

  it("emits nothing when there is no referral at all", async () => {
    expect((await messagingItem({ message: { mid: "m", text: "hi" } }))!.referrals).toEqual([]);
  });
});

describe("WhatsApp template status updates", () => {
  function statusChange(value: Record<string, unknown>) {
    return parseMetaWebhookBody({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "message_template_status_update", value }] }]
    });
  }

  it("is parsed instead of dropped by the messages-only filter", async () => {
    // Dropped until now, which is why a template PAUSED after approval kept
    // being sent against: deliverWhatsApp gates on a stored status that
    // nothing refreshed outside a manual reconnect.
    expect(
      (await statusChange({
        message_template_name: "nc_contact_followup",
        message_template_language: "en",
        event: "PAUSED",
        reason: "PACING"
      }))!.templateStatuses
    ).toEqual([
      {
        wabaId: "waba-1",
        templateName: "nc_contact_followup",
        language: "en",
        status: "PAUSED",
        reason: "PACING"
      }
    ]);
  });

  it("still drops the WABA fields we do not handle", async () => {
    // The WABA subscription sends every field enabled on the app, so these
    // arrive whether we want them or not. Handling template statuses must not
    // accidentally start acting on quality or account updates.
    for (const field of [
      "phone_number_quality_update",
      "account_update",
      "account_alerts",
      "template_category_update"
    ]) {
      const events = (await parseMetaWebhookBody({
        object: "whatsapp_business_account",
        entry: [{ id: "waba-1", changes: [{ field, value: { event: "FLAGGED" } }] }]
      }))!;
      expect(events.templateStatuses).toEqual([]);
      expect(events.messages).toEqual([]);
    }
  });

  it("tolerates an entry with no id", async () => {
    const events = (await parseMetaWebhookBody({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            { field: "message_template_status_update", value: { message_template_name: "t", event: "PAUSED" } }
          ]
        }
      ]
    }))!;
    expect(events.templateStatuses[0].wabaId).toBe("");
  });

  it("drops a change whose fields are the wrong type", async () => {
    // The outer schema guarantees an object, so the inner parse only fails on
    // a type mismatch inside it.
    expect(
      (await statusChange({ message_template_name: 5, event: "PAUSED" }))!.templateStatuses
    ).toEqual([]);
  });

  it("defaults the language and reason Meta omitted", async () => {
    expect(
      (await statusChange({ message_template_name: "t", event: "APPROVED" }))!.templateStatuses[0]
    ).toEqual({
      wabaId: "waba-1",
      templateName: "t",
      language: "",
      status: "APPROVED",
      reason: ""
    });
  });

  it("drops a change with no template name or no status", async () => {
    expect((await statusChange({ event: "PAUSED" }))!.templateStatuses).toEqual([]);
    expect(
      (await statusChange({ message_template_name: "nc_owner_alert" }))!.templateStatuses
    ).toEqual([]);
  });

  it("still parses inbound WhatsApp messages on the same object", async () => {
    const events = (await parseMetaWebhookBody({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            { field: "message_template_status_update", value: { message_template_name: "t", event: "APPROVED" } },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn-1" },
                messages: [{ id: "wamid.1", from: "15551230000", type: "text", text: { body: "hi" } }]
              }
            }
          ]
        }
      ]
    }))!;
    expect(events.templateStatuses).toHaveLength(1);
    expect(events.messages).toHaveLength(1);
  });
});

describe("Instagram live_comments", () => {
  it("is parsed by the same path as an ordinary comment", async () => {
    // We shipped the Live private-reply half (the client documents the
    // broadcast window) and never subscribed the trigger half.
    const events = (await parseMetaWebhookBody({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            {
              field: "live_comments",
              value: {
                id: "lc-1",
                text: "price?",
                from: { id: "777", username: "viewer" },
                media: { id: "live-9" }
              }
            }
          ]
        }
      ]
    }))!;
    expect(events.comments).toEqual([
      {
        platform: "instagram",
        accountId: "ig-1",
        commentId: "lc-1",
        mediaId: "live-9",
        text: "price?",
        fromId: "777",
        fromUsername: "viewer"
      }
    ]);
  });
});

describe("processMetaWebhookEvents: the new families are dispatched", () => {
  it("routes echoes, referrals, and template statuses, counting each once", async () => {
    // These three loops are the only thing between a parsed event and the
    // handler that acts on it, so a missing loop is a silent no-op.
    const extras = await import("@/lib/meta/webhook-extras");
    vi.mocked(extras.processMetaEchoEvent).mockResolvedValue(true);
    vi.mocked(extras.processMetaReferralEvent).mockResolvedValue(true);
    vi.mocked(extras.processMetaTemplateStatusEvent).mockResolvedValue(true);

    const result = await processMetaWebhookEvents({
      messageStatuses: [],
      leadgen: [],
      messages: [],
      comments: [],
      echoes: [
        {
          platform: "messenger",
          accountId: "p1",
          recipientId: "psid-1",
          mid: "m",
          text: "hi",
          appId: "26390203743090"
        }
      ],
      referrals: [
        {
          platform: "messenger",
          accountId: "p1",
          senderId: "psid-1",
          ref: "r",
          source: "ADS",
          type: "OPEN_THREAD",
          adId: "1",
          adTitle: "t"
        }
      ],
      templateStatuses: [
        { wabaId: "w1", templateName: "t", language: "en", status: "PAUSED", reason: "" }
      ]
    });
    expect(extras.processMetaEchoEvent).toHaveBeenCalledTimes(1);
    expect(extras.processMetaReferralEvent).toHaveBeenCalledTimes(1);
    expect(extras.processMetaTemplateStatusEvent).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(3);
  });

  it("counts only the events a handler actually acted on", async () => {
    const extras = await import("@/lib/meta/webhook-extras");
    vi.mocked(extras.processMetaEchoEvent).mockResolvedValue(false);
    vi.mocked(extras.processMetaReferralEvent).mockResolvedValue(false);
    vi.mocked(extras.processMetaTemplateStatusEvent).mockResolvedValue(false);

    const result = await processMetaWebhookEvents({
      messageStatuses: [],
      leadgen: [],
      messages: [],
      comments: [],
      echoes: [
        {
          platform: "messenger",
          accountId: "p1",
          recipientId: "psid-1",
          mid: "m",
          text: "hi",
          appId: "x"
        }
      ],
      referrals: [
        {
          platform: "messenger",
          accountId: "p1",
          senderId: "psid-1",
          ref: "r",
          source: "",
          type: "",
          adId: "",
          adTitle: ""
        }
      ],
      templateStatuses: [
        { wabaId: "w1", templateName: "t", language: "", status: "PAUSED", reason: "" }
      ]
    });
    expect(result.handled).toBe(0);
  });
});

describe("parseMetaWebhookBody: WhatsApp delivery receipts", () => {
  it("extracts receipts, error details, and Meta's second-precision timestamp", () => {
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
                statuses: [
                  { id: "wamid.A", status: "delivered", timestamp: "1787640419" },
                  {
                    id: "wamid.B",
                    status: "failed",
                    timestamp: 1787640419,
                    errors: [{ code: 131049, title: "Undeliverable", message: "dropped" }]
                  },
                  // Title missing: the longer `message` stands in.
                  {
                    id: "wamid.C",
                    status: "failed",
                    errors: [{ code: "131047", message: "Re-engagement required" }]
                  },
                  // Unusable rows: no id, no status.
                  { status: "read" },
                  { id: "wamid.D" }
                ]
              }
            }
          ]
        }
      ]
    });

    expect(parsed?.messageStatuses).toEqual([
      {
        accountId: "pn-9",
        mid: "wamid.A",
        status: "delivered",
        errorCode: null,
        errorTitle: null,
        // Meta sends unix SECONDS. Treating them as milliseconds would date
        // every receipt to 1970 and make the column useless for ordering.
        occurredAt: "2026-08-25T06:46:59.000Z"
      },
      {
        accountId: "pn-9",
        mid: "wamid.B",
        status: "failed",
        errorCode: "131049",
        errorTitle: "Undeliverable",
        occurredAt: "2026-08-25T06:46:59.000Z"
      },
      {
        accountId: "pn-9",
        mid: "wamid.C",
        status: "failed",
        errorCode: "131047",
        errorTitle: "Re-engagement required",
        occurredAt: null
      }
    ]);
  });

  it("leaves the receipt list empty for a payload that carries none", () => {
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
                messages: [{ id: "m1", from: "1555", type: "text", text: { body: "hi" } }]
              }
            }
          ]
        }
      ]
    });
    expect(parsed?.messageStatuses).toEqual([]);
  });
});

describe("processMetaWebhookEvents: delivery receipts reach their handler", () => {
  it("routes messageStatuses and counts each handled one", async () => {
    // The loop is the only thing between a parsed receipt and the writer.
    // Without it the parser fills an array nobody reads, which is the exact
    // shape of the bug this feature fixes.
    const extras = await import("@/lib/meta/webhook-extras");
    vi.mocked(extras.processMetaEchoEvent).mockResolvedValue(false);
    vi.mocked(extras.processMetaReferralEvent).mockResolvedValue(false);
    vi.mocked(extras.processMetaTemplateStatusEvent).mockResolvedValue(false);
    vi.mocked(extras.processMetaMessageStatusEvent).mockReset();
    vi.mocked(extras.processMetaMessageStatusEvent)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const receipt = (mid: string) => ({
      accountId: "pn-9",
      mid,
      status: "delivered",
      errorCode: null,
      errorTitle: null,
      occurredAt: null
    });

    const result = await processMetaWebhookEvents({
      leadgen: [],
      messages: [],
      comments: [],
      echoes: [],
      referrals: [],
      templateStatuses: [],
      messageStatuses: [receipt("wamid.A"), receipt("wamid.B")]
    });

    expect(extras.processMetaMessageStatusEvent).toHaveBeenCalledTimes(2);
    // Only the receipt the handler acted on counts, so a no-op receipt
    // cannot inflate the handled total.
    expect(result.handled).toBe(1);
  });
});
