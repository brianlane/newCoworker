/**
 * Tests for the thin Slack Web API client (src/lib/slack/client.ts).
 *
 * The contract worth pinning: Slack-side refusals (HTTP 200 + ok:false) come
 * back as typed results, while transport failures throw, so callers can tell
 * "Slack said no" from "Slack was unreachable".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  slackApiCall,
  SlackApiError,
  slackAppendStream,
  slackListChannels,
  slackPostMessage,
  slackSetAssistantStatus,
  slackStartStream,
  slackStopStream,
  slackUsersInfo
} from "@/lib/slack/client";
import { SLACK_REQUEST_TIMEOUT_MS } from "@/lib/slack/oauth";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("slackApiCall", () => {
  it("POSTs JSON with the bot token and returns the envelope", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, extra: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await slackApiCall("auth.test", "xoxb-1", { a: "b" });
    expect(body).toEqual({ ok: true, extra: 1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(String(init.body))).toEqual({ a: "b" });
  });

  it("throws bad_response on a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("nope");
      }
    }) as unknown as Response));
    await expect(slackApiCall("auth.test", "xoxb-1", {})).rejects.toMatchObject({
      name: "SlackApiError",
      code: "bad_response"
    });
  });

  it("maps aborts to upstream_timeout and network errors to upstream_unreachable", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(slackApiCall("auth.test", "xoxb-1", {})).rejects.toMatchObject({
      code: "upstream_timeout"
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    await expect(slackApiCall("auth.test", "xoxb-1", {})).rejects.toBeInstanceOf(SlackApiError);
  });

  it("aborts a hung call when the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              });
            })
        )
      );
      const pending = slackApiCall("auth.test", "xoxb-1", {});
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(SLACK_REQUEST_TIMEOUT_MS + 5);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("slackPostMessage", () => {
  it("returns ts + channel on success and forwards blocks and thread_ts", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, ts: "123.456", channel: "C-1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await slackPostMessage("xoxb-1", {
      channel: "C-1",
      text: "hello",
      blocks: [{ type: "section" }],
      thread_ts: "111.222"
    });
    expect(res).toEqual({ ok: true, ts: "123.456", channel: "C-1" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.blocks).toEqual([{ type: "section" }]);
    expect(sent.thread_ts).toBe("111.222");
  });

  it("omits blocks/thread_ts when absent and tolerates missing ts/channel", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await slackPostMessage("xoxb-1", { channel: "C-2", text: "hi" });
    expect(res).toEqual({ ok: true, ts: "", channel: "C-2" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect("blocks" in sent).toBe(false);
    expect("thread_ts" in sent).toBe(false);
  });

  it("surfaces Slack refusals as ok:false with the error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "not_in_channel" }))
    );
    expect(await slackPostMessage("xoxb-1", { channel: "C", text: "x" })).toEqual({
      ok: false,
      error: "not_in_channel"
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false })));
    expect(await slackPostMessage("xoxb-1", { channel: "C", text: "x" })).toEqual({
      ok: false,
      error: "unknown_error"
    });
  });
});

describe("slackListChannels", () => {
  it("keeps well-formed channels and drops junk entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          channels: [
            { id: "C-1", name: "general", is_private: false, is_member: true },
            { id: "C-2", name: "leads", is_private: true },
            { id: 42, name: "broken" },
            "junk"
          ]
        })
      )
    );
    expect(await slackListChannels("xoxb-1")).toEqual([
      { id: "C-1", name: "general", is_private: false, is_member: true },
      { id: "C-2", name: "leads", is_private: true, is_member: false }
    ]);
  });

  it("degrades to an empty list on refusal or a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "invalid_auth" }))
    );
    expect(await slackListChannels("xoxb-1")).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, channels: "??" })));
    expect(await slackListChannels("xoxb-1")).toEqual([]);
  });
});

describe("slackUsersInfo", () => {
  it("maps profile fields with real-name fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          user: { is_bot: false, profile: { display_name: "", real_name: "Dave L", email: "d@x.co" } }
        })
      )
    );
    expect(await slackUsersInfo("xoxb-1", "U-1")).toEqual({
      displayName: "Dave L",
      email: "d@x.co",
      isBot: false
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, user: { is_bot: true, profile: { display_name: "Bot" } } })
      )
    );
    expect(await slackUsersInfo("xoxb-1", "U-2")).toEqual({
      displayName: "Bot",
      email: null,
      isBot: true
    });
  });

  it("nulls out refusals and missing users", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "user_not_found" })));
    expect(await slackUsersInfo("xoxb-1", "U-x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    expect(await slackUsersInfo("xoxb-1", "U-x")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, user: { profile: {} } }))
    );
    expect(await slackUsersInfo("xoxb-1", "U-x")).toEqual({
      displayName: null,
      email: null,
      isBot: false
    });
  });
});

describe("assistant status + streaming trio", () => {
  it("setStatus is best-effort in both directions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    expect(
      await slackSetAssistantStatus("xoxb-1", { channel_id: "D-1", thread_ts: "1.1", status: "hm" })
    ).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(
      await slackSetAssistantStatus("xoxb-1", { channel_id: "D-1", thread_ts: "1.1", status: "hm" })
    ).toBe(false);
  });

  it("startStream returns a handle only on a real ts, and null on refusal/transport", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ts: "5.5", channel: "D-9" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await slackStartStream("xoxb-1", { channel: "D-1", thread_ts: "1.1" })).toEqual({
      channel: "D-9",
      ts: "5.5"
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ thread_ts: "1.1" });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, ts: "6.6" })));
    expect(await slackStartStream("xoxb-1", { channel: "D-1" })).toEqual({
      channel: "D-1",
      ts: "6.6"
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    expect(await slackStartStream("xoxb-1", { channel: "D-1" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "not_allowed" })));
    expect(await slackStartStream("xoxb-1", { channel: "D-1" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await slackStartStream("xoxb-1", { channel: "D-1" })).toBeNull();
  });

  it("append and stop return booleans and never throw", async () => {
    const handle = { channel: "D-1", ts: "5.5" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    expect(await slackAppendStream("xoxb-1", handle, "hi")).toBe(true);
    expect(await slackStopStream("xoxb-1", handle, "final")).toBe(true);
    expect(await slackStopStream("xoxb-1", handle)).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "x" })));
    expect(await slackAppendStream("xoxb-1", handle, "hi")).toBe(false);
    expect(await slackStopStream("xoxb-1", handle, "final")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await slackAppendStream("xoxb-1", handle, "hi")).toBe(false);
    expect(await slackStopStream("xoxb-1", handle, "final")).toBe(false);
  });
});
