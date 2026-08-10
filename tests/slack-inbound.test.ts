/**
 * Tests for Slack inbound chat ingestion (src/lib/slack/inbound.ts): the
 * 3-second-ack side of the pipeline. What matters: only fresh human
 * messages for a connected workspace become jobs, redeliveries ack quietly,
 * mention tags are stripped, thread anchoring is right for DMs vs
 * mentions, and the one-time hello never repeats or throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/slack-connections", () => ({ getSlackConnectionByTeamId: vi.fn() }));
vi.mock("@/lib/db/slack-chat", () => ({
  getOrCreateSlackConversation: vi.fn(),
  insertSlackUserMessage: vi.fn()
}));
vi.mock("@/lib/slack/client", () => ({ slackPostMessage: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { handleSlackChatEvent, handleSlackHomeOpened } from "@/lib/slack/inbound";
import { getSlackConnectionByTeamId } from "@/lib/db/slack-connections";
import {
  getOrCreateSlackConversation,
  insertSlackUserMessage
} from "@/lib/db/slack-chat";
import { slackPostMessage } from "@/lib/slack/client";
import { getBusiness } from "@/lib/db/businesses";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONNECTION = {
  business_id: BIZ,
  team_id: "T-1",
  bot_user_id: "U-BOT",
  botToken: "xoxb-1",
  is_active: true
};

const CONVERSATION = {
  id: "conv-1",
  business_id: BIZ,
  created_at: new Date().toISOString()
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSlackConnectionByTeamId).mockResolvedValue(CONNECTION as never);
  vi.mocked(getOrCreateSlackConversation).mockResolvedValue(CONVERSATION as never);
  vi.mocked(insertSlackUserMessage).mockResolvedValue({ messageId: 7, jobId: "job-1" });
  vi.mocked(slackPostMessage).mockResolvedValue({ ok: true, ts: "1.2", channel: "D-1" });
  vi.mocked(resolveOwnerUiLocaleForEmail).mockResolvedValue("en" as never);
});

const dm = (over: Record<string, unknown> = {}) => ({
  type: "message",
  channel_type: "im",
  user: "U-1",
  text: "hello there",
  channel: "D-1",
  ts: "100.1",
  ...over
});

describe("handleSlackChatEvent", () => {
  it("stores a DM and its job (null thread) and asks for a kick", async () => {
    const out = await handleSlackChatEvent({ teamId: "T-1", eventId: "Ev-1", event: dm() as never });
    expect(out).toEqual({ enqueued: true });
    expect(vi.mocked(getOrCreateSlackConversation)).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, channelId: "D-1", threadTs: null, slackUserId: "U-1" })
    );
    expect(vi.mocked(insertSlackUserMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello there", slackEventId: "Ev-1", slackTs: "100.1" })
    );
  });

  it("threads a top-level mention under itself and strips the tag", async () => {
    const out = await handleSlackChatEvent({
      teamId: "T-1",
      eventId: "Ev-2",
      event: {
        type: "app_mention",
        user: "U-1",
        text: "<@U-BOT> what's on the calendar?",
        channel: "C-9",
        ts: "200.1"
      } as never
    });
    expect(out.enqueued).toBe(true);
    expect(vi.mocked(getOrCreateSlackConversation)).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C-9", threadTs: "200.1" })
    );
    expect(vi.mocked(insertSlackUserMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ content: "what's on the calendar?" })
    );
  });

  it("keeps an existing thread anchor on a threaded mention", async () => {
    await handleSlackChatEvent({
      teamId: "T-1",
      eventId: null,
      event: {
        type: "app_mention",
        user: "U-1",
        text: "<@U-BOT> and this?",
        channel: "C-9",
        ts: "201.5",
        thread_ts: "200.1"
      } as never
    });
    expect(vi.mocked(getOrCreateSlackConversation)).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: "200.1" })
    );
  });

  it("drops bot echoes, subtypes, self, and malformed events with named reasons", async () => {
    expect(
      (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm({ bot_id: "B-1" }) as never }))
        .reason
    ).toBe("bot_message");
    expect(
      (
        await handleSlackChatEvent({
          teamId: "T-1",
          eventId: null,
          event: dm({ subtype: "message_changed" }) as never
        })
      ).reason
    ).toBe("subtype_message_changed");
    expect(
      (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm({ user: "U-BOT" }) as never }))
        .reason
    ).toBe("self");
    expect(
      (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm({ text: "  " }) as never }))
        .reason
    ).toBe("missing_fields");
    expect(
      (
        await handleSlackChatEvent({
          teamId: "T-1",
          eventId: null,
          event: { type: "app_mention", user: "U-1", text: "<@U-BOT>", channel: "C-9", ts: "1.1" } as never
        })
      ).reason
    ).toBe("empty_after_mention");
  });

  it("ignores workspaces without an active connection", async () => {
    vi.mocked(getSlackConnectionByTeamId).mockResolvedValue(null);
    expect(
      (await handleSlackChatEvent({ teamId: "T-x", eventId: null, event: dm() as never })).reason
    ).toBe("no_active_connection");

    vi.mocked(getSlackConnectionByTeamId).mockResolvedValue({
      ...CONNECTION,
      botToken: ""
    } as never);
    expect(
      (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm() as never })).reason
    ).toBe("no_active_connection");
  });

  it("acks a redelivery quietly when the event id already exists", async () => {
    vi.mocked(insertSlackUserMessage).mockResolvedValue(null);
    const out = await handleSlackChatEvent({ teamId: "T-1", eventId: "Ev-1", event: dm() as never });
    expect(out).toEqual({ enqueued: false, reason: "duplicate_delivery" });
  });
});

describe("handleSlackHomeOpened", () => {
  const opened = (over: Record<string, unknown> = {}) => ({
    type: "app_home_opened",
    tab: "messages",
    user: "U-1",
    channel: "D-1",
    ...over
  });

  it("greets a brand-new conversation once, in the owner's language", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "o@x.co" } as never);
    vi.mocked(resolveOwnerUiLocaleForEmail).mockResolvedValue("es" as never);
    await handleSlackHomeOpened({ teamId: "T-1", event: opened() as never });
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ channel: "D-1", text: expect.stringContaining("New Coworker") })
    );
  });

  it("never repeats the hello for an established conversation", async () => {
    vi.mocked(getOrCreateSlackConversation).mockResolvedValue({
      ...CONVERSATION,
      created_at: new Date(Date.now() - 60_000).toISOString()
    } as never);
    await handleSlackHomeOpened({ teamId: "T-1", event: opened() as never });
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
  });

  it("no-ops on other tabs, missing fields, or a dead connection, and swallows errors", async () => {
    await handleSlackHomeOpened({ teamId: "T-1", event: opened({ tab: "home" }) as never });
    await handleSlackHomeOpened({ teamId: "T-1", event: opened({ user: undefined }) as never });
    vi.mocked(getSlackConnectionByTeamId).mockResolvedValue(null);
    await handleSlackHomeOpened({ teamId: "T-1", event: opened() as never });
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();

    vi.mocked(getSlackConnectionByTeamId).mockRejectedValue(new Error("db down"));
    await expect(
      handleSlackHomeOpened({ teamId: "T-1", event: opened() as never })
    ).resolves.toBeUndefined();
  });

  it("falls back to English when the business has no owner email", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: null } as never);
    await handleSlackHomeOpened({ teamId: "T-1", event: opened() as never });
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ text: expect.stringContaining("I'm your business's New Coworker") })
    );
  });
});

describe("hello plumbing tolerance", () => {
  it("still greets in English when the business read fails", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz down"));
    await handleSlackHomeOpened({
      teamId: "T-1",
      event: { type: "app_home_opened", tab: "messages", user: "U-1", channel: "D-1" } as never
    });
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ text: expect.stringContaining("I'm your business's New Coworker") })
    );
  });

  it("falls back to English when the locale read fails", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ owner_email: "o@x.co" } as never);
    vi.mocked(resolveOwnerUiLocaleForEmail).mockRejectedValue(new Error("locale down"));
    await handleSlackHomeOpened({
      teamId: "T-1",
      event: { type: "app_home_opened", tab: "messages", user: "U-1", channel: "D-1" } as never
    });
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalled();
  });
});

describe("drop-condition partial sides", () => {
  it("an empty subtype string does not drop the message", async () => {
    const out = await handleSlackChatEvent({
      teamId: "T-1",
      eventId: null,
      event: dm({ subtype: "" }) as never
    });
    expect(out.enqueued).toBe(true);
  });

  it("each missing field drops independently", async () => {
    for (const gap of [{ user: undefined }, { channel: undefined }, { ts: undefined }]) {
      expect(
        (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm(gap) as never }))
          .reason
      ).toBe("missing_fields");
    }
  });

  it("an empty thread_ts anchors a mention under its own ts", async () => {
    await handleSlackChatEvent({
      teamId: "T-1",
      eventId: null,
      event: {
        type: "app_mention",
        user: "U-1",
        text: "<@U-BOT> hi",
        channel: "C-9",
        ts: "300.1",
        thread_ts: ""
      } as never
    });
    expect(vi.mocked(getOrCreateSlackConversation)).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: "300.1" })
    );
  });

  it("home-opened without a channel is a no-op", async () => {
    await handleSlackHomeOpened({
      teamId: "T-1",
      event: { type: "app_home_opened", tab: "messages", user: "U-1" } as never
    });
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
  });
});

describe("non-string field shapes", () => {
  it("drops a non-string text without crashing", async () => {
    expect(
      (await handleSlackChatEvent({ teamId: "T-1", eventId: null, event: dm({ text: 42 }) as never }))
        .reason
    ).toBe("missing_fields");
  });

  it("home-opened swallows non-Error throws too", async () => {
    vi.mocked(getSlackConnectionByTeamId).mockRejectedValue("string blowup");
    await expect(
      handleSlackHomeOpened({
        teamId: "T-1",
        event: { type: "app_home_opened", tab: "messages", user: "U-1", channel: "D-1" } as never
      })
    ).resolves.toBeUndefined();
  });
});
