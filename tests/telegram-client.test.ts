import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Telegram Bot API client.
 *
 * Two properties carry real weight here. A bot token IS the credential and
 * it lives in the URL, so nothing may log it. And every outbound message is
 * sent with parse_mode HTML, which means Telegram rejects the WHOLE message
 * if its entities will not parse: an unescaped `<` in a customer's name is
 * not a rendering glitch, it is a silently undelivered alert.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  escapeTelegramHtml,
  telegramDeleteWebhook,
  telegramGetMe,
  telegramSendMessage,
  telegramSetWebhook,
  TelegramApiError
} from "@/lib/telegram/client";

/**
 * The client's own abort budget, restated here rather than imported.
 * Exporting it only so a test could read it is the "dead code wearing
 * coverage" the knip ratchet refuses; if the constant moves, the timeout
 * test below stops advancing far enough and fails, which is the signal.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Telegram's own ceiling, same reasoning as the timeout above. */
const MESSAGE_MAX_CHARS = 4096;

const TOKEN = "123456:AAbbCC-secret";

function ok(result: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result })));
}

beforeEach(() => vi.restoreAllMocks());

describe("escaping", () => {
  it("escapes the three characters that break HTML parse mode", () => {
    expect(escapeTelegramHtml('Tom & <b>Jerry</b> > all')).toBe(
      "Tom &amp; &lt;b&gt;Jerry&lt;/b&gt; &gt; all"
    );
  });

  it("escapes the ampersand FIRST, so escapes are not double-escaped", () => {
    // "&lt;" must not become "&amp;lt;". Getting the order wrong here shows
    // up as visible entity soup in the owner's chat.
    expect(escapeTelegramHtml("<")).toBe("&lt;");
    expect(escapeTelegramHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("never logging a token", () => {
  it("keeps the token out of the error a failed call throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized", error_code: 401 })))
    );
    const err = await telegramGetMe(TOKEN).catch((e) => e as TelegramApiError);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).errorCode).toBe(401);
    expect((err as Error).message).not.toContain("AAbbCC");
  });
});

describe("the request timeout", () => {
  it("aborts a hung call rather than eating a webhook's ack window", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
      );
      const pending = telegramGetMe(TOKEN);
      const assertion = expect(pending).rejects.toBeInstanceOf(TelegramApiError);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getMe", () => {
  it("returns the bot identity, which is this channel's tenant boundary", async () => {
    vi.stubGlobal("fetch", ok({ id: 42, username: "acme_bot", first_name: "Acme" }));
    expect(await telegramGetMe(TOKEN)).toEqual({
      id: 42,
      username: "acme_bot",
      firstName: "Acme"
    });
  });

  it("tolerates a bot with no username", async () => {
    vi.stubGlobal("fetch", ok({ id: 42 }));
    expect(await telegramGetMe(TOKEN)).toEqual({ id: 42, username: null, firstName: null });
  });

  it("turns a network failure into a TelegramApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );
    await expect(telegramGetMe(TOKEN)).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("stringifies a rejection that was not an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "socket exploded";
      })
    );
    await expect(telegramGetMe(TOKEN)).rejects.toThrow(/socket exploded/);
  });

  it("treats an unparseable body as a failure, not as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await expect(telegramGetMe(TOKEN)).rejects.toThrow(/http_502/);
  });
});

describe("setWebhook", () => {
  it("registers the secret token and narrows the update types", async () => {
    const fetchMock = ok(true);
    vi.stubGlobal("fetch", fetchMock);
    await telegramSetWebhook(TOKEN, { url: "https://app/x", secretToken: "shh" });

    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    // The secret is Telegram's ONLY inbound authentication: there is no
    // signature on a Telegram update.
    expect(body.secret_token).toBe("shh");
    expect(body.allowed_updates).toEqual(["message"]);
    // A backlog left by whoever owned this bot before is not ours to answer.
    expect(body.drop_pending_updates).toBe(true);
  });

  it("drops pending updates on disconnect too", async () => {
    const fetchMock = ok(true);
    vi.stubGlobal("fetch", fetchMock);
    await telegramDeleteWebhook(TOKEN);
    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    expect(body.drop_pending_updates).toBe(true);
  });
});

describe("sendMessage", () => {
  it("returns the posted message and chat ids as strings", async () => {
    vi.stubGlobal("fetch", ok({ message_id: 7, chat: { id: -100 } }));
    expect(await telegramSendMessage(TOKEN, { chatId: -100, text: "hi" })).toEqual({
      messageId: "7",
      chatId: "-100"
    });
  });

  it("clips at Telegram's own ceiling rather than letting it reject the send", async () => {
    const fetchMock = ok({ message_id: 1, chat: { id: 1 } });
    vi.stubGlobal("fetch", fetchMock);
    await telegramSendMessage(TOKEN, { chatId: 1, text: "x".repeat(9000) });
    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    expect(body.text.length).toBe(MESSAGE_MAX_CHARS);
  });

  it("uses HTML parse mode and disables the link preview", async () => {
    const fetchMock = ok({ message_id: 1, chat: { id: 1 } });
    vi.stubGlobal("fetch", fetchMock);
    await telegramSendMessage(TOKEN, { chatId: 1, text: "hi" });
    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    // HTML rather than Markdown: Telegram's Markdown dialects reject
    // unescaped underscores and asterisks, which ordinary prose contains.
    expect(body.parse_mode).toBe("HTML");
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body.reply_markup).toBeUndefined();
    expect(body.reply_parameters).toBeUndefined();
  });

  it("offers the share-contact keyboard only when asked", async () => {
    const fetchMock = ok({ message_id: 1, chat: { id: 1 } });
    vi.stubGlobal("fetch", fetchMock);
    await telegramSendMessage(TOKEN, {
      chatId: 1,
      text: "who are you?",
      requestContact: { buttonText: "Share my number" }
    });
    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    expect(body.reply_markup.keyboard[0][0]).toEqual({
      text: "Share my number",
      request_contact: true
    });
  });

  it("anchors a reply when the caller has a message to answer", async () => {
    const fetchMock = ok({ message_id: 1, chat: { id: 1 } });
    vi.stubGlobal("fetch", fetchMock);
    await telegramSendMessage(TOKEN, { chatId: 1, text: "hi", replyToMessageId: 55 });
    const body = JSON.parse(((fetchMock.mock.calls[0] as never)[1] as RequestInit).body as string);
    expect(body.reply_parameters).toEqual({
      message_id: 55,
      // Without this a reply to a deleted message fails the whole send.
      allow_sending_without_reply: true
    });
  });
});
