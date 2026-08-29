import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teams alert delivery.
 *
 * The outcome worth its own name here is `no_alert_target`. Teams cannot
 * START a conversation, so a tenant who installed the app but has not
 * messaged it is connected with nowhere to deliver. That is a real,
 * owner-actionable state and it must not be reported as a failure, or the
 * dashboard would show a broken channel for a setup step nobody finished.
 */

vi.mock("@/lib/db/coworker-connections", () => ({ getCoworkerConnection: vi.fn() }));
vi.mock("@/lib/coworker-channels/tier-gate", () => ({
  coworkerChannelAllowedForBusiness: vi.fn()
}));
vi.mock("@/lib/teams/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams/client")>()),
  teamsSendActivity: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { deliverTeamsAlert, teamsAlertTargetState } from "@/lib/teams/deliver";
import { getCoworkerConnection } from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { teamsSendActivity } from "@/lib/teams/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONNECTED = {
  business_id: BIZ,
  is_active: true,
  credential: "",
  alert_target_id: "19:abc@thread.tacv2",
  alert_target_name: "https://smba.trafficmanager.net/amer/"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConnection).mockResolvedValue(CONNECTED as never);
  vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(teamsSendActivity).mockResolvedValue({ activityId: "act-1" });
});

describe("delivery outcomes", () => {
  it("sends a card AND plain text, and reports the conversation", async () => {
    // The text is what Teams shows in the notification toast and in clients
    // that will not render an Adaptive Card, so a card-only alert is one
    // some people never see.
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "New lead" })).toEqual({
      ok: true,
      conversationId: "19:abc@thread.tacv2",
      activityId: "act-1"
    });
    const [, activity] = vi.mocked(teamsSendActivity).mock.calls[0];
    expect(activity.text).toBe("New lead");
    expect(activity.attachments).toHaveLength(1);
  });

  it.each([
    ["never connected", null, "not_connected"],
    ["paused", { ...CONNECTED, is_active: false }, "needs_reconnect"],
    ["no conversation captured", { ...CONNECTED, alert_target_id: null }, "no_alert_target"],
    ["no service url captured", { ...CONNECTED, alert_target_name: null }, "no_alert_target"]
  ])("reports %s as %s", async (_label, row, reason) => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(row as never);
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason
    });
    expect(teamsSendActivity).not.toHaveBeenCalled();
  });

  it("does not require a credential, because Teams stores none", async () => {
    // Every other channel's "empty credential" means needs-reconnect. Here
    // it is the normal state, and treating it otherwise would make a
    // working channel look permanently broken.
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toMatchObject({ ok: true });
  });

  it("refuses on a downgraded plan without deleting anything", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "tier_blocked"
    });
  });

  it.each([
    ["an Error", new Error("db down")],
    ["a non-Error", "db down"]
  ])("delivers anyway when the tier check throws %s", async (_label, thrown) => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(thrown);
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toMatchObject({ ok: true });
  });

  it.each([
    ["an Error", new Error("forbidden"), "forbidden"],
    ["a non-Error", "forbidden", "forbidden"]
  ])("reports a send failure that was %s", async (_label, thrown, detail) => {
    vi.mocked(teamsSendActivity).mockRejectedValue(thrown);
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail
    });
  });

  it.each([
    ["an Error", new Error("db down")],
    ["a non-Error", "db down"]
  ])("reports a connection read failure that was %s as a send failure", async (_l, thrown) => {
    // "Never connected" records NO row, so a read blip must not be mistaken
    // for it: a broken channel would look like an unused one.
    vi.mocked(getCoworkerConnection).mockRejectedValue(thrown);
    expect(await deliverTeamsAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "connection_read_failed"
    });
  });
});

describe("the applicability probe", () => {
  it("reports a connected tenant with somewhere to deliver", async () => {
    expect(await teamsAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: true });
  });

  it("distinguishes connected-with-nowhere-to-send", async () => {
    vi.mocked(getCoworkerConnection).mockResolvedValue({
      ...CONNECTED,
      alert_target_name: null
    } as never);
    expect(await teamsAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: false });
  });

  it("reports a never-connected tenant", async () => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(null);
    expect(await teamsAlertTargetState(BIZ)).toEqual({ connected: false, hasTarget: false });
  });

  it.each([
    ["an Error", new Error("db down")],
    ["a non-Error", "db down"]
  ])("fails toward CONNECTED when the read throws %s", async (_label, thrown) => {
    vi.mocked(getCoworkerConnection).mockRejectedValue(thrown);
    expect(await teamsAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: true });
  });
});
