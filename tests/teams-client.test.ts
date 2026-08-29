import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Bot Connector client.
 *
 * The property that matters most here is the SERVICE URL check. That value
 * arrives inside an activity, and it is where we later POST a bearer token
 * good for our whole Azure app, across every tenant. Sending it to an
 * attacker-chosen host would hand over the credential for the entire fleet,
 * so the host is verified rather than trusted, even though the activity
 * carrying it was itself token-verified.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  buildTeamsAlertCard,
  teamsFetchMember,
  teamsSendActivity,
  resetTeamsTokenStateForTests
} from "@/lib/teams/client";

/**
 * The URL check and the token fetch are module-private: exporting them only
 * so a test could call them is the "dead code wearing coverage" the knip
 * ratchet refuses. Both are driven through `teamsSendActivity`, which is
 * the only thing production calls, so these assertions are about what
 * actually reaches the network.
 */
const sendTo = (serviceUrl: string) =>
  teamsSendActivity({ ...REF, serviceUrl }, { text: "hi" });



const REF = {
  serviceUrl: "https://smba.trafficmanager.net/teams/",
  conversationId: "19:abc@thread.tacv2"
};

/**
 * Is this the Microsoft login endpoint?
 *
 * Parsed and compared by HOSTNAME rather than matched as a substring. A
 * substring test says yes to `https://evil.test/?x=login.microsoftonline.com`
 * as readily as to the real thing, which in a fetch stub means a test can
 * hand a token to a call it was meant to fail, and the assertion still
 * passes. The same reasoning as normalizeServiceUrl's own allowlist.
 */
function isLoginUrl(raw: unknown): boolean {
  try {
    return new URL(String(raw)).hostname === "login.microsoftonline.com";
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetTeamsTokenStateForTests();
  process.env.MICROSOFT_APP_ID = "app-id";
  process.env.MICROSOFT_APP_SECRET = "app-secret";
});

describe("the service url is checked, not trusted", () => {
  it.each([
    "https://smba.trafficmanager.net/teams/",
    "https://europe.botframework.com/",
    "https://api.botframework.com",
    "https://x.botframework.azure.us/"
  ])("accepts %s", async (url) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : new Response(JSON.stringify({ id: "act-1" }))
      )
    );
    await expect(sendTo(url)).resolves.toBeDefined();
  });

  it.each([
    ["an attacker's host", "https://evil.example.com/"],
    // trafficmanager.net is a SHARED Azure domain: anyone with a
    // subscription can get a name under it, so only the exact Teams host is
    // allowed and a sibling is not.
    ["a sibling on the shared Azure domain", "https://evil.trafficmanager.net/"],
    ["a lookalike suffix", "https://botframework.com.evil.example/"],
    ["plain http", "http://api.botframework.com/"],
    ["not a url at all", "not-a-url"],
    ["a javascript scheme", "javascript:alert(1)"]
  ])("refuses %s, before spending a token on it", async (_label, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendTo(url)).rejects.toThrow(/^teams: /);
    // Nothing goes out at all: not the send, and not the app-credential
    // exchange that would precede it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("appends to the base path rather than replacing its last segment", async () => {
    // `new URL("v3/...", base)` drops the final path segment unless the base
    // ends in a slash, which would post to the wrong path.
    const fetchMock = vi.fn(async (url: string) =>
      isLoginUrl(url)
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(JSON.stringify({ id: "act-1" }))
    );
    vi.stubGlobal("fetch", fetchMock);
    await sendTo("https://smba.trafficmanager.net/teams");
    expect(fetchMock.mock.calls[1][0]).toContain("/teams/v3/conversations/");
  });
});

describe("the app token", () => {
  /** Counts only the credential exchanges, not the sends. */
  const logins = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter((c) => isLoginUrl(c[0])).length;

  function stubOk() {
    const m = vi.fn(async (url: string) =>
      isLoginUrl(url)
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(JSON.stringify({ id: "act-1" }))
    );
    vi.stubGlobal("fetch", m);
    return m;
  }

  it("is cached across calls, because it is per-app rather than per-tenant", async () => {
    // A busy fleet would otherwise exchange credentials once per alert and
    // get itself throttled by Microsoft.
    const m = stubOk();
    await teamsSendActivity(REF, { text: "one" });
    await teamsSendActivity(REF, { text: "two" });
    expect(logins(m)).toBe(1);
  });

  it("re-exchanges once the cached token nears expiry", async () => {
    // Refreshed on the MARGIN rather than on a 401: a token that expires
    // mid-alert would otherwise cost that alert.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
      const m = stubOk();
      await teamsSendActivity(REF, { text: "one" });
      expect(logins(m)).toBe(1);

      // 56 minutes on: inside the five-minute refresh margin of a one-hour
      // token, so the next send exchanges again.
      vi.setSystemTime(new Date("2026-08-29T12:56:00Z"));
      await teamsSendActivity(REF, { text: "two" });
      expect(logins(m)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assumes an hour when Microsoft names no expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
      const m = vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok" }))
          : new Response(JSON.stringify({ id: "act-1" }))
      );
      vi.stubGlobal("fetch", m);
      await teamsSendActivity(REF, { text: "one" });
      // Half an hour on, still cached: that is what the default buys.
      vi.setSystemTime(new Date("2026-08-29T12:30:00Z"));
      await teamsSendActivity(REF, { text: "two" });
      expect(logins(m)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an unparseable token response as a failure, not as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/token http_502/);
  });

  it("refuses a 200 that carries no token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}))));
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/token http_200/);
  });

  it.each([
    ["the secret", () => delete process.env.MICROSOFT_APP_SECRET],
    ["the app id", () => delete process.env.MICROSOFT_APP_ID],
    [
      "both",
      () => {
        delete process.env.MICROSOFT_APP_ID;
        delete process.env.MICROSOFT_APP_SECRET;
      }
    ]
  ])("refuses when %s is not configured", async (_label, unset) => {
    unset();
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/^teams: /);
  });

  it("aborts a hung token fetch rather than holding the request open", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_r, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
      );
      const pending = teamsSendActivity(REF, { text: "hi" });
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces Microsoft's own rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error_description: "bad secret" }), { status: 401 })
      )
    );
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/bad secret/);
  });
});

describe("sending an activity", () => {
  function okToken() {
    return vi.fn(async (url: string) =>
      isLoginUrl(url)
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(JSON.stringify({ id: "activity-1" }))
    );
  }

  it("posts to the conversation's activities endpoint with a bearer token", async () => {
    const fetchMock = okToken();
    vi.stubGlobal("fetch", fetchMock);
    expect(await teamsSendActivity(REF, { text: "hi" })).toEqual({ activityId: "activity-1" });

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://smba.trafficmanager.net/teams/v3/conversations/19%3Aabc%40thread.tacv2/activities"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string).type).toBe("message");
  });

  it("reports a rejected send whose body cannot even be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : ({
              ok: false,
              status: 500,
              text: async () => {
                throw new Error("stream closed");
              }
            } as never)
      )
    );
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/send http_500/);
  });

  it("tolerates a success whose body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : new Response("not json")
      )
    );
    expect(await teamsSendActivity(REF, { text: "hi" })).toEqual({ activityId: "" });
  });

  it("reports a rejected send rather than swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : new Response("forbidden", { status: 403 })
      )
    );
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/send http_403/);
  });

  it("stringifies a network failure that was not an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isLoginUrl(url)) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
        }
        throw "socket exploded";
      })
    );
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/socket exploded/);
  });

  it("wraps a network failure as a TeamsApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isLoginUrl(url)) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
        }
        throw new Error("socket hang up");
      })
    );
    await expect(teamsSendActivity(REF, { text: "hi" })).rejects.toThrow(/^teams: /);
  });

  it("aborts a hung send rather than holding a worker slot forever", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (url: string, init: RequestInit) =>
            isLoginUrl(url)
              ? Promise.resolve(
                  new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
                )
              : new Promise((_r, reject) => {
                  init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                })
        )
      );
      const pending = teamsSendActivity(REF, { text: "hi" });
      const assertion = expect(pending).rejects.toThrow(/^teams: /);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a caller-supplied token instead of fetching one", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "act-1" })));
    vi.stubGlobal("fetch", fetchMock);
    await teamsSendActivity(REF, { text: "hi" }, { token: "given" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer given");
  });

  it("tolerates a send that reports no activity id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        isLoginUrl(url)
          ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
          : new Response(JSON.stringify({}))
      )
    );
    expect(await teamsSendActivity(REF, { text: "hi" })).toEqual({ activityId: "" });
  });
});

describe("the alert card", () => {
  it("carries the summary as DATA, so nothing has to be escaped", () => {
    // An Adaptive Card's fields are values rather than markup, which is why
    // a customer name full of angle brackets and underscores is displayed
    // rather than parsed. That is the class of bug Telegram's HTML escaping
    // solves; here it is avoided by not building markup at all.
    const card = buildTeamsAlertCard({ summary: "Lead <Dana & Co> _now_" }) as {
      content: { body: { text: string }[] };
    };
    expect(card.content.body[1].text).toBe("Lead <Dana & Co> _now_");
  });

  it("adds an open action only for an http(s) link", () => {
    const withLink = buildTeamsAlertCard({ summary: "x", detailsUrl: "https://app/x" }) as {
      content: { actions?: unknown[] };
    };
    expect(withLink.content.actions).toHaveLength(1);

    for (const url of ["javascript:alert(1)", "data:text/html,x", "", "ftp://x"]) {
      const card = buildTeamsAlertCard({ summary: "x", detailsUrl: url }) as {
        content: { actions?: unknown[] };
      };
      expect(card.content.actions, url).toBeUndefined();
    }
  });

  it("omits an empty details block rather than leaving a gap", () => {
    const card = buildTeamsAlertCard({ summary: "x", details: "   " }) as {
      content: { body: unknown[] };
    };
    expect(card.content.body).toHaveLength(2);
  });

  it("includes a details block when there is one", () => {
    const card = buildTeamsAlertCard({ summary: "x", details: "Dana called" }) as {
      content: { body: { text: string }[] };
    };
    expect(card.content.body[2].text).toBe("Dana called");
  });
});

describe("looking a member up in the directory", () => {
  /**
   * This is where a Teams identity comes from, and the reason it exists at
   * all is that the obvious alternative is wrong: an inbound activity does
   * NOT carry the sender's address. `from` is a ChannelAccount and
   * `entities` is clientInfo and mentions.
   *
   * It returns null on every failure rather than throwing, because from the
   * caller's side a tenant that hides addresses and a Microsoft outage are
   * the same condition: fall back to a link code, do not answer 500 at a
   * webhook that already stored the message.
   */
  const stubMember = (body: unknown, status = 200) => {
    const m = vi.fn(async (url: string, _init?: RequestInit) =>
      isLoginUrl(url)
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
    );
    vi.stubGlobal("fetch", m);
    return m;
  };

  it("asks the members endpoint, with the ids escaped into the path", async () => {
    const m = stubMember({ objectId: "obj-1", email: "Dana@Acme.com", name: "Dana Ruiz" });
    expect(await teamsFetchMember(REF, "29:xyz")).toEqual({
      aadObjectId: "obj-1",
      // Case-folded, because it is matched against roster rows.
      email: "dana@acme.com",
      name: "Dana Ruiz"
    });
    const [url, init] = m.mock.calls.find(([u]) => !isLoginUrl(u))!;
    // Both ids are encoded: a conversation id contains `:` and `@`, and an
    // unescaped one would reshape the path we send our own bearer token to.
    expect(url).toBe(
      "https://smba.trafficmanager.net/teams/v3/conversations/19%3Aabc%40thread.tacv2/members/29%3Axyz"
    );
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("falls back to the userPrincipalName when there is no mail attribute", async () => {
    stubMember({ userPrincipalName: "dana@acme.com" });
    expect(await teamsFetchMember(REF, "29:xyz")).toMatchObject({ email: "dana@acme.com" });
  });

  it.each([
    ["the directory exposes no address", { objectId: "obj-1", name: "Dana" }],
    ["the address is not one at all", { email: "dana" }],
    ["the address is blank", { email: "   " }]
  ])("reports a null address when %s", async (_label, body) => {
    stubMember(body);
    expect(await teamsFetchMember(REF, "29:xyz")).toMatchObject({ email: null });
  });

  it.each([
    ["the member is not found", "{}", 404],
    ["the app is not permitted to read it", "{}", 403],
    ["the response is not JSON", "not json", 200],
    ["the response is a bare null", "null", 200]
  ])("returns null rather than throwing when %s", async (_label, body, status) => {
    stubMember(body, status);
    expect(await teamsFetchMember(REF, "29:xyz")).toBeNull();
  });

  it("returns null when the network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );
    expect(await teamsFetchMember(REF, "29:xyz")).toBeNull();
  });

  it("throws nothing that is not an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "gone";
      })
    );
    expect(await teamsFetchMember(REF, "29:xyz")).toBeNull();
  });

  it("REFUSES a non-Microsoft service url without sending anything", async () => {
    // The same credential-disclosure argument as the send path, and it has
    // to be made again here: this request carries the identical bearer
    // token, so a lookup that skipped the allowlist would leak it just as
    // completely as a send that did.
    const m = stubMember({ email: "dana@acme.com" });
    expect(
      await teamsFetchMember({ ...REF, serviceUrl: "https://evil.test/" }, "29:xyz")
    ).toBeNull();
    expect(m).not.toHaveBeenCalled();
  });

  it("aborts a hung lookup rather than holding the webhook open", async () => {
    // The timeout matters more here than on the send path: this call sits
    // INSIDE the webhook's ack window, so a directory that never answers
    // would make Bot Framework time us out and redeliver the message.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) =>
          isLoginUrl(url)
            ? Promise.resolve(
                new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
              )
            : new Promise((_r, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              })
        )
      );
      const pending = teamsFetchMember(REF, "29:xyz");
      const assertion = expect(pending).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a caller-supplied token instead of minting one", async () => {
    const m = stubMember({ email: "dana@acme.com" });
    await teamsFetchMember(REF, "29:xyz", { token: "given" });
    expect(m.mock.calls.some(([u]) => isLoginUrl(u))).toBe(false);
  });
});
