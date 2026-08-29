import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Chat alert delivery.
 *
 * The outcome worth its own name here is `not_configured`, and it is the
 * opposite kind of problem from every other reason on this path: OUR Google
 * service account is missing, not the tenant's connection. Reporting it as
 * "needs_reconnect" would send an owner round a loop that cannot possibly
 * help them, so it gets its own row and its own words.
 *
 * There is deliberately NO `no_alert_target` here. Teams needs one because
 * it cannot start a conversation; a Chat app that is a member of a space can
 * post into it whenever, and the space IS the connection, so connected and
 * deliverable are one state.
 */

vi.mock("@/lib/db/coworker-connections", () => ({ getCoworkerConnection: vi.fn() }));
vi.mock("@/lib/coworker-channels/tier-gate", () => ({
  coworkerChannelAllowedForBusiness: vi.fn()
}));
vi.mock("@/lib/google-chat/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-chat/client")>()),
  googleChatSendMessage: vi.fn(),
  googleChatConfigured: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { deliverGoogleChatAlert, googleChatConnectedState } from "@/lib/google-chat/deliver";
import { getCoworkerConnection } from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { googleChatConfigured, googleChatSendMessage } from "@/lib/google-chat/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SPACE = "spaces/AAQA1234";
const CONNECTED = {
  business_id: BIZ,
  is_active: true,
  credential: "",
  external_workspace_id: SPACE
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConnection).mockResolvedValue(CONNECTED as never);
  vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(googleChatConfigured).mockReturnValue(true);
  vi.mocked(googleChatSendMessage).mockResolvedValue({
    messageName: `${SPACE}/messages/m1`,
    thread: null
  });
});

describe("delivery outcomes", () => {
  it("sends a card AND plain text, and reports the space", async () => {
    // The text is what Chat shows in the notification and in clients that
    // will not render a card, so a card-only alert is one some people never
    // see.
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "New lead" })).toEqual({
      ok: true,
      space: SPACE,
      messageName: `${SPACE}/messages/m1`
    });
    const [target, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toBe("New lead");
    expect(message.cardsV2).toHaveLength(1);
    // Deliberately unthreaded: an alert is new information, not a reply to
    // whatever was last discussed, and burying it under an old thread is
    // how it goes unseen.
    expect(target.thread).toBeNull();
  });

  it.each([
    ["never connected", null, "not_connected"],
    ["paused", { ...CONNECTED, is_active: false }, "needs_reconnect"]
  ])("reports %s without sending", async (_label, connection, reason) => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(connection as never);
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason
    });
    expect(googleChatSendMessage).not.toHaveBeenCalled();
  });

  it("reports OUR missing service account distinctly from the tenant's state", async () => {
    vi.mocked(googleChatConfigured).mockReturnValue(false);
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "not_configured"
    });
    expect(googleChatSendMessage).not.toHaveBeenCalled();
  });

  it("refuses a tenant below the plan gate", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "tier_blocked"
    });
  });

  it("DELIVERS ANYWAY when the tier check itself errors", async () => {
    // Fails toward delivering. An alert must never be lost to a transient
    // tier lookup blip, which is the noisier and safer of the two mistakes.
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(new Error("down"));
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toMatchObject({
      ok: true
    });
  });

  it("delivers anyway when the tier check rejects with a non-Error", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue("down");
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toMatchObject({
      ok: true
    });
  });

  it.each([
    ["an Error", new Error("down")],
    ["something that is not an Error", "down"]
  ])("reports a connection read failure as a failure, not as silence (%s)", async (_l, thrown) => {
    vi.mocked(getCoworkerConnection).mockRejectedValue(thrown);
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "connection_read_failed"
    });
  });

  it.each([
    ["an Error", new Error("http_403"), "google chat: http_403"],
    ["something that is not an Error", "gone", "gone"]
  ])("carries the detail through when the send throws %s", async (_label, thrown, detail) => {
    vi.mocked(googleChatSendMessage).mockRejectedValue(
      thrown instanceof Error ? new Error(`google chat: ${thrown.message}`) : thrown
    );
    expect(await deliverGoogleChatAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail
    });
  });
});

describe("does this channel apply to this business", () => {
  it.each([
    ["connected", CONNECTED, true],
    ["never connected", null, false]
  ])("reports %s", async (_label, connection, expected) => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(connection as never);
    expect(await googleChatConnectedState(BIZ)).toBe(expected);
  });

  it("reports CONNECTED on a read error, which is the noisier mistake", async () => {
    // A skipped row that says why beats silence that looks like a tenant
    // who never connected. The never-connected rule writes NO row at all,
    // so failing the other way would hide a broken channel completely.
    vi.mocked(getCoworkerConnection).mockRejectedValue(new Error("down"));
    expect(await googleChatConnectedState(BIZ)).toBe(true);

    vi.mocked(getCoworkerConnection).mockRejectedValue("down");
    expect(await googleChatConnectedState(BIZ)).toBe(true);
  });
});
