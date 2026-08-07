/**
 * Inbox reads for the email coworker: the conversation id and RFC
 * Message-Id the AiFlow trigger poller drops, without which ownership
 * matching and threaded replies are impossible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));

import {
  INBOX_LOOKBACK_MINUTES,
  INBOX_MAX_MESSAGES,
  fetchInboxWithThreads,
  fetchMailboxAddress
} from "@/lib/email-coworker/mailbox";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";

const BIZ = "11111111-1111-4111-8111-111111111111";
const LINK = { connectionId: "c-1", providerConfigKey: "google" };
const SINCE = Date.parse("2026-07-25T00:00:00.000Z");
const mockProxy = vi.mocked(nangoProxyForBusiness);

beforeEach(() => {
  vi.clearAllMocks();
});

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

describe("fetchInboxWithThreads: Gmail", () => {
  it("lists then reads, returning thread id, Message-Id, sender, and body", async () => {
    mockProxy
      .mockResolvedValueOnce({ data: { messages: [{ id: "m-1" }, { id: "no-id-below" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          threadId: "thread-9",
          internalDate: "1785024000000",
          payload: {
            mimeType: "text/plain",
            body: { data: b64("Liz has availability Monday at 12:00 PM EST.") },
            headers: [
              { name: "From", value: "Beth Ranken <Beth@LizDev.com>" },
              { name: "Subject", value: "Re: NC Discovery Call w/ Liz" },
              { name: "Message-Id", value: "<beth-1@mail>" }
            ]
          }
        }
      } as never)
      .mockResolvedValueOnce({
        data: { threadId: "thread-8", payload: { headers: [] } }
      } as never);

    const out = await fetchInboxWithThreads(BIZ, "google", LINK, SINCE);
    expect(out[0]).toMatchObject({
      id: "m-1",
      threadId: "thread-9",
      fromEmail: "beth@lizdev.com",
      subject: "Re: NC Discovery Call w/ Liz",
      messageRef: "<beth-1@mail>",
      receivedAt: new Date(1785024000000).toISOString()
    });
    expect(out[0].bodyText).toContain("12:00 PM EST");
    // A message with no headers still returns, with null ref and no date.
    expect(out[1]).toMatchObject({ threadId: "thread-8", messageRef: null });
    expect(out[1].receivedAt).toBeUndefined();
    // The list query is scoped to the inbox and the lookback instant.
    expect(String(mockProxy.mock.calls[0][2].endpoint)).toContain(
      encodeURIComponent(`in:inbox after:${Math.floor(SINCE / 1000)}`)
    );
  });

  it("tolerates a malformed internalDate and a missing threadId", async () => {
    mockProxy
      .mockResolvedValueOnce({ data: { messages: [{ id: "m-1" }] } } as never)
      .mockResolvedValueOnce({
        data: { internalDate: "not-a-number", payload: { headers: [] } }
      } as never);
    const out = await fetchInboxWithThreads(BIZ, "google", LINK, SINCE);
    expect(out[0].receivedAt).toBeUndefined();
    expect(out[0].threadId).toBe("");
  });

  it("skips non-string ids, honours the limit, and tolerates an empty list", async () => {
    mockProxy
      .mockResolvedValueOnce({
        data: { messages: [{ id: "m-1" }, { nope: true }, { id: "m-2" }] }
      } as never)
      .mockResolvedValueOnce({ data: { threadId: "t", payload: { headers: [] } } } as never);
    const out = await fetchInboxWithThreads(BIZ, "google", LINK, SINCE, 1);
    expect(out).toHaveLength(1);

    mockProxy.mockReset();
    mockProxy.mockResolvedValueOnce({ data: {} } as never);
    expect(await fetchInboxWithThreads(BIZ, "google", LINK, SINCE)).toEqual([]);
  });

  it("throws when the mailbox connection is gone", async () => {
    mockProxy.mockResolvedValueOnce(null as never);
    await expect(fetchInboxWithThreads(BIZ, "google", LINK, SINCE)).rejects.toThrow(
      "email_not_connected"
    );
  });
});

describe("fetchInboxWithThreads: Gmail excludes our own sends", () => {
  it("asks Gmail itself for -from:me, driving the real fetcher", () => {
    /**
     * Not asserted on a locally built string: the whole point is what the
     * FETCHER sends. fetchMailboxAddress returns the ACCOUNT address and never
     * the send-as aliases, so the code-side self set cannot be complete on a
     * shared mailbox. HQ signs in as newcoworkerteam@gmail.com and writes as
     * team@newcoworker.com, whose catch-all forwards back into this mailbox,
     * so its own replies arrived as received mail on a thread it owned and it
     * answered itself. Only the provider knows the alias list.
     */
    mockProxy.mockResolvedValueOnce({ data: { messages: [] } } as never);
    return fetchInboxWithThreads(BIZ, "google", LINK, SINCE).then(() => {
      const endpoint = (mockProxy.mock.calls[0][2] as { endpoint: string }).endpoint;
      const decoded = decodeURIComponent(endpoint);
      expect(decoded).toContain("-from:me");
      expect(decoded).toContain("in:inbox");
    });
  });
});

describe("fetchInboxWithThreads: Microsoft Graph", () => {
  const GRAPH_LINK = { connectionId: "c-2", providerConfigKey: "outlook" };

  it("reads the inbox folder only, mapping conversationId and internetMessageId", async () => {
    mockProxy.mockResolvedValueOnce({
      data: {
        value: [
          {
            id: "g-1",
            conversationId: "conv-1",
            internetMessageId: "<beth-2@mail>",
            subject: "Re: Discovery",
            from: { emailAddress: { address: "Beth@LizDev.com" } },
            // contentType absent on the wire is possible; the html branch
            // must key on the value, not on the field existing.
            body: { contentType: "HTML", content: "<p>Monday at <b>12:00 PM</b> EST</p>" },
            receivedDateTime: "2026-07-25T16:16:00Z"
          },
          { conversationId: "conv-2" }
        ]
      }
    } as never);

    const out = await fetchInboxWithThreads(BIZ, "microsoft", GRAPH_LINK, SINCE);
    // The id-less row is dropped: there is nothing to reply to or dedupe on.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "g-1",
      threadId: "conv-1",
      fromEmail: "beth@lizdev.com",
      messageRef: "<beth-2@mail>"
    });
    expect(out[0].bodyText).toContain("12:00 PM");
    expect(out[0].bodyText).not.toContain("<b>");
    expect(String(mockProxy.mock.calls[0][2].endpoint)).toContain("mailFolders/inbox/messages");
  });

  it("falls back to plain text, blank sender, and empty conversation ids", async () => {
    mockProxy.mockResolvedValueOnce({
      data: {
        value: [
          { id: "g-2", body: { contentType: "text", content: "plain" } },
          // No body at all, and an html row whose content is missing.
          { id: "g-3" },
          { id: "g-4", body: { contentType: "html" } }
        ]
      }
    } as never);
    const out = await fetchInboxWithThreads(BIZ, "microsoft", GRAPH_LINK, SINCE);
    expect(out[0]).toMatchObject({
      threadId: "",
      fromEmail: "",
      subject: "",
      bodyText: "plain",
      messageRef: null
    });
    expect(out[1].bodyText).toBe("");
    expect(out[2].bodyText).toBe("");
  });

  it("tolerates a value-less payload and throws when disconnected", async () => {
    mockProxy.mockResolvedValueOnce({ data: {} } as never);
    expect(await fetchInboxWithThreads(BIZ, "microsoft", GRAPH_LINK, SINCE)).toEqual([]);

    mockProxy.mockResolvedValueOnce(null as never);
    await expect(fetchInboxWithThreads(BIZ, "microsoft", GRAPH_LINK, SINCE)).rejects.toThrow(
      "email_not_connected"
    );
  });
});

describe("fetchMailboxAddress", () => {
  const GRAPH_LINK = { connectionId: "c-2", providerConfigKey: "outlook" };

  it("reads the Gmail profile address, lower cased", async () => {
    mockProxy.mockResolvedValueOnce({
      data: { emailAddress: " Team@NewCoworker.com " }
    } as never);
    expect(await fetchMailboxAddress(BIZ, "google", LINK)).toBe("team@newcoworker.com");
    expect(String(mockProxy.mock.calls[0][2].endpoint)).toBe("/gmail/v1/users/me/profile");
  });

  it("prefers Graph's mail, falling back to the user principal name", async () => {
    mockProxy.mockResolvedValueOnce({ data: { mail: "Team@NewCoworker.com" } } as never);
    expect(await fetchMailboxAddress(BIZ, "microsoft", GRAPH_LINK)).toBe("team@newcoworker.com");

    mockProxy.mockResolvedValueOnce({
      data: { mail: "", userPrincipalName: "team@newcoworker.onmicrosoft.com" }
    } as never);
    expect(await fetchMailboxAddress(BIZ, "microsoft", GRAPH_LINK)).toBe(
      "team@newcoworker.onmicrosoft.com"
    );
  });

  it("returns null when the provider says nothing usable", async () => {
    // Callers fall back to a weaker self-check rather than dropping the
    // guard, so "unknown" must be expressible.
    mockProxy.mockResolvedValueOnce(null as never);
    expect(await fetchMailboxAddress(BIZ, "google", LINK)).toBeNull();

    mockProxy.mockResolvedValueOnce({ data: {} } as never);
    expect(await fetchMailboxAddress(BIZ, "google", LINK)).toBeNull();

    mockProxy.mockResolvedValueOnce({ data: { emailAddress: "   " } } as never);
    expect(await fetchMailboxAddress(BIZ, "google", LINK)).toBeNull();

    mockProxy.mockResolvedValueOnce({ data: { emailAddress: 42 } } as never);
    expect(await fetchMailboxAddress(BIZ, "google", LINK)).toBeNull();

    mockProxy.mockResolvedValueOnce({ data: { mail: null } } as never);
    expect(await fetchMailboxAddress(BIZ, "microsoft", GRAPH_LINK)).toBeNull();
  });
});

describe("poll bounds", () => {
  it("looks back further than the tick interval and caps reads per mailbox", () => {
    expect(INBOX_LOOKBACK_MINUTES).toBeGreaterThan(1);
    expect(INBOX_MAX_MESSAGES).toBeGreaterThan(0);
  });
});
