import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Google Chat outbound client.
 *
 * The property that matters most here is the SPACE NAME check. That value
 * arrives inside an event and is interpolated into a request path, so a
 * hostile one could reshape the request our service-account bearer token is
 * sent with. There is no per-tenant host to allowlist the way Teams needs
 * (chat.googleapis.com is the same for everybody), which makes the path
 * segment the whole of the attack surface rather than a footnote.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  buildGoogleChatAlertCard,
  googleChatConfigured,
  googleChatSendMessage,
  isSpaceName,
  resetGoogleChatTokenStateForTests
} from "@/lib/google-chat/client";

const SPACE = "spaces/AAQA1234";
const TARGET = { space: SPACE, thread: null };

/**
 * A real RSA key, because the token exchange signs a JWT with it through
 * `node:crypto`. A fake string would fail inside the signer rather than at
 * the assertion, which would make every test here a test of the fixture.
 */
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: "chat@newcoworker.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "newcoworker"
});

const isTokenUrl = (raw: unknown): boolean => {
  // Parsed and compared by HOSTNAME rather than matched as a substring: a
  // substring test says yes to `https://evil.test/?x=oauth2.googleapis.com`
  // as readily as to the real thing, which in a fetch stub means a test can
  // hand a token to a call it was meant to fail and still pass.
  try {
    return new URL(String(raw)).hostname === "oauth2.googleapis.com";
  } catch {
    return false;
  }
};

function stubApi(body: unknown, status = 200) {
  const m = vi.fn(async (url: string, _init?: RequestInit) =>
    isTokenUrl(url)
      ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
      : new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", m);
  return m;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGoogleChatTokenStateForTests();
  process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY = KEY_JSON;
});

describe("the space name is checked, not trusted", () => {
  it.each([
    ["a plain space", "spaces/AAQA1234", true],
    ["one with the characters Google actually uses", "spaces/AAQA_1234-xy", true],
    ["a path traversal", "spaces/../../v1/spaces/theirs", false],
    ["an extra segment", "spaces/AAQA1234/messages", false],
    ["a query smuggled in", "spaces/AAQA1234?x=1", false],
    ["a whole URL", "https://evil.test/spaces/AAQA1234", false],
    ["the wrong collection", "rooms/AAQA1234", false],
    ["an empty id", "spaces/", false],
    ["nothing at all", "", false],
    ["null", null, false],
    ["a number", 12 as unknown as string, false]
  ])("%s", (_label, value, expected) => {
    expect(isSpaceName(value as string)).toBe(expected);
  });

  it("REFUSES to send to a malformed space, without asking for a token", async () => {
    // Refused before the credential is even minted: a request that never
    // happens cannot leak the bearer token it would have carried.
    const m = stubApi({ name: "spaces/x/messages/1" });
    await expect(
      googleChatSendMessage({ space: "spaces/../../evil", thread: null }, { text: "hi" })
    ).rejects.toThrow(/malformed space name/);
    expect(m).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("posts into the space, with the bearer token", async () => {
    const m = stubApi({ name: `${SPACE}/messages/abc`, thread: { name: `${SPACE}/threads/T` } });
    expect(await googleChatSendMessage(TARGET, { text: "hi" })).toEqual({
      messageName: `${SPACE}/messages/abc`,
      thread: `${SPACE}/threads/T`
    });
    const [url, init] = m.mock.calls.find(([u]) => !isTokenUrl(u))!;
    expect(url).toBe(`https://chat.googleapis.com/v1/${SPACE}/messages`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(JSON.parse(String(init?.body))).toEqual({ text: "hi" });
  });

  it("replies INTO a thread, falling back rather than failing when it is gone", async () => {
    // A space-level reply to a threaded question reads as the app talking
    // over the top of the conversation, and a hard failure when a thread
    // has been deleted would lose the answer entirely.
    const m = stubApi({ name: `${SPACE}/messages/abc` });
    await googleChatSendMessage(
      { space: SPACE, thread: `${SPACE}/threads/T` },
      { text: "answer" }
    );
    const [url, init] = m.mock.calls.find(([u]) => !isTokenUrl(u))!;
    expect(url).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(JSON.parse(String(init?.body)).thread).toEqual({ name: `${SPACE}/threads/T` });
  });

  it("does not ask to reply into a thread when there is none", async () => {
    const m = stubApi({ name: `${SPACE}/messages/abc` });
    await googleChatSendMessage(TARGET, { text: "hi" });
    const [url, init] = m.mock.calls.find(([u]) => !isTokenUrl(u))!;
    expect(url).not.toContain("messageReplyOption");
    expect(JSON.parse(String(init?.body)).thread).toBeUndefined();
  });

  it("reports a missing thread name in the response as null", async () => {
    stubApi({ name: `${SPACE}/messages/abc` });
    expect(await googleChatSendMessage(TARGET, { text: "hi" })).toMatchObject({ thread: null });
  });

  it("copes with a response that is not JSON", async () => {
    stubApi("not json");
    expect(await googleChatSendMessage(TARGET, { text: "hi" })).toEqual({
      messageName: "",
      thread: null
    });
  });

  it.each([
    ["the app is not in the space", 403],
    ["the space is gone", 404],
    ["Google is having a moment", 500]
  ])("throws a typed error when %s", async (_label, status) => {
    stubApi({ error: { message: "nope" } }, status);
    await expect(googleChatSendMessage(TARGET, { text: "hi" })).rejects.toThrow(
      new RegExp(`^google chat: send http_${status}`)
    );
  });

  it("still reports the status when the error body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isTokenUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : ({
              ok: false,
              status: 500,
              text: async () => {
                throw new Error("stream broken");
              }
            } as unknown as Response)
      )
    );
    await expect(googleChatSendMessage(TARGET, { text: "hi" })).rejects.toThrow(
      /^google chat: send http_500/
    );
  });

  it("wraps a network failure rather than leaking a raw fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );
    await expect(googleChatSendMessage(TARGET, { text: "hi" })).rejects.toThrow(/^google chat: /);
  });

  it("wraps a throw that is not an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "gone";
      })
    );
    await expect(googleChatSendMessage(TARGET, { text: "hi" })).rejects.toThrow(/^google chat: /);
  });

  it("aborts a hung send rather than holding a worker slot forever", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) =>
          isTokenUrl(url)
            ? Promise.resolve(
                new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
              )
            : new Promise((_r, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              })
        )
      );
      const pending = googleChatSendMessage(TARGET, { text: "hi" });
      const assertion = expect(pending).rejects.toThrow(/^google chat: /);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a caller-supplied token instead of minting one", async () => {
    const m = stubApi({ name: `${SPACE}/messages/abc` });
    await googleChatSendMessage(TARGET, { text: "hi" }, { token: "given" });
    expect(m.mock.calls.some(([u]) => isTokenUrl(u))).toBe(false);
  });
});

describe("the service-account credential", () => {
  it("is minted once and reused, not per alert", async () => {
    const m = stubApi({ name: `${SPACE}/messages/abc` });
    await googleChatSendMessage(TARGET, { text: "one" });
    await googleChatSendMessage(TARGET, { text: "two" });
    expect(m.mock.calls.filter(([u]) => isTokenUrl(u))).toHaveLength(1);
  });

  it("refuses to send when it is not configured at all", async () => {
    delete process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY;
    const m = stubApi({ name: `${SPACE}/messages/abc` });
    await expect(googleChatSendMessage(TARGET, { text: "hi" })).rejects.toThrow(
      /service account is not configured/
    );
    expect(m).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not JSON", "{"],
    ["JSON missing the private key", '{"client_email":"a@b","project_id":"p"}']
  ])("reports itself unconfigured when the key is %s", (_label, value) => {
    if (value === undefined) delete process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY;
    else process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY = value;
    expect(googleChatConfigured()).toBe(false);
  });

  it("reports itself configured when the key is usable", () => {
    expect(googleChatConfigured()).toBe(true);
  });
});

describe("the alert card", () => {
  it("carries the fields as DATA rather than markup", () => {
    // The reason a card is used at all. Chat parses asterisks and
    // underscores as bold and italic in a text message, so a customer named
    // "*Bob*" would be rendered as Bob in bold. Inside a card the same
    // string is displayed.
    const hostile = "*Bob* _Smith_ <b>x</b>";
    const card = buildGoogleChatAlertCard({ summary: hostile }) as {
      card: { sections: { widgets: { textParagraph?: { text: string } }[] }[] };
    };
    expect(card.card.sections[0].widgets[0].textParagraph?.text).toBe(hostile);
  });

  it("adds an open button only for an http(s) link", () => {
    const withLink = buildGoogleChatAlertCard({ summary: "x", detailsUrl: "https://app/x" }) as {
      card: { sections: { widgets: unknown[] }[] };
    };
    expect(withLink.card.sections[0].widgets).toHaveLength(2);

    for (const url of ["javascript:alert(1)", "data:text/html,x", "", "ftp://x"]) {
      const card = buildGoogleChatAlertCard({ summary: "x", detailsUrl: url }) as {
        card: { sections: { widgets: unknown[] }[] };
      };
      expect(card.card.sections[0].widgets, url).toHaveLength(1);
    }
  });

  it("omits an empty details block rather than leaving a gap", () => {
    const card = buildGoogleChatAlertCard({ summary: "x", details: "   " }) as {
      card: { sections: { widgets: unknown[] }[] };
    };
    expect(card.card.sections[0].widgets).toHaveLength(1);
  });

  it("includes a details block when there is one", () => {
    const card = buildGoogleChatAlertCard({ summary: "x", details: "Dana called" }) as {
      card: { sections: { widgets: { textParagraph?: { text: string } }[] }[] };
    };
    expect(card.card.sections[0].widgets[1].textParagraph?.text).toBe("Dana called");
  });
});
