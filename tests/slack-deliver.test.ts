/**
 * Tests for the central Slack alert delivery (src/lib/slack/deliver.ts).
 *
 * The contract worth pinning: structured outcomes (never throws), the tier
 * is re-checked at delivery time but fails toward delivering on a read
 * blip, and the never-connected/needs-reconnect/no-channel distinctions
 * that dispatch rows are built from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/slack-connections", () => ({
  getActiveSlackConnection: vi.fn(),
  getSlackConnection: vi.fn()
}));
vi.mock("@/lib/slack/tier-gate", () => ({ slackAllowedForBusiness: vi.fn() }));
vi.mock("@/lib/slack/client", () => ({ slackPostMessage: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  buildSlackAlertBlocks,
  deliverSlackAlert,
  slackAlertTargetState
} from "@/lib/slack/deliver";
import {
  getActiveSlackConnection,
  getSlackConnection
} from "@/lib/db/slack-connections";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import { slackPostMessage } from "@/lib/slack/client";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONNECTED = {
  id: "sc-1",
  business_id: BIZ,
  team_id: "T-1",
  team_name: "Acme",
  enterprise_id: null,
  bot_user_id: "U-BOT",
  app_id: "A-1",
  botToken: "xoxb-1",
  scopes: "chat:write",
  alert_channel_id: "C-1",
  alert_channel_name: "leads",
  is_active: true,
  installed_by_user_id: null,
  created_at: "",
  updated_at: ""
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSlackConnection).mockResolvedValue(CONNECTED as never);
  vi.mocked(slackAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(slackPostMessage).mockResolvedValue({ ok: true, ts: "1.2", channel: "C-1" });
});

describe("deliverSlackAlert", () => {
  it("posts to the picked channel and returns its identity", async () => {
    const res = await deliverSlackAlert({ businessId: BIZ, text: "hi", blocks: [{ a: 1 }] });
    expect(res).toEqual({ ok: true, channelId: "C-1", channelName: "leads", ts: "1.2" });
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ channel: "C-1", text: "hi", blocks: [{ a: 1 }] })
    );
  });

  it("omits blocks when none are given", async () => {
    await deliverSlackAlert({ businessId: BIZ, text: "hi" });
    const arg = vi.mocked(slackPostMessage).mock.calls[0][1] as Record<string, unknown>;
    expect("blocks" in arg).toBe(false);
  });

  it("distinguishes not-connected, needs-reconnect, and no-channel", async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(null);
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toEqual({
      ok: false,
      reason: "not_connected"
    });

    vi.mocked(getSlackConnection).mockResolvedValue({
      ...CONNECTED,
      is_active: false
    } as never);
    expect((await deliverSlackAlert({ businessId: BIZ, text: "x" })).ok).toBe(false);
    vi.mocked(getSlackConnection).mockResolvedValue({ ...CONNECTED, botToken: "" } as never);
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "needs_reconnect"
    });

    vi.mocked(getSlackConnection).mockResolvedValue({
      ...CONNECTED,
      alert_channel_id: null
    } as never);
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "no_alert_channel"
    });
  });

  it("re-checks the tier at delivery time, failing toward delivering on a blip", async () => {
    vi.mocked(slackAllowedForBusiness).mockResolvedValue(false);
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toEqual({
      ok: false,
      reason: "tier_blocked"
    });

    vi.mocked(slackAllowedForBusiness).mockRejectedValue(new Error("db blip"));
    expect((await deliverSlackAlert({ businessId: BIZ, text: "x" })).ok).toBe(true);
  });

  it("maps Slack refusals and thrown transport errors to send_failed", async () => {
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "channel_not_found" });
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "channel_not_found"
    });

    vi.mocked(slackPostMessage).mockRejectedValue(new Error("socket hang up"));
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "send_failed",
      detail: "socket hang up"
    });

    vi.mocked(getSlackConnection).mockRejectedValue(new Error("db down"));
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "send_failed",
      detail: "connection_read_failed"
    });
  });

  it("stringifies non-Error throws on every failure path", async () => {
    vi.mocked(getSlackConnection).mockRejectedValue("string blowup");
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "send_failed",
      detail: "connection_read_failed"
    });

    vi.mocked(getSlackConnection).mockResolvedValue(CONNECTED as never);
    vi.mocked(slackAllowedForBusiness).mockRejectedValue("tier string blowup");
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: true, ts: "1.2", channel: "C-1" });
    expect((await deliverSlackAlert({ businessId: BIZ, text: "x" })).ok).toBe(true);

    vi.mocked(slackAllowedForBusiness).mockResolvedValue(true);
    vi.mocked(slackPostMessage).mockRejectedValue("post string blowup");
    expect(await deliverSlackAlert({ businessId: BIZ, text: "x" })).toMatchObject({
      reason: "send_failed",
      detail: "post string blowup"
    });
  });
});

describe("buildSlackAlertBlocks", () => {
  it("renders the headline, summary and details link", () => {
    const blocks = buildSlackAlertBlocks({
      summary: "New lead: Chris",
      detailsUrl: "https://app/dashboard/x",
      detailsLabel: "View lead"
    }) as Array<Record<string, unknown>>;
    expect(JSON.stringify(blocks)).toContain("New lead: Chris");
    expect(JSON.stringify(blocks)).toContain("<https://app/dashboard/x|View lead>");
    expect(
      JSON.stringify(buildSlackAlertBlocks({ summary: "s", detailsUrl: "https://u" }))
    ).toContain("|Open dashboard>");
  });
});

describe("slackAlertTargetState", () => {
  it("reports a deliverable active connection", async () => {
    vi.mocked(getActiveSlackConnection).mockResolvedValue(CONNECTED as never);
    expect(await slackAlertTargetState(BIZ)).toEqual({
      connected: true,
      deliverable: true,
      alertChannelName: "leads"
    });
  });

  it("reports active-but-no-channel as connected, not deliverable", async () => {
    vi.mocked(getActiveSlackConnection).mockResolvedValue({
      ...CONNECTED,
      alert_channel_id: null,
      alert_channel_name: null
    } as never);
    expect(await slackAlertTargetState(BIZ)).toMatchObject({
      connected: true,
      deliverable: false
    });
  });

  it("falls back to the inactive row for the connected flag", async () => {
    vi.mocked(getActiveSlackConnection).mockResolvedValue(null);
    vi.mocked(getSlackConnection).mockResolvedValue({
      ...CONNECTED,
      is_active: false
    } as never);
    expect(await slackAlertTargetState(BIZ)).toMatchObject({ connected: true });

    vi.mocked(getSlackConnection).mockResolvedValue(null);
    expect(await slackAlertTargetState(BIZ)).toMatchObject({ connected: false });
  });

  it("fails toward connected on a read error, Error or not", async () => {
    vi.mocked(getActiveSlackConnection).mockRejectedValue(new Error("db down"));
    expect(await slackAlertTargetState(BIZ)).toEqual({
      connected: true,
      deliverable: false,
      alertChannelName: null
    });

    vi.mocked(getActiveSlackConnection).mockRejectedValue("string blowup");
    expect(await slackAlertTargetState(BIZ)).toMatchObject({ connected: true });
  });
});
