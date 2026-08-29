import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Google Chat event receiver.
 *
 * ONE URL for every tenant, because the event is SIGNED. Two things here are
 * unlike every other webhook in this repo and both are pinned below.
 *
 * A SPACE WITH NO CONNECTION IS NOT AN ERROR. A connect code is what binds a
 * space, so the first message from an unknown one is the beginning of setup
 * rather than something to refuse. Every other channel treats an unbound
 * workspace as "belongs to nobody, drop it".
 *
 * THE REPLY IS THE RESPONSE BODY. Chat posts whatever JSON comes back, which
 * is what lets a stranger be answered at all without our service-account
 * credential being involved.
 */

vi.mock("@/lib/db/coworker-connections", () => ({
  getCoworkerConnectionByWorkspaceForChannel: vi.fn()
}));
vi.mock("@/lib/google-chat/auth", () => ({ verifyGoogleChatToken: vi.fn() }));
vi.mock("@/lib/google-chat/inbound", () => ({ handleGoogleChatEvent: vi.fn() }));
vi.mock("@/lib/coworker-channels/kick", () => ({ kickCoworkerWorker: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => void) => fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/webhooks/google-chat/route";
import { getCoworkerConnectionByWorkspaceForChannel } from "@/lib/db/coworker-connections";
import { verifyGoogleChatToken } from "@/lib/google-chat/auth";
import { handleGoogleChatEvent } from "@/lib/google-chat/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SPACE = "spaces/AAQA1234";

function req(body: unknown) {
  return new Request("https://app/api/webhooks/google-chat", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const EVENT = { type: "MESSAGE", space: { name: SPACE } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyGoogleChatToken).mockResolvedValue({ ok: true, audience: "123456789012" });
  vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue({
    id: "conn-1",
    business_id: BIZ,
    channel: "google_chat",
    external_workspace_id: SPACE,
    is_active: true
  } as never);
  vi.mocked(handleGoogleChatEvent).mockResolvedValue({ enqueued: true });
});

describe("authentication", () => {
  it.each([
    ["a bad signature", "bad_signature"],
    ["the wrong audience", "unexpected_audience"],
    ["an unknown key", "unknown_key"],
    ["an expired token", "expired"],
    ["a missing header", "malformed_header"],
    ["our own audience being unset", "audience_unconfigured"]
  ])("answers 401 and NOTHING ELSE for %s", async (_label, reason) => {
    // Identical answers on purpose: telling an unauthenticated caller WHICH
    // check they failed is a free oracle.
    vi.mocked(verifyGoogleChatToken).mockResolvedValue({ ok: false, reason });
    const res = await POST(req(EVENT));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(handleGoogleChatEvent).not.toHaveBeenCalled();
  });

  it("answers 500 when OUR key fetch failed, so Google redelivers", async () => {
    // A 401 here would look like a rejected event and never come back.
    vi.mocked(verifyGoogleChatToken).mockResolvedValue({ ok: false, reason: "jwks_unavailable" });
    const res = await POST(req(EVENT));
    expect(res.status).toBe(500);
  });

  it("refuses an oversized body before verifying anything", async () => {
    const res = await POST(req({ padding: "x".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
    expect(verifyGoogleChatToken).not.toHaveBeenCalled();
  });
});

describe("routing an authentic event", () => {
  it("posts the handler's reply back as the response body", async () => {
    vi.mocked(handleGoogleChatEvent).mockResolvedValue({
      enqueued: false,
      reason: "not_linked",
      reply: "Ask someone to connect you."
    });
    const res = await POST(req(EVENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Ask someone to connect you." });
  });

  it("answers with an empty object when there is nothing to say", async () => {
    // Chat posts nothing for `{}`. Returning the handler's own result here
    // would leak internal reasons into the tenant's space.
    const res = await POST(req(EVENT));
    expect(await res.json()).toEqual({});
  });

  it("hands an UNBOUND space to the handler rather than dropping it", async () => {
    // The difference from every other channel. A connect code binds a
    // space, so the first message from an unknown one is the start of
    // setup, and refusing it would make connecting impossible.
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue(null);
    vi.mocked(handleGoogleChatEvent).mockResolvedValue({
      enqueued: false,
      reason: "unbound_space",
      reply: "Send a connect code."
    });
    const res = await POST(req(EVENT));
    expect(handleGoogleChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection: null })
    );
    expect(await res.json()).toEqual({ text: "Send a connect code." });
  });

  it("stays SILENT for a paused connection", async () => {
    // Not "you are not connected": that would invite the owner to spend a
    // code re-binding a space that is already bound to them.
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue({
      id: "conn-1",
      business_id: BIZ,
      is_active: false
    } as never);
    const res = await POST(req(EVENT));
    expect(await res.json()).toEqual({});
    expect(handleGoogleChatEvent).not.toHaveBeenCalled();
  });

  it("kicks the worker only when something was actually queued", async () => {
    await POST(req(EVENT));
    expect(kickCoworkerWorker).toHaveBeenCalledWith("google_chat");

    vi.clearAllMocks();
    vi.mocked(verifyGoogleChatToken).mockResolvedValue({ ok: true, audience: "1" });
    vi.mocked(handleGoogleChatEvent).mockResolvedValue({ enqueued: false, reason: "no_text" });
    await POST(req(EVENT));
    expect(kickCoworkerWorker).not.toHaveBeenCalled();
  });

  it("looks the space up under the google_chat channel", async () => {
    await POST(req(EVENT));
    expect(getCoworkerConnectionByWorkspaceForChannel).toHaveBeenCalledWith(
      "google_chat",
      SPACE
    );
  });

  it("reads the space off the message when the event has none at the top", async () => {
    await POST(req({ type: "MESSAGE", message: { space: { name: SPACE } } }));
    expect(getCoworkerConnectionByWorkspaceForChannel).toHaveBeenCalledWith(
      "google_chat",
      SPACE
    );
  });

  it("skips the lookup entirely for an event with no space", async () => {
    await POST(req({ type: "MESSAGE" }));
    expect(getCoworkerConnectionByWorkspaceForChannel).not.toHaveBeenCalled();
    expect(handleGoogleChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection: null })
    );
  });
});

describe("failures", () => {
  it("acks an unparseable body rather than making Google retry it forever", async () => {
    const res = await POST(req("{{{"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("answers 500 when the connection read fails, so the event comes back", async () => {
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockRejectedValue(new Error("down"));
    const res = await POST(req(EVENT));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "read_failed" });
  });

  it("answers 500 when the handler throws, so the event comes back", async () => {
    vi.mocked(handleGoogleChatEvent).mockRejectedValue(new Error("boom"));
    const res = await POST(req(EVENT));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "handler_failed" });
  });

  it("logs a non-Error throw without crashing", async () => {
    vi.mocked(handleGoogleChatEvent).mockRejectedValue("boom");
    expect((await POST(req(EVENT))).status).toBe(500);
  });
});
